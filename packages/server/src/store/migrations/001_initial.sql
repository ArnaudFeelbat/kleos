CREATE TABLE connections (
  id           TEXT PRIMARY KEY,
  nickname     TEXT NOT NULL,
  host         TEXT NOT NULL,
  port         INTEGER NOT NULL,
  user         TEXT NOT NULL,
  database     TEXT NOT NULL,
  ssl_mode     TEXT NOT NULL,
  color        TEXT NOT NULL,
  read_only    INTEGER NOT NULL,
  -- Whether the Keychain holds a password; the password itself never lives here.
  has_password INTEGER NOT NULL,
  created_at   TEXT NOT NULL,
  updated_at   TEXT NOT NULL
);

CREATE TABLE layouts (
  connection_id TEXT NOT NULL REFERENCES connections(id) ON DELETE CASCADE,
  schema_name   TEXT NOT NULL,
  -- JSON: { "schema.table": { "x": 0, "y": 0 } }
  positions     TEXT NOT NULL,
  updated_at    TEXT NOT NULL,
  PRIMARY KEY (connection_id, schema_name)
);

CREATE TABLE history (
  id            TEXT PRIMARY KEY,
  connection_id TEXT NOT NULL REFERENCES connections(id) ON DELETE CASCADE,
  sql           TEXT NOT NULL,
  kind          TEXT NOT NULL,
  ran_at        TEXT NOT NULL,
  elapsed_ms    REAL,
  row_count     INTEGER,
  error         TEXT,
  cancelled     INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX history_by_connection ON history (connection_id, ran_at DESC);

CREATE TABLE saved_queries (
  id            TEXT PRIMARY KEY,
  connection_id TEXT NOT NULL REFERENCES connections(id) ON DELETE CASCADE,
  name          TEXT NOT NULL,
  sql           TEXT NOT NULL,
  -- JSON ChartSettings or NULL
  chart         TEXT,
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL
);
CREATE INDEX saved_queries_by_connection ON saved_queries (connection_id, name);
