import pg from 'pg';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import crypto from 'node:crypto';

const __dirname = dirname(fileURLToPath(import.meta.url));

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

const pool = new pg.Pool({
  connectionString: process.env.DATABASE_URL || 'postgresql://postgres:postgres@localhost:5432/bolt',
  max: 10,
});

// ---------------------------------------------------------------------------
// Migrations
// ---------------------------------------------------------------------------

export async function runMigrations() {
  const schema = readFileSync(join(__dirname, 'schema.sql'), 'utf-8');
  await pool.query(schema);
  console.log('Migrations applied successfully');
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function generateId() {
  return crypto.randomUUID();
}

// ---------------------------------------------------------------------------
// Sessions
// ---------------------------------------------------------------------------

export async function createSession({ id, title, provider, model, containerInfo, maxIterations }) {
  const sessionId = id || generateId();
  await pool.query(
    `INSERT INTO sessions (id, title, provider, model, container_id, container_domain, sidecar_url, sidecar_token, max_iterations)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
    [
      sessionId,
      title || null,
      provider || null,
      model || null,
      containerInfo?.containerId || null,
      containerInfo?.domain || null,
      containerInfo?.sidecarUrl || null,
      containerInfo?.token || null,
      maxIterations || 200,
    ],
  );
  return getSession(sessionId);
}

export async function getSession(id) {
  const { rows } = await pool.query('SELECT * FROM sessions WHERE id = $1', [id]);
  return rows[0] || null;
}

export async function updateSession(id, updates) {
  const fields = [];
  const values = [];
  let idx = 1;

  for (const [key, value] of Object.entries(updates)) {
    // Convert camelCase to snake_case for DB columns
    const col = key.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`);
    fields.push(`${col} = $${idx}`);
    values.push(value);
    idx++;
  }

  fields.push(`updated_at = now()`);
  values.push(id);

  await pool.query(
    `UPDATE sessions SET ${fields.join(', ')} WHERE id = $${idx}`,
    values,
  );
  return getSession(id);
}

export async function listSessions() {
  const { rows } = await pool.query(
    'SELECT id, title, status, provider, model, iteration, max_iterations, total_tokens, created_at, updated_at FROM sessions ORDER BY updated_at DESC',
  );
  return rows;
}

export async function deleteSession(id) {
  await pool.query('DELETE FROM sessions WHERE id = $1', [id]);
}

// ---------------------------------------------------------------------------
// Messages
// ---------------------------------------------------------------------------

export async function saveMessage(sessionId, { role, content, annotations }) {
  const id = generateId();
  await pool.query(
    `INSERT INTO messages (id, session_id, role, content, annotations)
     VALUES ($1, $2, $3, $4, $5)`,
    [id, sessionId, role, content, annotations ? JSON.stringify(annotations) : null],
  );
  return { id, sessionId, role, content, annotations };
}

export async function getMessages(sessionId) {
  const { rows } = await pool.query(
    'SELECT * FROM messages WHERE session_id = $1 ORDER BY seq ASC',
    [sessionId],
  );
  return rows;
}

export async function getMessagesSince(sessionId, afterSeq) {
  const { rows } = await pool.query(
    'SELECT * FROM messages WHERE session_id = $1 AND seq > $2 ORDER BY seq ASC',
    [sessionId, afterSeq],
  );
  return rows;
}

// ---------------------------------------------------------------------------
// Actions
// ---------------------------------------------------------------------------

export async function saveAction(sessionId, messageId, action) {
  const id = generateId();
  await pool.query(
    `INSERT INTO actions (id, session_id, message_id, type, content, file_path, status)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [
      id,
      sessionId,
      messageId,
      action.type,
      action.content || null,
      action.filePath || null,
      'pending',
    ],
  );
  return { id, ...action, status: 'pending' };
}

export async function updateAction(id, updates) {
  const fields = [];
  const values = [];
  let idx = 1;

  for (const [key, value] of Object.entries(updates)) {
    const col = key.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`);
    fields.push(`${col} = $${idx}`);
    values.push(value);
    idx++;
  }

  values.push(id);
  await pool.query(
    `UPDATE actions SET ${fields.join(', ')} WHERE id = $${idx}`,
    values,
  );
}

export async function getActions(sessionId) {
  const { rows } = await pool.query(
    'SELECT * FROM actions WHERE session_id = $1 ORDER BY started_at ASC NULLS LAST',
    [sessionId],
  );
  return rows;
}

// ---------------------------------------------------------------------------
// Files
// ---------------------------------------------------------------------------

export async function upsertFile(sessionId, path, content, isBinary = false) {
  await pool.query(
    `INSERT INTO files (session_id, path, content, is_binary, updated_at)
     VALUES ($1, $2, $3, $4, now())
     ON CONFLICT (session_id, path)
     DO UPDATE SET content = EXCLUDED.content, is_binary = EXCLUDED.is_binary, updated_at = now()`,
    [sessionId, path, content, isBinary],
  );
}

export async function getFiles(sessionId) {
  const { rows } = await pool.query(
    'SELECT path, content, is_binary, updated_at FROM files WHERE session_id = $1 ORDER BY path',
    [sessionId],
  );
  return rows;
}

export async function deleteFileRecord(sessionId, path) {
  await pool.query(
    'DELETE FROM files WHERE session_id = $1 AND path = $2',
    [sessionId, path],
  );
}

// ---------------------------------------------------------------------------
// Full session state (for reconnection)
// ---------------------------------------------------------------------------

export async function getFullSessionState(sessionId) {
  const [session, messages, actions, files] = await Promise.all([
    getSession(sessionId),
    getMessages(sessionId),
    getActions(sessionId),
    getFiles(sessionId),
  ]);

  if (!session) return null;

  return { session, messages, actions, files };
}

// ---------------------------------------------------------------------------
// Cleanup
// ---------------------------------------------------------------------------

export async function close() {
  await pool.end();
}

export { pool };
