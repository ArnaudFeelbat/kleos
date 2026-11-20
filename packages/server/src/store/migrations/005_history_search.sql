-- 0.7: full-text search over past runs (SQL text and error text).
--
-- The FTS index points at history rows by rowid. history's rowid was implicit (its key is the
-- TEXT id), and VACUUM may renumber implicit rowids, which would silently point the index at the
-- wrong rows. The table is rebuilt with an explicit INTEGER PRIMARY KEY (seq), which VACUUM keeps;
-- existing rows keep their rowid as seq, so "newest first" ties still break the same way.
CREATE TABLE history_new (
  seq           INTEGER PRIMARY KEY,
  id            TEXT NOT NULL UNIQUE,
  connection_id TEXT NOT NULL REFERENCES connections(id) ON DELETE CASCADE,
  sql           TEXT NOT NULL,
  kind          TEXT NOT NULL,
  ran_at        TEXT NOT NULL,
  elapsed_ms    REAL,
  row_count     INTEGER,
  error         TEXT,
  cancelled     INTEGER NOT NULL DEFAULT 0
);
INSERT INTO history_new (seq, id, connection_id, sql, kind, ran_at, elapsed_ms, row_count, error, cancelled)
  SELECT rowid, id, connection_id, sql, kind, ran_at, elapsed_ms, row_count, error, cancelled FROM history;
DROP TABLE history;
ALTER TABLE history_new RENAME TO history;
CREATE INDEX history_by_connection ON history (connection_id, ran_at DESC);
-- Search across every server, newest first.
CREATE INDEX history_by_time ON history (ran_at DESC);

-- External content: the index keeps no second copy of the text. unicode61 folds case and
-- (remove_diacritics 2) accents; letters and digits make tokens, everything else separates them.
CREATE VIRTUAL TABLE history_fts USING fts5(
  sql, error,
  content = 'history', content_rowid = 'seq',
  tokenize = 'unicode61 remove_diacritics 2'
);

-- Kept in step with every insert and deletion, including the per-connection trim in addHistory
-- and the ON DELETE CASCADE of a deleted favorite (foreign-key actions fire triggers).
CREATE TRIGGER history_fts_insert AFTER INSERT ON history BEGIN
  INSERT INTO history_fts (rowid, sql, error) VALUES (new.seq, new.sql, new.error);
END;
CREATE TRIGGER history_fts_delete AFTER DELETE ON history BEGIN
  INSERT INTO history_fts (history_fts, rowid, sql, error) VALUES ('delete', old.seq, old.sql, old.error);
END;
CREATE TRIGGER history_fts_update AFTER UPDATE OF sql, error ON history BEGIN
  INSERT INTO history_fts (history_fts, rowid, sql, error) VALUES ('delete', old.seq, old.sql, old.error);
  INSERT INTO history_fts (rowid, sql, error) VALUES (new.seq, new.sql, new.error);
END;

-- Backfill: indexes every run recorded before 0.7.
INSERT INTO history_fts (history_fts) VALUES ('rebuild');
