import { WebSocketServer } from 'ws';
import http from 'http';
import fs from 'fs';
import path from 'path';
import { spawn } from 'child_process';
import net from 'net';

const WS_PORT = parseInt(process.env.SIDECAR_PORT || '9838', 10);
const HTTP_PORT = parseInt(process.env.SIDECAR_HTTP_PORT || '9839', 10);
const TOKEN = process.env.SIDECAR_TOKEN || '';
const WORKDIR = '/app';

if (!TOKEN) {
  console.error('[Sidecar] SIDECAR_TOKEN is required');
  process.exit(1);
}

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

function execCommand(command) {
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
    const server = net.createServer();
    server.once('error', () => {
      if (!serverReadyNotified) {
        serverReadyNotified = true;
        detectedPort = port;
        sendJson(ws, { type: 'server_ready', port });
        console.log(`[Sidecar] Dev server detected on port ${port}`);
      }
    });
    server.once('listening', () => { server.close(); });
    server.listen(port, '127.0.0.1');
  }
}

function handleExecWs(ws, command) {
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

// ---- Graceful shutdown ----

process.on('SIGTERM', () => {
  console.log('[Sidecar] Shutting down...');
  httpServer.close();
  wss.close(() => process.exit(0));
});

process.on('SIGINT', () => {
  console.log('[Sidecar] Shutting down...');
  httpServer.close();
  wss.close(() => process.exit(0));
});
