export const DDL = `
CREATE TABLE IF NOT EXISTS capability(
  id TEXT PRIMARY KEY, kind TEXT, source TEXT, name TEXT, summary TEXT, params TEXT,
  activation TEXT, content_hash TEXT, updated_at TEXT);
CREATE INDEX IF NOT EXISTS idx_capability_kind ON capability(kind);
CREATE VIRTUAL TABLE IF NOT EXISTS capability_fts USING fts5(id UNINDEXED, name, summary, params);
CREATE TABLE IF NOT EXISTS usage(id TEXT PRIMARY KEY, count INTEGER DEFAULT 0, last_used_at TEXT);
`;
