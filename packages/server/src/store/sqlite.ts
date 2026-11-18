import { randomUUID } from 'node:crypto';
import Database from 'better-sqlite3';
import {
  ChartSettings,
  type ConnectionColor,
  type ConnectionConfig,
  type HistoryEntry,
  type LayoutPositions,
  type NewHistoryEntry,
  type SavedConnection,
  type SavedQuery,
  type SavedQueryInput,
  type SslMode,
} from '@kleos/shared';
import { KleosError } from '../errors';
import { migrations } from './migrations';
import type { AppStore } from './types';

const HISTORY_LIMIT = 1000;

type ConnectionRow = {
  id: string;
  nickname: string;
  host: string;
  port: number;
  user: string;
  database: string;
  ssl_mode: string;
  color: string;
  read_only: number;
  has_password: number;
  created_at: string;
  updated_at: string;
};

type HistoryRow = {
  id: string;
  connection_id: string;
  sql: string;
  kind: string;
  ran_at: string;
  elapsed_ms: number | null;
  row_count: number | null;
  error: string | null;
  cancelled: number;
};

type SavedQueryRow = {
  id: string;
  connection_id: string;
  name: string;
  sql: string;
  chart: string | null;
  created_at: string;
  updated_at: string;
};

function toConnection(row: ConnectionRow): SavedConnection {
  return {
    id: row.id,
    nickname: row.nickname,
    host: row.host,
    port: row.port,
    user: row.user,
    database: row.database,
    sslMode: row.ssl_mode as SslMode,
    color: row.color as ConnectionColor,
    readOnly: row.read_only === 1,
    hasPassword: row.has_password === 1,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function toHistory(row: HistoryRow): HistoryEntry {
  return {
    id: row.id,
    connectionId: row.connection_id,
    sql: row.sql,
    kind: row.kind === 'explain' ? 'explain' : 'query',
    ranAt: row.ran_at,
    elapsedMs: row.elapsed_ms,
    rowCount: row.row_count,
    error: row.error,
    cancelled: row.cancelled === 1,
  };
}

function toSavedQuery(row: SavedQueryRow): SavedQuery {
  const chart = row.chart ? ChartSettings.safeParse(JSON.parse(row.chart)) : null;
  return {
    id: row.id,
    connectionId: row.connection_id,
    name: row.name,
    sql: row.sql,
    chart: chart?.success ? chart.data : null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/** Applies every migration newer than schema_version, each in its own transaction. */
export function migrate(db: Database.Database): void {
  db.exec('CREATE TABLE IF NOT EXISTS schema_version (version INTEGER NOT NULL)');
  const row = db.prepare('SELECT max(version) AS v FROM schema_version').get() as { v: number | null };
  const current = row.v ?? 0;
  for (const m of migrations) {
    if (m.version <= current) continue;
    db.transaction(() => {
      db.exec(m.sql);
      db.prepare('INSERT INTO schema_version (version) VALUES (?)').run(m.version);
    })();
  }
}

export function createSqliteStore(path: string): AppStore {
  const db = new Database(path);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  migrate(db);

  const now = () => new Date().toISOString();

  const requireConnection = (id: string): SavedConnection => {
    const row = db.prepare('SELECT * FROM connections WHERE id = ?').get(id) as ConnectionRow | undefined;
    if (!row) throw KleosError.notFound('Connection not found');
    return toConnection(row);
  };

  const requireSavedQuery = (id: string): SavedQuery => {
    const row = db.prepare('SELECT * FROM saved_queries WHERE id = ?').get(id) as SavedQueryRow | undefined;
    if (!row) throw KleosError.notFound('Saved query not found');
    return toSavedQuery(row);
  };

  return {
    listConnections() {
      const rows = db.prepare('SELECT * FROM connections ORDER BY nickname COLLATE NOCASE').all() as ConnectionRow[];
      return rows.map(toConnection);
    },
    getConnection(id) {
      const row = db.prepare('SELECT * FROM connections WHERE id = ?').get(id) as ConnectionRow | undefined;
      return row ? toConnection(row) : null;
    },
    createConnection(config: ConnectionConfig, hasPassword) {
      const id = randomUUID();
      const t = now();
      db.prepare(
        `INSERT INTO connections (id, nickname, host, port, user, database, ssl_mode, color, read_only, has_password, created_at, updated_at)
         VALUES (@id, @nickname, @host, @port, @user, @database, @sslMode, @color, @readOnly, @hasPassword, @t, @t)`,
      ).run({ ...config, id, readOnly: config.readOnly ? 1 : 0, hasPassword: hasPassword ? 1 : 0, t });
      return requireConnection(id);
    },
    updateConnection(id, config, hasPassword) {
      requireConnection(id);
      db.prepare(
        `UPDATE connections SET nickname = @nickname, host = @host, port = @port, user = @user, database = @database,
           ssl_mode = @sslMode, color = @color, read_only = @readOnly, has_password = @hasPassword, updated_at = @t
         WHERE id = @id`,
      ).run({ ...config, id, readOnly: config.readOnly ? 1 : 0, hasPassword: hasPassword ? 1 : 0, t: now() });
      return requireConnection(id);
    },
    deleteConnection(id) {
      db.prepare('DELETE FROM connections WHERE id = ?').run(id);
    },

    getLayout(connectionId, schema): LayoutPositions {
      const row = db
        .prepare('SELECT positions FROM layouts WHERE connection_id = ? AND schema_name = ?')
        .get(connectionId, schema) as { positions: string } | undefined;
      return { positions: row ? (JSON.parse(row.positions) as LayoutPositions['positions']) : {} };
    },
    saveLayout(connectionId, schema, layout) {
      requireConnection(connectionId);
      db.prepare(
        `INSERT INTO layouts (connection_id, schema_name, positions, updated_at) VALUES (?, ?, ?, ?)
         ON CONFLICT (connection_id, schema_name) DO UPDATE SET positions = excluded.positions, updated_at = excluded.updated_at`,
      ).run(connectionId, schema, JSON.stringify(layout.positions), now());
    },

    listHistory(connectionId, limit = 200) {
      const rows = db
        .prepare('SELECT * FROM history WHERE connection_id = ? ORDER BY ran_at DESC, rowid DESC LIMIT ?')
        .all(connectionId, Math.min(Math.max(limit, 1), HISTORY_LIMIT)) as HistoryRow[];
      return rows.map(toHistory);
    },
    addHistory(connectionId, entry: NewHistoryEntry) {
      requireConnection(connectionId);
      const id = randomUUID();
      db.transaction(() => {
        db.prepare(
          `INSERT INTO history (id, connection_id, sql, kind, ran_at, elapsed_ms, row_count, error, cancelled)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        ).run(
          id,
          connectionId,
          entry.sql,
          entry.kind,
          entry.ranAt,
          entry.elapsedMs,
          entry.rowCount,
          entry.error,
          entry.cancelled ? 1 : 0,
        );
        db.prepare(
          `DELETE FROM history WHERE connection_id = ? AND id NOT IN (
             SELECT id FROM history WHERE connection_id = ? ORDER BY ran_at DESC, rowid DESC LIMIT ?)`,
        ).run(connectionId, connectionId, HISTORY_LIMIT);
      })();
      return toHistory(db.prepare('SELECT * FROM history WHERE id = ?').get(id) as HistoryRow);
    },

    listSavedQueries(connectionId) {
      const rows = (
        connectionId
          ? db
              .prepare('SELECT * FROM saved_queries WHERE connection_id = ? ORDER BY name COLLATE NOCASE')
              .all(connectionId)
          : db.prepare('SELECT * FROM saved_queries ORDER BY name COLLATE NOCASE').all()
      ) as SavedQueryRow[];
      return rows.map(toSavedQuery);
    },
    getSavedQuery(id) {
      const row = db.prepare('SELECT * FROM saved_queries WHERE id = ?').get(id) as SavedQueryRow | undefined;
      return row ? toSavedQuery(row) : null;
    },
    createSavedQuery(input: SavedQueryInput) {
      requireConnection(input.connectionId);
      const id = randomUUID();
      const t = now();
      db.prepare(
        `INSERT INTO saved_queries (id, connection_id, name, sql, chart, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      ).run(id, input.connectionId, input.name, input.sql, input.chart ? JSON.stringify(input.chart) : null, t, t);
      return requireSavedQuery(id);
    },
    updateSavedQuery(id, input) {
      requireSavedQuery(id);
      db.prepare(
        `UPDATE saved_queries SET connection_id = ?, name = ?, sql = ?, chart = ?, updated_at = ? WHERE id = ?`,
      ).run(input.connectionId, input.name, input.sql, input.chart ? JSON.stringify(input.chart) : null, now(), id);
      return requireSavedQuery(id);
    },
    deleteSavedQuery(id) {
      db.prepare('DELETE FROM saved_queries WHERE id = ?').run(id);
    },

    close() {
      db.close();
    },
  };
}
