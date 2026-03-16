import http from 'node:http';
import crypto from 'node:crypto';
import Docker from 'dockerode';

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

const CONFIG = {
  poolSize: parseInt(process.env.POOL_SIZE || '3', 10),
  sidecarImage: process.env.SIDECAR_IMAGE || 'sidecar:slim',
  domainSuffix: process.env.DOMAIN_SUFFIX || 'bolt.rdrt.org',
  port: parseInt(process.env.PORT || '9850', 10),
  sidecarPortRangeStart: parseInt(process.env.SIDECAR_PORT_RANGE_START || '10000', 10),
  sidecarPortRangeEnd: parseInt(process.env.SIDECAR_PORT_RANGE_END || '19999', 10),
};

// ---------------------------------------------------------------------------
// Logging
// ---------------------------------------------------------------------------

function log(level, msg, meta = {}) {
  const entry = {
    ts: new Date().toISOString(),
    level,
    msg,
    ...meta,
  };
  process.stdout.write(JSON.stringify(entry) + '\n');
}

// ---------------------------------------------------------------------------
// Docker client
// ---------------------------------------------------------------------------

const docker = new Docker({ socketPath: '/var/run/docker.sock' });

// ---------------------------------------------------------------------------
// Pool state
// ---------------------------------------------------------------------------

/**
 * Each entry:
 * {
 *   id: string,           // short id e.g. "bolt-pool-a1b2c3d4"
 *   containerId: string,  // full Docker container ID
 *   domain: string,       // e.g. "bolt-pool-a1b2c3d4.bolt.rdrt.org"
 *   sidecarUrl: string,   // e.g. "http://host:12345"
 *   sidecarPort: number,  // mapped host port for sidecar
 *   token: string,        // SIDECAR_TOKEN
 *   status: 'warm' | 'active',
 *   createdAt: string,    // ISO timestamp
 * }
 */
const pool = new Map();

/** Set of host ports currently allocated (to avoid collisions). */
const allocatedPorts = new Set();

// ---------------------------------------------------------------------------
// Port allocation
// ---------------------------------------------------------------------------

function allocatePort() {
  const rangeSize = CONFIG.sidecarPortRangeEnd - CONFIG.sidecarPortRangeStart + 1;

  // Safety: prevent infinite loop if all ports are allocated
  if (allocatedPorts.size >= rangeSize) {
    throw new Error('No available ports in the configured range');
  }

  let port;
  do {
    port =
      CONFIG.sidecarPortRangeStart +
      Math.floor(Math.random() * rangeSize);
  } while (allocatedPorts.has(port));

  allocatedPorts.add(port);
  return port;
}

function releasePort(port) {
  allocatedPorts.delete(port);
}

// ---------------------------------------------------------------------------
// Container lifecycle
// ---------------------------------------------------------------------------

async function createContainer() {
  const shortId = `bolt-pool-${crypto.randomUUID().slice(0, 8)}`;
  const token = crypto.randomBytes(32).toString('hex');
  const sidecarPort = allocatePort();
  const domain = `${shortId}.${CONFIG.domainSuffix}`;

  const labels = {
    'traefik.enable': 'true',
    // App router (port 3000) — serves the dev server preview
    [`traefik.http.routers.${shortId}.rule`]: `Host(\`${domain}\`) && !PathPrefix(\`/_sidecar\`)`,
    [`traefik.http.routers.${shortId}.tls`]: 'true',
    [`traefik.http.routers.${shortId}.tls.certresolver`]: 'letsencrypt',
    [`traefik.http.routers.${shortId}.service`]: `${shortId}`,
    [`traefik.http.services.${shortId}.loadbalancer.server.port`]: '3000',
    // Sidecar router (port 9839) — exposes sidecar HTTP API + terminal WebSocket at /_sidecar/
    [`traefik.http.routers.${shortId}-sidecar.rule`]: `Host(\`${domain}\`) && PathPrefix(\`/_sidecar\`)`,
    [`traefik.http.routers.${shortId}-sidecar.tls`]: 'true',
    [`traefik.http.routers.${shortId}-sidecar.tls.certresolver`]: 'letsencrypt',
    [`traefik.http.routers.${shortId}-sidecar.service`]: `${shortId}-sidecar`,
    [`traefik.http.services.${shortId}-sidecar.loadbalancer.server.port`]: '9839',
    [`traefik.http.middlewares.${shortId}-sidecar-strip.stripprefix.prefixes`]: '/_sidecar',
    [`traefik.http.routers.${shortId}-sidecar.middlewares`]: `${shortId}-sidecar-strip`,
    // Management labels
    'bolt.pool.managed': 'true',
    'bolt.pool.id': shortId,
  };

  log('info', 'Creating container', { shortId, sidecarPort, domain });

  try {
    const container = await docker.createContainer({
      Image: CONFIG.sidecarImage,
      name: shortId,
      Env: [`SIDECAR_TOKEN=${token}`],
      Labels: labels,
      ExposedPorts: {
        '3000/tcp': {},
        '9839/tcp': {},
      },
      HostConfig: {
        NetworkMode: 'coolify',
        PortBindings: {
          '3000/tcp': [{ HostPort: '0' }], // let Docker pick a port for app
          '9839/tcp': [{ HostPort: String(sidecarPort) }],
        },
        RestartPolicy: { Name: 'unless-stopped' },
      },
    });

    await container.start();

    const entry = {
      id: shortId,
      containerId: container.id,
      domain,
      sidecarUrl: `http://127.0.0.1:${sidecarPort}`,
      sidecarPort,
      token,
      status: 'warm',
      createdAt: new Date().toISOString(),
    };

    pool.set(shortId, entry);
    log('info', 'Container started', { shortId, containerId: container.id });

    return entry;
  } catch (err) {
    // Clean up the allocated port on failure
    releasePort(sidecarPort);
    log('error', 'Failed to create container', { shortId, error: err.message });
    throw err;
  }
}

async function destroyContainer(shortId) {
  const entry = pool.get(shortId);

  if (!entry) {
    log('warn', 'destroyContainer called for unknown id', { shortId });
    return;
  }

  log('info', 'Destroying container', { shortId, containerId: entry.containerId });

  try {
    const container = docker.getContainer(entry.containerId);

    try {
      await container.stop({ t: 5 });
    } catch (stopErr) {
      // Container might already be stopped — that's fine
      if (stopErr.statusCode !== 304 && stopErr.statusCode !== 404) {
        log('warn', 'Error stopping container (will still try remove)', {
          shortId,
          error: stopErr.message,
        });
      }
    }

    try {
      await container.remove({ force: true });
    } catch (rmErr) {
      if (rmErr.statusCode !== 404) {
        log('error', 'Failed to remove container', { shortId, error: rmErr.message });
      }
    }
  } catch (err) {
    log('error', 'Unexpected error destroying container', { shortId, error: err.message });
  } finally {
    releasePort(entry.sidecarPort);
    pool.delete(shortId);
  }
}

// ---------------------------------------------------------------------------
// Pool management
// ---------------------------------------------------------------------------

function warmCount() {
  let n = 0;
  for (const entry of pool.values()) {
    if (entry.status === 'warm') n++;
  }
  return n;
}

function activeCount() {
  let n = 0;
  for (const entry of pool.values()) {
    if (entry.status === 'active') n++;
  }
  return n;
}

/**
 * Fill the pool up to POOL_SIZE warm containers.
 * Returns when all containers have been created (or errors logged).
 */
async function fillPool() {
  const needed = CONFIG.poolSize - warmCount();
  if (needed <= 0) return;

  log('info', 'Filling pool', { needed, currentWarm: warmCount(), poolSize: CONFIG.poolSize });

  const promises = [];
  for (let i = 0; i < needed; i++) {
    promises.push(
      createContainer().catch((err) => {
        log('error', 'Failed to fill pool slot', { error: err.message });
      }),
    );
  }

  await Promise.allSettled(promises);
  log('info', 'Pool fill complete', { warm: warmCount(), active: activeCount() });
}

/**
 * Start a single replacement container in the background (non-blocking).
 */
function startReplacement() {
  createContainer().catch((err) => {
    log('error', 'Background replacement failed', { error: err.message });
  });
}

// ---------------------------------------------------------------------------
// HTTP helpers
// ---------------------------------------------------------------------------

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => {
      try {
        const raw = Buffer.concat(chunks).toString();
        resolve(raw.length > 0 ? JSON.parse(raw) : {});
      } catch (err) {
        reject(new Error('Invalid JSON body'));
      }
    });
    req.on('error', reject);
  });
}

function sendJson(res, statusCode, data) {
  const body = JSON.stringify(data);
  res.writeHead(statusCode, {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(body),
  });
  res.end(body);
}

// ---------------------------------------------------------------------------
// Route handlers
// ---------------------------------------------------------------------------

async function handleClaim(_req, res) {
  // Find the first warm container
  let claimed = null;
  for (const entry of pool.values()) {
    if (entry.status === 'warm') {
      claimed = entry;
      break;
    }
  }

  if (!claimed) {
    sendJson(res, 503, { error: 'No warm containers available' });
    return;
  }

  // Mark as active
  claimed.status = 'active';
  log('info', 'Container claimed', { id: claimed.id });

  // Start a replacement in the background
  startReplacement();

  sendJson(res, 200, {
    containerId: claimed.id,
    domain: claimed.domain,
    sidecarUrl: claimed.sidecarUrl,
    token: claimed.token,
  });
}

async function handleRelease(req, res) {
  let body;
  try {
    body = await readBody(req);
  } catch (err) {
    sendJson(res, 400, { error: err.message });
    return;
  }

  const { containerId } = body;

  if (!containerId) {
    sendJson(res, 400, { error: 'Missing containerId in request body' });
    return;
  }

  const entry = pool.get(containerId);

  if (!entry) {
    sendJson(res, 404, { error: 'Container not found', containerId });
    return;
  }

  log('info', 'Releasing container', { id: containerId });

  // Destroy in background so the response is fast
  destroyContainer(containerId)
    .then(() => startReplacement())
    .catch((err) => {
      log('error', 'Error during release cleanup', { containerId, error: err.message });
    });

  sendJson(res, 200, { ok: true, containerId });
}

function handleStatus(_req, res) {
  const containers = [];
  for (const entry of pool.values()) {
    containers.push({
      id: entry.id,
      containerId: entry.containerId,
      domain: entry.domain,
      sidecarUrl: entry.sidecarUrl,
      status: entry.status,
      createdAt: entry.createdAt,
    });
  }

  sendJson(res, 200, {
    poolSize: CONFIG.poolSize,
    warm: warmCount(),
    active: activeCount(),
    containers,
  });
}

function handleHealth(_req, res) {
  sendJson(res, 200, {
    status: 'ok',
    uptime: process.uptime(),
    warm: warmCount(),
    active: activeCount(),
  });
}

// ---------------------------------------------------------------------------
// Request router
// ---------------------------------------------------------------------------

async function onRequest(req, res) {
  const { method, url } = req;
  const path = url.split('?')[0]; // strip query string

  log('debug', 'Request', { method, path });

  try {
    if (method === 'POST' && path === '/claim') {
      await handleClaim(req, res);
    } else if (method === 'POST' && path === '/release') {
      await handleRelease(req, res);
    } else if (method === 'GET' && path === '/status') {
      handleStatus(req, res);
    } else if (method === 'GET' && path === '/health') {
      handleHealth(req, res);
    } else {
      sendJson(res, 404, { error: 'Not found' });
    }
  } catch (err) {
    log('error', 'Unhandled request error', { method, path, error: err.message });
    sendJson(res, 500, { error: 'Internal server error' });
  }
}

// ---------------------------------------------------------------------------
// Graceful shutdown
// ---------------------------------------------------------------------------

let shuttingDown = false;

async function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;

  log('info', 'Shutdown initiated', { signal });

  // Stop accepting new connections
  server.close(() => {
    log('info', 'HTTP server closed');
  });

  // Destroy all managed containers
  const ids = [...pool.keys()];
  log('info', 'Destroying all managed containers', { count: ids.length });

  await Promise.allSettled(ids.map((id) => destroyContainer(id)));

  log('info', 'All containers destroyed, exiting');
  process.exit(0);
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

// Handle unhandled rejections/exceptions so the service doesn't crash silently
process.on('unhandledRejection', (err) => {
  log('error', 'Unhandled rejection', { error: String(err) });
});

process.on('uncaughtException', (err) => {
  log('error', 'Uncaught exception', { error: err.message, stack: err.stack });
  // Give a moment for the log to flush, then exit
  setTimeout(() => process.exit(1), 500);
});

// ---------------------------------------------------------------------------
// Orphan cleanup — remove stale containers from previous pool manager runs
// ---------------------------------------------------------------------------

async function cleanupOrphans() {
  log('info', 'Cleaning up orphaned containers...');

  try {
    const containers = await docker.listContainers({
      all: true,
      filters: { label: ['bolt.pool.managed=true'] },
    });

    const knownIds = new Set(pool.keys());
    let cleaned = 0;

    for (const containerInfo of containers) {
      const shortId = containerInfo.Labels?.['bolt.pool.id'];

      // If this container is not in our in-memory pool, it's an orphan
      if (!shortId || !knownIds.has(shortId)) {
        const name = containerInfo.Names?.[0]?.replace(/^\//, '') || containerInfo.Id.slice(0, 12);
        log('info', 'Removing orphaned container', { name, id: containerInfo.Id.slice(0, 12) });

        try {
          const container = docker.getContainer(containerInfo.Id);

          if (containerInfo.State === 'running') {
            await container.stop({ t: 5 }).catch(() => {});
          }

          await container.remove({ force: true });
          cleaned++;
        } catch (err) {
          log('warn', 'Failed to remove orphan', { name, error: err.message });
        }
      }
    }

    log('info', 'Orphan cleanup complete', { found: containers.length, cleaned });
  } catch (err) {
    log('error', 'Orphan cleanup failed', { error: err.message });
  }
}

// ---------------------------------------------------------------------------
// Startup
// ---------------------------------------------------------------------------

const server = http.createServer(onRequest);

server.listen(CONFIG.port, async () => {
  log('info', 'Pool manager started', {
    port: CONFIG.port,
    poolSize: CONFIG.poolSize,
    sidecarImage: CONFIG.sidecarImage,
    domainSuffix: CONFIG.domainSuffix,
    sidecarPortRange: `${CONFIG.sidecarPortRangeStart}-${CONFIG.sidecarPortRangeEnd}`,
  });

  // Verify Docker connectivity
  try {
    const info = await docker.info();
    log('info', 'Docker connected', {
      serverVersion: info.ServerVersion,
      containers: info.Containers,
    });
  } catch (err) {
    log('error', 'Cannot connect to Docker daemon', { error: err.message });
    log('error', 'Ensure /var/run/docker.sock is mounted and accessible');
    process.exit(1);
  }

  // Clean up orphaned containers from previous runs before filling the pool
  await cleanupOrphans();

  // Fill the pool
  await fillPool();
});
