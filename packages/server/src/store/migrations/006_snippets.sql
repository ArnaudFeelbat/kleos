-- 0.7: reusable SQL snippets, shared by every server.
CREATE TABLE snippets (
  id         TEXT PRIMARY KEY,
  name       TEXT NOT NULL,
  body       TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
-- Names are unique whatever their case. NOCASE folds ASCII only; the store also compares
-- names with full Unicode case folding before writing.
CREATE UNIQUE INDEX snippets_by_name ON snippets (name COLLATE NOCASE);
