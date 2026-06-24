CREATE TABLE IF NOT EXISTS documents (
  id TEXT PRIMARY KEY,
  filename TEXT NOT NULL,
  ext TEXT NOT NULL,
  mime_type TEXT NOT NULL,
  size_bytes INTEGER NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('uploading','pending','processing','ready','failed')),
  aspect_ratio REAL,
  page_count INTEGER,
  preview_kind TEXT,
  preview_manifest_key TEXT,
  preview_count INTEGER,
  blur_up_base64 TEXT,
  r2_key_original TEXT NOT NULL,
  r2_key_thumb TEXT,
  r2_key_web_prefix TEXT,
  r2_key_pdf TEXT,
  text_summary TEXT,
  error_message TEXT,
  folder_id TEXT,
  tags TEXT,
  comment_count INTEGER NOT NULL DEFAULT 0,
  uploaded_at INTEGER NOT NULL,
  processed_at INTEGER,
  claim_device_id TEXT,
  claim_token TEXT,
  claim_expires_at INTEGER
);

CREATE INDEX IF NOT EXISTS idx_documents_status_uploaded ON documents(status, uploaded_at);
CREATE INDEX IF NOT EXISTS idx_documents_uploaded ON documents(uploaded_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS idx_documents_folder ON documents(folder_id);
CREATE INDEX IF NOT EXISTS idx_documents_claim ON documents(claim_expires_at);

CREATE VIRTUAL TABLE IF NOT EXISTS document_fts USING fts5(
  document_id UNINDEXED,
  filename,
  text_summary,
  tags
);

CREATE TABLE IF NOT EXISTS document_likes (
  document_id TEXT NOT NULL,
  viewer_key TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY(document_id, viewer_key)
);

CREATE TABLE IF NOT EXISTS document_like_counts (
  document_id TEXT PRIMARY KEY,
  count INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS document_views (
  document_id TEXT NOT NULL,
  viewer_key TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY(document_id, viewer_key)
);

CREATE TABLE IF NOT EXISTS document_view_counts (
  document_id TEXT PRIMARY KEY,
  count INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS runtime_events (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS print_handoffs (
  token_id TEXT PRIMARY KEY,
  document_id TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  used_at INTEGER
);

CREATE TABLE IF NOT EXISTS document_comments (
  id TEXT PRIMARY KEY,
  document_id TEXT NOT NULL,
  root_id TEXT NOT NULL,
  parent_id TEXT,
  nickname TEXT NOT NULL,
  content TEXT NOT NULL,
  html TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'visible'
);

CREATE INDEX IF NOT EXISTS idx_document_comments_document ON document_comments(document_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_document_comments_root ON document_comments(root_id, created_at ASC);

CREATE TABLE IF NOT EXISTS document_comment_likes (
  comment_id TEXT NOT NULL,
  viewer_key TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY(comment_id, viewer_key)
);
