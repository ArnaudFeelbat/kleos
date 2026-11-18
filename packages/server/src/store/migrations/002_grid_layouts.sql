CREATE TABLE grid_layouts (
  connection_id TEXT NOT NULL REFERENCES connections(id) ON DELETE CASCADE,
  schema_name   TEXT NOT NULL,
  table_name    TEXT NOT NULL,
  -- JSON GridLayout: { "order": ["id", "email"], "widths": { "email": 240 } }
  layout        TEXT NOT NULL,
  updated_at    TEXT NOT NULL,
  PRIMARY KEY (connection_id, schema_name, table_name)
);
