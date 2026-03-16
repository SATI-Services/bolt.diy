import { WebSocketServer } from 'ws';
import http from 'http';
import fs from 'fs';
import path from 'path';
import { spawn } from 'child_process';
import net from 'net';
import { createRequire } from 'module';

const WS_PORT = parseInt(process.env.SIDECAR_PORT || '9838', 10);
const HTTP_PORT = parseInt(process.env.SIDECAR_HTTP_PORT || '9839', 10);
const TOKEN = process.env.SIDECAR_TOKEN || '';
const WORKDIR = '/app';

if (!TOKEN) {
  console.error('[Sidecar] SIDECAR_TOKEN is required');
  process.exit(1);
}

// ---- Placeholder server on port 3000 for Coolify health checks ----
// Coolify expects port 3000 to be listening; this placeholder keeps the
// container marked as "healthy" until the real dev server takes over.

const PLACEHOLDER_PORT = 3000;
let placeholderServer = null;
let placeholderClosed = false;

function startPlaceholder() {
  placeholderServer = http.createServer((_req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end('<html><body style="display:flex;justify-content:center;align-items:center;height:100vh;font-family:sans-serif;background:#1a1a2e;color:#e0e0e0"><h2>Waiting for dev server...</h2></body></html>');
  });
  placeholderServer.on('error', (err) => {
    if (err.code === 'EADDRINUSE') {
      console.log(`[Sidecar] Port ${PLACEHOLDER_PORT} already in use, placeholder not needed`);
      placeholderServer = null;
      placeholderClosed = true;
    }
  });
  placeholderServer.listen(PLACEHOLDER_PORT, '0.0.0.0', () => {
    console.log(`[Sidecar] Placeholder health server on port ${PLACEHOLDER_PORT}`);
  });
}

function closePlaceholder() {
  if (placeholderServer && !placeholderClosed) {
    console.log('[Sidecar] Closing placeholder to free port for dev server');
    placeholderServer.close();
    placeholderServer = null;
    placeholderClosed = true;
  }
}

startPlaceholder();

// ---- Shared helpers ----

function resolvePath(filePath) {
  const resolved = path.resolve(WORKDIR, filePath.replace(/^\/+/, ''));
  if (!resolved.startsWith(WORKDIR)) {
    throw new Error(`Path traversal attempt: ${filePath}`);
  }
  return resolved;
}

function handleWriteFile(filePath, content) {
  const fullPath = resolvePath(filePath);
  fs.mkdirSync(path.dirname(fullPath), { recursive: true });
  fs.writeFileSync(fullPath, content, 'utf-8');
  return { type: 'ok', message: `Written: ${filePath}` };
}

function handleMkdir(dirPath) {
  const fullPath = resolvePath(dirPath);
  fs.mkdirSync(fullPath, { recursive: true });
  return { type: 'ok', message: `Created: ${dirPath}` };
}

function handleDeleteFile(filePath) {
  const fullPath = resolvePath(filePath);
  if (fs.existsSync(fullPath)) {
    fs.unlinkSync(fullPath);
  }
  return { type: 'ok', message: `Deleted: ${filePath}` };
}

function handleReadFile(filePath) {
  const fullPath = resolvePath(filePath);
  if (!fs.existsSync(fullPath)) {
    return { type: 'error', message: `Not found: ${filePath}` };
  }
  const stat = fs.statSync(fullPath);
  if (stat.isDirectory()) {
    return { type: 'error', message: `Is a directory: ${filePath}` };
  }
  // Skip binary files (check first 512 bytes for null bytes)
  const buf = Buffer.alloc(512);
  const fd = fs.openSync(fullPath, 'r');
  const bytesRead = fs.readSync(fd, buf, 0, 512, 0);
  fs.closeSync(fd);
  for (let i = 0; i < bytesRead; i++) {
    if (buf[i] === 0) {
      return { type: 'ok', content: null, isBinary: true };
    }
  }
  const content = fs.readFileSync(fullPath, 'utf-8');
  return { type: 'ok', content, isBinary: false };
}

function handleListFiles(dirPath, maxDepth = 10) {
  const IGNORE = new Set([
    'node_modules', '.git', 'vendor', 'storage', '.cache',
    '.npm', '.composer', 'dist', 'build', '.next', 'coverage'
  ]);
  const files = {};

  function walk(dir, depth) {
    if (depth > maxDepth) return;
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }

    for (const entry of entries) {
      if (IGNORE.has(entry.name)) continue;
      if (entry.name.startsWith('.') && entry.name !== '.env' && entry.name !== '.env.example') continue;

      const fullPath = path.join(dir, entry.name);
      const relativePath = path.relative(WORKDIR, fullPath);

      if (entry.isDirectory()) {
        files[relativePath] = { type: 'folder' };
        walk(fullPath, depth + 1);
      } else if (entry.isFile()) {
        const stat = fs.statSync(fullPath);
        // Skip files > 1MB
        if (stat.size > 1024 * 1024) {
          files[relativePath] = { type: 'file', size: stat.size, tooLarge: true };
        } else {
          files[relativePath] = { type: 'file', size: stat.size };
        }
      }
    }
  }

  const resolved = resolvePath(dirPath || '.');
  walk(resolved, 0);
  return { type: 'ok', files };
}

function execCommand(command) {
  // Close placeholder before exec so the dev server can bind port 3000
  closePlaceholder();

  return new Promise((resolve) => {
    const proc = spawn('sh', ['-c', command], {
      cwd: WORKDIR,
      env: { ...process.env, HOME: WORKDIR },
    });

    let output = '';

    proc.stdout.on('data', (data) => { output += data.toString(); });
    proc.stderr.on('data', (data) => { output += data.toString(); });

    proc.on('close', (exitCode) => {
      resolve({ exitCode: exitCode ?? 1, output });
    });

    proc.on('error', (error) => {
      resolve({ exitCode: 1, output: error.message });
    });
  });
}

// ---- WebSocket server (original protocol) ----

const wss = new WebSocketServer({ host: '0.0.0.0', port: WS_PORT });
console.log(`[Sidecar] WebSocket server listening on 0.0.0.0:${WS_PORT}`);

const WATCH_PORTS = [3000, 5173, 4321, 8080];
let serverReadyNotified = false;
let detectedPort = null;

function sendJson(ws, data) {
  if (ws.readyState === 1) {
    ws.send(JSON.stringify(data));
  }
}

function checkPorts(ws) {
  if (serverReadyNotified) return;

  for (const port of WATCH_PORTS) {
    // Skip port 3000 while our placeholder is still running
    if (port === PLACEHOLDER_PORT && !placeholderClosed) continue;

    const server = net.createServer();
    server.once('error', () => {
      if (!serverReadyNotified) {
        serverReadyNotified = true;
        detectedPort = port;

        if (ws) {
          sendJson(ws, { type: 'server_ready', port });
        }

        console.log(`[Sidecar] Dev server detected on port ${port}`);
      }
    });
    server.once('listening', () => { server.close(); });
    server.listen(port, '127.0.0.1');
  }
}

// Standalone port detection interval (works without WS clients)
const portCheckInterval = setInterval(() => checkPorts(null), 2000);
if (portCheckInterval.unref) portCheckInterval.unref();

function handleExecWs(ws, command) {
  // Close placeholder before exec so the dev server can bind port 3000
  closePlaceholder();

  const proc = spawn('sh', ['-c', command], {
    cwd: WORKDIR,
    env: { ...process.env, HOME: WORKDIR },
  });

  let output = '';

  proc.stdout.on('data', (data) => {
    const text = data.toString();
    output += text;
    sendJson(ws, { type: 'exec_output', output: text });
  });

  proc.stderr.on('data', (data) => {
    const text = data.toString();
    output += text;
    sendJson(ws, { type: 'exec_output', output: text });
  });

  proc.on('close', (exitCode) => {
    sendJson(ws, { type: 'exec_exit', exitCode: exitCode ?? 1, output });
  });

  proc.on('error', (error) => {
    sendJson(ws, { type: 'exec_exit', exitCode: 1, output: error.message });
  });
}

wss.on('connection', (ws) => {
  let authenticated = false;
  console.log('[Sidecar] WS client connected');

  const portCheckInterval = setInterval(() => checkPorts(ws), 2000);

  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw.toString()); } catch {
      sendJson(ws, { type: 'error', message: 'Invalid JSON' });
      return;
    }

    if (!authenticated) {
      if (msg.type === 'auth' && msg.token === TOKEN) {
        authenticated = true;
        sendJson(ws, { type: 'auth_ok' });
        console.log('[Sidecar] WS client authenticated');
        checkPorts(ws);
      } else {
        sendJson(ws, { type: 'auth_fail', message: 'Invalid token' });
        ws.close();
      }
      return;
    }

    try {
      switch (msg.type) {
        case 'write_file':
          sendJson(ws, handleWriteFile(msg.path, msg.content));
          break;
        case 'mkdir':
          sendJson(ws, handleMkdir(msg.path));
          break;
        case 'delete_file':
          sendJson(ws, handleDeleteFile(msg.path));
          break;
        case 'exec':
          handleExecWs(ws, msg.command);
          break;
        case 'batch':
          if (Array.isArray(msg.operations)) {
            for (const op of msg.operations) {
              switch (op.type) {
                case 'write_file': handleWriteFile(op.path, op.content); break;
                case 'mkdir': handleMkdir(op.path); break;
                case 'delete_file': handleDeleteFile(op.path); break;
              }
            }
            sendJson(ws, { type: 'ok', message: `Batch: ${msg.operations.length} operations` });
          }
          break;
        case 'ping':
          sendJson(ws, { type: 'pong' });
          break;
        default:
          sendJson(ws, { type: 'error', message: `Unknown type: ${msg.type}` });
      }
    } catch (error) {
      sendJson(ws, { type: 'error', message: error.message });
    }
  });

  ws.on('close', () => {
    clearInterval(portCheckInterval);
    console.log('[Sidecar] WS client disconnected');
  });
});

// ---- HTTP API server (for browser access via Traefik) ----

function authenticate(req) {
  const auth = req.headers['authorization'];
  return auth === `Bearer ${TOKEN}`;
}

function readBody(req) {
  return new Promise((resolve) => {
    let data = '';
    req.on('data', (chunk) => { data += chunk; });
    req.on('end', () => {
      try { resolve(JSON.parse(data)); } catch { resolve(null); }
    });
  });
}

const httpServer = http.createServer(async (req, res) => {
  // CORS headers
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  // Health check
  if (req.url === '/health' && req.method === 'GET') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'ok', serverReady: serverReadyNotified, detectedPort }));
    return;
  }

  // All other endpoints require auth
  if (!authenticate(req)) {
    res.writeHead(401, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Unauthorized' }));
    return;
  }

  const body = await readBody(req);

  try {
    if (req.url === '/write' && req.method === 'POST') {
      const result = handleWriteFile(body.path, body.content);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(result));
    } else if (req.url === '/mkdir' && req.method === 'POST') {
      const result = handleMkdir(body.path);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(result));
    } else if (req.url === '/delete' && req.method === 'POST') {
      const result = handleDeleteFile(body.path);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(result));
    } else if (req.url === '/exec' && req.method === 'POST') {
      const result = await execCommand(body.command);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(result));
    } else if (req.url === '/exec-stream' && req.method === 'POST') {
      // Streaming exec — sends stdout/stderr as SSE, then final exit code
      closePlaceholder();
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
      });

      const proc = spawn('sh', ['-c', body.command], {
        cwd: WORKDIR,
        env: { ...process.env, HOME: WORKDIR },
      });

      let output = '';

      proc.stdout.on('data', (data) => {
        const text = data.toString();
        output += text;
        res.write(`data: ${JSON.stringify({ type: 'stdout', data: text })}\n\n`);
      });
      proc.stderr.on('data', (data) => {
        const text = data.toString();
        output += text;
        res.write(`data: ${JSON.stringify({ type: 'stderr', data: text })}\n\n`);
      });
      proc.on('close', (exitCode) => {
        res.write(`data: ${JSON.stringify({ type: 'exit', exitCode: exitCode ?? 1, output })}\n\n`);
        res.end();
      });
      proc.on('error', (error) => {
        res.write(`data: ${JSON.stringify({ type: 'exit', exitCode: 1, output: error.message })}\n\n`);
        res.end();
      });

      // Handle client disconnect
      req.on('close', () => {
        proc.kill();
      });
    } else if (req.url === '/read' && req.method === 'POST') {
      const result = handleReadFile(body.path);
      res.writeHead(result.type === 'error' ? 404 : 200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(result));
    } else if (req.url === '/list-files' && req.method === 'POST') {
      const result = handleListFiles(body.path || '.', body.maxDepth || 10);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(result));
    } else if (req.url === '/batch' && req.method === 'POST') {
      if (Array.isArray(body.operations)) {
        for (const op of body.operations) {
          switch (op.type) {
            case 'write_file': handleWriteFile(op.path, op.content); break;
            case 'mkdir': handleMkdir(op.path); break;
            case 'delete_file': handleDeleteFile(op.path); break;
          }
        }
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ type: 'ok', message: `Batch: ${(body.operations || []).length} operations` }));
    } else {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Not found' }));
    }
  } catch (error) {
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: error.message }));
  }
});

httpServer.listen(HTTP_PORT, '0.0.0.0', () => {
  console.log(`[Sidecar] HTTP API listening on 0.0.0.0:${HTTP_PORT}`);
  console.log(`[Sidecar] Working directory: ${WORKDIR}`);
});

// ---- PTY Terminal WebSocket endpoint ----
const require = createRequire(import.meta.url);

let ptyModule;
try {
  ptyModule = require('node-pty');
} catch (e) {
  console.warn('[Sidecar] node-pty not available, terminal endpoint disabled');
}

const terminalWss = new WebSocketServer({ noServer: true });

httpServer.on('upgrade', (req, socket, head) => {
  const url = new URL(req.url, `http://${req.headers.host}`);

  if (url.pathname === '/terminal') {
    // Authenticate via query param or header
    const authToken = url.searchParams.get('token') || req.headers['authorization']?.replace('Bearer ', '');

    if (authToken !== TOKEN) {
      socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
      socket.destroy();
      return;
    }

    if (!ptyModule) {
      socket.write('HTTP/1.1 503 Service Unavailable\r\n\r\n');
      socket.destroy();
      return;
    }

    terminalWss.handleUpgrade(req, socket, head, (ws) => {
      terminalWss.emit('connection', ws, req);
    });
  } else {
    socket.destroy();
  }
});

terminalWss.on('connection', (ws) => {
  console.log('[Sidecar] Terminal client connected');

  const pty = ptyModule.spawn('/bin/bash', [], {
    name: 'xterm-256color',
    cols: 80,
    rows: 24,
    cwd: WORKDIR,
    env: { ...process.env, HOME: WORKDIR, TERM: 'xterm-256color' },
  });

  pty.onData((data) => {
    try {
      if (ws.readyState === 1) {
        ws.send(data);
      }
    } catch (e) {
      // ignore
    }
  });

  ws.on('message', (raw) => {
    const msg = raw.toString();

    // Check if it's a JSON control message
    try {
      const parsed = JSON.parse(msg);
      if (parsed.type === 'resize' && parsed.cols && parsed.rows) {
        pty.resize(parsed.cols, parsed.rows);
        return;
      }
    } catch {
      // Not JSON, treat as terminal input
    }

    pty.write(msg);
  });

  ws.on('close', () => {
    console.log('[Sidecar] Terminal client disconnected');
    pty.kill();
  });

  pty.onExit(() => {
    if (ws.readyState === 1) {
      ws.close();
    }
  });
});

// ---- Graceful shutdown ----

process.on('SIGTERM', () => {
  console.log('[Sidecar] Shutting down...');
  closePlaceholder();
  httpServer.close();
  wss.close(() => process.exit(0));
});

process.on('SIGINT', () => {
  console.log('[Sidecar] Shutting down...');
  closePlaceholder();
  httpServer.close();
  wss.close(() => process.exit(0));
});
