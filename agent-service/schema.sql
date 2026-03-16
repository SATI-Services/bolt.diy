-- Agent Service PostgreSQL Schema
-- Run against Coolify's existing PostgreSQL instance (coolify-db)
-- Creates a separate 'bolt' database/schema for agent loop state

-- Sessions: one per chat conversation
CREATE TABLE IF NOT EXISTS sessions (
  id              TEXT PRIMARY KEY,           -- chat ID / URL ID
  title           TEXT,
  status          TEXT DEFAULT 'idle',        -- idle | running | paused | error | done
  created_at      TIMESTAMPTZ DEFAULT now(),
  updated_at      TIMESTAMPTZ DEFAULT now(),

  -- Container association
  container_id    TEXT,
  container_domain TEXT,
  sidecar_url     TEXT,
  sidecar_token   TEXT,

  -- LLM config
  provider        TEXT,
  model           TEXT,

  -- Agent loop state
  iteration       INT DEFAULT 0,
  max_iterations  INT DEFAULT 25,
  total_tokens    INT DEFAULT 0
);

-- Messages: ordered chat history per session
CREATE TABLE IF NOT EXISTS messages (
  id          TEXT PRIMARY KEY,
  session_id  TEXT REFERENCES sessions(id) ON DELETE CASCADE,
  role        TEXT NOT NULL,              -- user | assistant | system | tool | execution_result
  content     TEXT NOT NULL,
  created_at  TIMESTAMPTZ DEFAULT now(),
  annotations JSONB,
  -- For ordering within a session
  seq         SERIAL
);
CREATE INDEX IF NOT EXISTS idx_messages_session ON messages(session_id, seq);

-- Actions: individual file/shell/start actions extracted from assistant messages
CREATE TABLE IF NOT EXISTS actions (
  id            TEXT PRIMARY KEY,
  session_id    TEXT REFERENCES sessions(id) ON DELETE CASCADE,
  message_id    TEXT REFERENCES messages(id),
  type          TEXT NOT NULL,              -- file | shell | start | build
  content       TEXT,                       -- command or file content
  file_path     TEXT,
  status        TEXT DEFAULT 'pending',     -- pending | running | complete | failed
  exit_code     INT,
  output        TEXT,                       -- stdout+stderr (truncated)
  started_at    TIMESTAMPTZ,
  completed_at  TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_actions_session ON actions(session_id);

-- Files: current file state per session (populated by file actions)
CREATE TABLE IF NOT EXISTS files (
  session_id  TEXT REFERENCES sessions(id) ON DELETE CASCADE,
  path        TEXT NOT NULL,
  content     TEXT,
  is_binary   BOOLEAN DEFAULT false,
  updated_at  TIMESTAMPTZ DEFAULT now(),
  PRIMARY KEY (session_id, path)
);
