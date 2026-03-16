/**
 * Minimal HTTP server for chat persistence.
 * Runs alongside bolt on localhost:9850 — NOT exposed externally.
 * Provides GET/PUT for chat JSON files stored on disk.
 */
import { createServer } from 'node:http';
import { readFileSync, writeFileSync, mkdirSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const PORT = 9850;
const DATA_DIR = process.env.CHAT_DATA_DIR || '/home/bolt.diy/data/chats';

mkdirSync(DATA_DIR, { recursive: true });

function safeName(urlId) {
  return urlId.replace(/[^a-zA-Z0-9_-]/g, '');
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  const parts = url.pathname.split('/').filter(Boolean); // ['chats', urlId]

  res.setHeader('Content-Type', 'application/json');

  // GET /chats — list all
  if (req.method === 'GET' && parts[0] === 'chats' && !parts[1]) {
    try {
      const files = readdirSync(DATA_DIR).filter((f) => f.endsWith('.json'));
      const summaries = [];

      for (const file of files) {
        try {
          const raw = readFileSync(join(DATA_DIR, file), 'utf-8');
          const data = JSON.parse(raw);
          summaries.push({
            urlId: data.urlId,
            description: data.description,
            updatedAt: data.updatedAt,
          });
        } catch {
          // skip
        }
      }

      summaries.sort((a, b) => new Date(b.updatedAt) - new Date(a.updatedAt));
      res.writeHead(200);
      res.end(JSON.stringify(summaries));
    } catch (e) {
      res.writeHead(500);
      res.end(JSON.stringify({ error: e.message }));
    }

    return;
  }

  // GET /chats/:urlId
  if (req.method === 'GET' && parts[0] === 'chats' && parts[1]) {
    const filePath = join(DATA_DIR, `${safeName(parts[1])}.json`);

    if (!existsSync(filePath)) {
      res.writeHead(404);
      res.end(JSON.stringify({ error: 'Not found' }));

      return;
    }

    try {
      const raw = readFileSync(filePath, 'utf-8');
      res.writeHead(200);
      res.end(raw);
    } catch (e) {
      res.writeHead(500);
      res.end(JSON.stringify({ error: e.message }));
    }

    return;
  }

  // PUT /chats/:urlId
  if (req.method === 'PUT' && parts[0] === 'chats' && parts[1]) {
    let body = '';
    req.on('data', (chunk) => (body += chunk));
    req.on('end', () => {
      try {
        const data = JSON.parse(body);
        const filePath = join(DATA_DIR, `${safeName(parts[1])}.json`);
        writeFileSync(filePath, JSON.stringify(data), 'utf-8');
        res.writeHead(200);
        res.end(JSON.stringify({ ok: true }));
      } catch (e) {
        res.writeHead(500);
        res.end(JSON.stringify({ error: e.message }));
      }
    });

    return;
  }

  // Health
  if (req.method === 'GET' && url.pathname === '/health') {
    res.writeHead(200);
    res.end(JSON.stringify({ ok: true }));

    return;
  }

  res.writeHead(404);
  res.end(JSON.stringify({ error: 'Not found' }));
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`Chat store server listening on http://127.0.0.1:${PORT}`);
});
