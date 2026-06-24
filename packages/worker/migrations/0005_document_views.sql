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
