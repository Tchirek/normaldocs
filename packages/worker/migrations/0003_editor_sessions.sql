CREATE TABLE IF NOT EXISTS editor_sessions (
  id TEXT PRIMARY KEY,
  document_id TEXT NOT NULL,
  token_hash TEXT NOT NULL,
  filename TEXT NOT NULL,
  mime_type TEXT NOT NULL,
  ext TEXT NOT NULL,
  current_key TEXT,
  current_mime_type TEXT,
  current_filename TEXT,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_editor_sessions_document ON editor_sessions(document_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_editor_sessions_expires ON editor_sessions(expires_at);
