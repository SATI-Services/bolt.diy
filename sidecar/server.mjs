import { WebSocketServer } from 'ws';
import fs from 'fs';
import path from 'path';
import { spawn } from 'child_process';
import net from 'net';

const PORT = parseInt(process.env.SIDECAR_PORT || '9838', 10);
const TOKEN = process.env.SIDECAR_TOKEN || '';
const WORKDIR = '/app';

if (!TOKEN) {
  console.error('[Sidecar] SIDECAR_TOKEN is required');
  process.exit(1);
}

const wss = new WebSocketServer({ host: '0.0.0.0', port: PORT });

console.log(`[Sidecar] WebSocket server listening on 0.0.0.0:${PORT}`);
console.log(`[Sidecar] Working directory: ${WORKDIR}`);

// Watch for dev server port binding
const WATCH_PORTS = [3000, 5173, 4321, 8080];
let serverReadyNotified = false;

function checkPorts(ws) {
  if (serverReadyNotified) return;

  for (const port of WATCH_PORTS) {
    const server = net.createServer();
    server.once('error', () => {
      // Port is in use = dev server is running
      if (!serverReadyNotified) {
        serverReadyNotified = true;
        sendJson(ws, { type: 'server_ready', port });
        console.log(`[Sidecar] Dev server detected on port ${port}`);
      }
    });
    server.once('listening', () => {
      server.close();
    });
    server.listen(port, '127.0.0.1');
  }
}

function sendJson(ws, data) {
  if (ws.readyState === 1) {
    ws.send(JSON.stringify(data));
  }
}

function resolvePath(filePath) {
  // Ensure path is within WORKDIR
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

function handleExec(ws, command) {
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
  console.log('[Sidecar] Client connected');

  // Start port checking interval
  const portCheckInterval = setInterval(() => checkPorts(ws), 2000);

  ws.on('message', (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      sendJson(ws, { type: 'error', message: 'Invalid JSON' });
      return;
    }

    // First message must be auth
    if (!authenticated) {
      if (msg.type === 'auth' && msg.token === TOKEN) {
        authenticated = true;
        sendJson(ws, { type: 'auth_ok' });
        console.log('[Sidecar] Client authenticated');

        // Check ports immediately on auth
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
          handleExec(ws, msg.command);
          break;

        case 'batch':
          if (Array.isArray(msg.operations)) {
            for (const op of msg.operations) {
              switch (op.type) {
                case 'write_file':
                  handleWriteFile(op.path, op.content);
                  break;
                case 'mkdir':
                  handleMkdir(op.path);
                  break;
                case 'delete_file':
                  handleDeleteFile(op.path);
                  break;
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
    console.log('[Sidecar] Client disconnected');
  });
});

// Graceful shutdown
process.on('SIGTERM', () => {
  console.log('[Sidecar] Shutting down...');
  wss.close(() => process.exit(0));
});

process.on('SIGINT', () => {
  console.log('[Sidecar] Shutting down...');
  wss.close(() => process.exit(0));
});
