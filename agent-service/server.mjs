import http from 'node:http';
import { config } from 'dotenv';

// Load .env
config({ path: '.env' });
config({ path: '../bolt.diy/.env.local' });

import {
  createSession,
  getSession,
  updateSession,
  listSessions,
  deleteSession,
  saveMessage,
  getFullSessionState,
  runMigrations,
  close as closeDb,
} from './db.mjs';
import { runAgentLoop, addSSEClient, removeSSEClient, isLoopRunning, abortLoop } from './loop.mjs';

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

const PORT = parseInt(process.env.AGENT_SERVICE_PORT || '9860', 10);
const POOL_MANAGER_URL = process.env.POOL_MANAGER_URL || 'http://localhost:9850';

// ---------------------------------------------------------------------------
// Logging
// ---------------------------------------------------------------------------

function log(level, msg, meta = {}) {
  const entry = { ts: new Date().toISOString(), level, msg, ...meta };
  process.stdout.write(JSON.stringify(entry) + '\n');
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
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
  });
  res.end(body);
}

function sendError(res, statusCode, message) {
  sendJson(res, statusCode, { error: message });
}

// ---------------------------------------------------------------------------
// Pool manager integration
// ---------------------------------------------------------------------------

async function claimContainer() {
  try {
    const resp = await fetch(`${POOL_MANAGER_URL}/claim`, { method: 'POST' });

    if (!resp.ok) {
      const body = await resp.json().catch(() => ({}));
      throw new Error(body.error || `Pool manager returned ${resp.status}`);
    }

    return resp.json();
  } catch (err) {
    log('warn', 'Failed to claim container from pool', { error: err.message });
    return null;
  }
}

async function releaseContainer(containerId) {
  try {
    await fetch(`${POOL_MANAGER_URL}/release`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ containerId }),
    });
  } catch (err) {
    log('warn', 'Failed to release container', { containerId, error: err.message });
  }
}

// ---------------------------------------------------------------------------
// Route: POST /sessions
// ---------------------------------------------------------------------------

async function handleCreateSession(req, res) {
  const body = await readBody(req);

  // Claim a container from the pool
  const container = await claimContainer();

  const session = await createSession({
    id: body.id || undefined,
    title: body.title || null,
    provider: body.provider || 'Anthropic',
    model: body.model || 'claude-sonnet-4-20250514',
    maxIterations: body.maxIterations || 25,
    containerInfo: container
      ? {
          containerId: container.containerId,
          domain: container.domain,
          // Pool manager returns 127.0.0.1 URLs which work from the host,
          // but this service runs in a Docker container — rewrite to host.docker.internal
          sidecarUrl: container.sidecarUrl.replace('127.0.0.1', 'host.docker.internal'),
          token: container.token,
        }
      : undefined,
  });

  sendJson(res, 201, session);
}

// ---------------------------------------------------------------------------
// Route: POST /sessions/:id/message
// ---------------------------------------------------------------------------

async function handleSendMessage(req, res, sessionId) {
  const body = await readBody(req);

  if (!body.content?.trim()) {
    return sendError(res, 400, 'Message content is required');
  }

  const session = await getSession(sessionId);

  if (!session) {
    return sendError(res, 404, 'Session not found');
  }

  // Update provider/model if provided
  if (body.provider || body.model) {
    await updateSession(sessionId, {
      provider: body.provider || session.provider,
      model: body.model || session.model,
    });
  }

  // Save user message
  await saveMessage(sessionId, {
    role: 'user',
    content: body.content,
  });

  sendJson(res, 200, { ok: true, sessionId });

  // Start agent loop in the background (don't await)
  runAgentLoop(sessionId).catch((err) => {
    log('error', 'Agent loop crashed', { sessionId, error: err.message });
  });
}

// ---------------------------------------------------------------------------
// Route: GET /sessions/:id/stream (SSE)
// ---------------------------------------------------------------------------

function handleStream(req, res, sessionId) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
    'Access-Control-Allow-Origin': '*',
  });

  const emit = (event) => {
    try {
      res.write(`data: ${JSON.stringify(event)}\n\n`);
    } catch {
      // connection closed
    }
  };

  // Send initial heartbeat
  emit({ type: 'connected', sessionId });

  addSSEClient(sessionId, emit);

  // Heartbeat to keep connection alive
  const heartbeat = setInterval(() => {
    try {
      res.write(': heartbeat\n\n');
    } catch {
      clearInterval(heartbeat);
    }
  }, 15000);

  req.on('close', () => {
    clearInterval(heartbeat);
    removeSSEClient(sessionId, emit);
  });
}

// ---------------------------------------------------------------------------
// Route: GET /sessions/:id
// ---------------------------------------------------------------------------

async function handleGetSession(req, res, sessionId) {
  const state = await getFullSessionState(sessionId);

  if (!state) {
    return sendError(res, 404, 'Session not found');
  }

  sendJson(res, 200, state);
}

// ---------------------------------------------------------------------------
// Route: POST /sessions/:id/stop
// ---------------------------------------------------------------------------

async function handleStopSession(req, res, sessionId) {
  if (isLoopRunning(sessionId)) {
    abortLoop(sessionId);
    await updateSession(sessionId, { status: 'paused' });
    sendJson(res, 200, { ok: true, status: 'paused' });
  } else {
    sendJson(res, 200, { ok: true, status: 'not_running' });
  }
}

// ---------------------------------------------------------------------------
// Route: GET /sessions
// ---------------------------------------------------------------------------

async function handleListSessions(req, res) {
  const sessions = await listSessions();
  sendJson(res, 200, { sessions });
}

// ---------------------------------------------------------------------------
// Route: DELETE /sessions/:id
// ---------------------------------------------------------------------------

async function handleDeleteSession(req, res, sessionId) {
  const session = await getSession(sessionId);

  if (!session) {
    return sendError(res, 404, 'Session not found');
  }

  // Abort any running loop
  if (isLoopRunning(sessionId)) {
    abortLoop(sessionId);
  }

  // Release container
  if (session.container_id) {
    await releaseContainer(session.container_id);
  }

  await deleteSession(sessionId);
  sendJson(res, 200, { ok: true });
}

// ---------------------------------------------------------------------------
// Request router
// ---------------------------------------------------------------------------

function parseRoute(method, path) {
  // POST /sessions
  if (method === 'POST' && path === '/sessions') {
    return { handler: 'createSession' };
  }

  // GET /sessions
  if (method === 'GET' && path === '/sessions') {
    return { handler: 'listSessions' };
  }

  // Match /sessions/:id patterns
  const sessionMatch = path.match(/^\/sessions\/([^/]+)(?:\/(.+))?$/);

  if (sessionMatch) {
    const sessionId = sessionMatch[1];
    const sub = sessionMatch[2];

    if (method === 'GET' && !sub) {
      return { handler: 'getSession', sessionId };
    }

    if (method === 'DELETE' && !sub) {
      return { handler: 'deleteSession', sessionId };
    }

    if (method === 'POST' && sub === 'message') {
      return { handler: 'sendMessage', sessionId };
    }

    if (method === 'GET' && sub === 'stream') {
      return { handler: 'stream', sessionId };
    }

    if (method === 'POST' && sub === 'stop') {
      return { handler: 'stopSession', sessionId };
    }
  }

  // Health
  if (method === 'GET' && path === '/health') {
    return { handler: 'health' };
  }

  return null;
}

async function onRequest(req, res) {
  const { method, url } = req;
  const path = url.split('?')[0];

  // CORS preflight
  if (method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
    });
    res.end();
    return;
  }

  log('debug', 'Request', { method, path });

  const route = parseRoute(method, path);

  if (!route) {
    return sendError(res, 404, 'Not found');
  }

  try {
    switch (route.handler) {
      case 'createSession':
        return await handleCreateSession(req, res);
      case 'listSessions':
        return await handleListSessions(req, res);
      case 'getSession':
        return await handleGetSession(req, res, route.sessionId);
      case 'deleteSession':
        return await handleDeleteSession(req, res, route.sessionId);
      case 'sendMessage':
        return await handleSendMessage(req, res, route.sessionId);
      case 'stream':
        return handleStream(req, res, route.sessionId);
      case 'stopSession':
        return await handleStopSession(req, res, route.sessionId);
      case 'health':
        return sendJson(res, 200, { status: 'ok', uptime: process.uptime() });
    }
  } catch (err) {
    log('error', 'Request handler error', { method, path, error: err.message });
    sendError(res, 500, 'Internal server error');
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

  server.close(() => {
    log('info', 'HTTP server closed');
  });

  await closeDb();
  log('info', 'Database connections closed');
  process.exit(0);
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

process.on('unhandledRejection', (err) => {
  log('error', 'Unhandled rejection', { error: String(err) });
});

process.on('uncaughtException', (err) => {
  log('error', 'Uncaught exception', { error: err.message, stack: err.stack });
  setTimeout(() => process.exit(1), 500);
});

// ---------------------------------------------------------------------------
// Startup
// ---------------------------------------------------------------------------

const server = http.createServer(onRequest);

server.listen(PORT, async () => {
  log('info', 'Agent service started', { port: PORT });

  // Run migrations on startup
  try {
    await runMigrations();
    log('info', 'Database migrations applied');
  } catch (err) {
    log('error', 'Failed to apply migrations', { error: err.message });
    log('warn', 'Service running without verified schema — queries may fail');
  }
});
