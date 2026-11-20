import { randomUUID } from 'node:crypto';
import Database from 'better-sqlite3';
import type { z } from 'zod';
import {
  ChartSettings,
  type ConnectionColor,
  type ConnectionConfig,
  GridLayout,
  type HistoryEntry,
  emptyGridLayout,
  type LayoutPositions,
  type NewHistoryEntry,
  type SavedConnection,
  SavedQuery,
  type SavedQueryInput,
  type Snippet,
  SshConfig,
  type SslMode,
  WindowState,
  emptyWindowState,
  kleosErrorCodes,
} from '@kleos/shared';
import { KleosError } from '../errors';
import { historyMatchExpression } from './history-search';
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
  ssh: string | null;
  ssl_root_cert_path: string | null;
  has_ssh_passphrase: number;
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
  param_values: string | null;
  created_at: string;
  updated_at: string;
};

type SnippetRow = {
  id: string;
  name: string;
  body: string;
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
    ssh: parseJson(row.ssh, SshConfig),
    sslRootCertPath: row.ssl_root_cert_path,
    hasPassword: row.has_password === 1,
    hasSshPassphrase: row.has_ssh_passphrase === 1,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/** Parses stored JSON with a schema; anything unreadable is null rather than a crash. */
function parseJson<S extends z.ZodType>(text: string | null, schema: S): z.output<S> | null {
  if (text === null) return null;
  try {
    const parsed = schema.safeParse(JSON.parse(text));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

/** Named parameters for the connections table; ssh and the CA path absent are stored as null. */
function connectionParams(config: ConnectionConfig) {
  return {
    nickname: config.nickname,
    host: config.host,
    port: config.port,
    user: config.user,
    database: config.database,
    sslMode: config.sslMode,
    color: config.color,
    readOnly: config.readOnly ? 1 : 0,
    ssh: config.ssh ? JSON.stringify(SshConfig.parse(config.ssh)) : null,
    sslRootCertPath: config.sslRootCertPath || null,
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
    paramValues: parseJson(row.param_values, SavedQuery.shape.paramValues) ?? null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function toSnippet(row: SnippetRow): Snippet {
  return { id: row.id, name: row.name, body: row.body, createdAt: row.created_at, updatedAt: row.updated_at };
}

/** Snippet names compare with full Unicode case folding (SQLite's NOCASE folds ASCII only). */
function snippetNameKey(name: string): string {
  return name.normalize('NFC').toLowerCase();
}

/** The outcome filter of a history search, as SQL on the history table. */
const outcomeWhere = {
  ok: 'error IS NULL AND cancelled = 0',
  // Exclusive outcomes, as the side panel offers them: a cancelled run carries its 57014 error
  // text but counts as cancelled, not failed.
  error: 'error IS NOT NULL AND cancelled = 0',
  cancelled: 'cancelled = 1',
} as const;

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

  const requireSnippet = (id: string): Snippet => {
    const row = db.prepare('SELECT * FROM snippets WHERE id = ?').get(id) as SnippetRow | undefined;
    if (!row) throw KleosError.notFound('Snippet not found');
    return toSnippet(row);
  };

  /** 409 when another snippet already has this name, whatever its case. */
  const refuseTakenSnippetName = (name: string, exceptId: string | null): void => {
    const key = snippetNameKey(name);
    const rows = db.prepare('SELECT id, name FROM snippets').all() as Pick<SnippetRow, 'id' | 'name'>[];
    const taken = rows.find((row) => row.id !== exceptId && snippetNameKey(row.name) === key);
    if (taken) {
      throw new KleosError(409, {
        code: kleosErrorCodes.validation,
        message: `A snippet named "${taken.name}" already exists`,
        hint: 'Choose another name, or edit that snippet instead.',
      });
    }
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
    createConnection(config: ConnectionConfig, hasPassword, hasSshPassphrase = false) {
      const id = randomUUID();
      const t = now();
      db.prepare(
        `INSERT INTO connections (id, nickname, host, port, user, database, ssl_mode, color, read_only, ssh,
           ssl_root_cert_path, has_password, has_ssh_passphrase, created_at, updated_at)
         VALUES (@id, @nickname, @host, @port, @user, @database, @sslMode, @color, @readOnly, @ssh,
           @sslRootCertPath, @hasPassword, @hasSshPassphrase, @t, @t)`,
      ).run({
        ...connectionParams(config),
        id,
        hasPassword: hasPassword ? 1 : 0,
        hasSshPassphrase: hasSshPassphrase ? 1 : 0,
        t,
      });
      return requireConnection(id);
    },
    updateConnection(id, config, hasPassword, hasSshPassphrase) {
      const existing = requireConnection(id);
      db.prepare(
        `UPDATE connections SET nickname = @nickname, host = @host, port = @port, user = @user, database = @database,
           ssl_mode = @sslMode, color = @color, read_only = @readOnly, ssh = @ssh, ssl_root_cert_path = @sslRootCertPath,
           has_password = @hasPassword, has_ssh_passphrase = @hasSshPassphrase, updated_at = @t
         WHERE id = @id`,
      ).run({
        ...connectionParams(config),
        id,
        hasPassword: hasPassword ? 1 : 0,
        hasSshPassphrase: (hasSshPassphrase ?? existing.hasSshPassphrase) ? 1 : 0,
        t: now(),
      });
      return requireConnection(id);
    },
    deleteConnection(id) {
      db.prepare('DELETE FROM connections WHERE id = ?').run(id);
    },

    getKnownHost(host, port) {
      const row = db.prepare('SELECT fingerprint FROM ssh_known_hosts WHERE host = ? AND port = ?').get(host, port) as
        { fingerprint: string } | undefined;
      return row?.fingerprint ?? null;
    },
    trustKnownHost(host, port, fingerprint) {
      db.prepare(
        `INSERT INTO ssh_known_hosts (host, port, fingerprint, added_at) VALUES (?, ?, ?, ?)
         ON CONFLICT (host, port) DO UPDATE SET fingerprint = excluded.fingerprint, added_at = excluded.added_at`,
      ).run(host, port, fingerprint, now());
    },

    forgetKnownHost(host, port) {
      db.prepare('DELETE FROM ssh_known_hosts WHERE host = ? AND port = ?').run(host, port);
    },

    getWindowState(): WindowState {
      const row = db.prepare('SELECT state FROM window_state WHERE id = 1').get() as { state: string } | undefined;
      const saved = row ? parseJson(row.state, WindowState) : null;
      if (!saved) return structuredClone(emptyWindowState);
      // A favorite deleted since the window was saved has nothing left to reopen.
      const ids = new Set((db.prepare('SELECT id FROM connections').all() as { id: string }[]).map((r) => r.id));
      return {
        servers: saved.servers.filter((server) => ids.has(server.connectionId)),
        activeConnectionId:
          saved.activeConnectionId !== null && ids.has(saved.activeConnectionId) ? saved.activeConnectionId : null,
      };
    },
    saveWindowState(state) {
      db.prepare(
        `INSERT INTO window_state (id, state, updated_at) VALUES (1, ?, ?)
         ON CONFLICT (id) DO UPDATE SET state = excluded.state, updated_at = excluded.updated_at`,
      ).run(JSON.stringify(WindowState.parse(state)), now());
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

    getGridLayout(connectionId, schema, table): GridLayout {
      const row = db
        .prepare('SELECT layout FROM grid_layouts WHERE connection_id = ? AND schema_name = ? AND table_name = ?')
        .get(connectionId, schema, table) as { layout: string } | undefined;
      const saved = row ? GridLayout.safeParse(JSON.parse(row.layout)) : null;
      // A copy: emptyGridLayout itself is shared.
      return saved?.success ? saved.data : structuredClone(emptyGridLayout);
    },
    saveGridLayout(connectionId, schema, table, layout) {
      requireConnection(connectionId);
      db.prepare(
        `INSERT INTO grid_layouts (connection_id, schema_name, table_name, layout, updated_at) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT (connection_id, schema_name, table_name) DO UPDATE SET layout = excluded.layout, updated_at = excluded.updated_at`,
      ).run(connectionId, schema, table, JSON.stringify(layout), now());
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
    searchHistory({ q, connectionId, outcome, limit }) {
      const where: string[] = [];
      const params: unknown[] = [];
      const match = historyMatchExpression(q);
      if (match) {
        where.push('seq IN (SELECT rowid FROM history_fts WHERE history_fts MATCH ?)');
        params.push(match);
      }
      if (connectionId) {
        where.push('connection_id = ?');
        params.push(connectionId);
      }
      if (outcome) where.push(outcomeWhere[outcome]);
      const rows = db
        .prepare(
          `SELECT * FROM history ${where.length > 0 ? `WHERE ${where.join(' AND ')}` : ''}
           ORDER BY ran_at DESC, seq DESC LIMIT ?`,
        )
        .all(...params, Math.min(Math.max(limit, 1), HISTORY_LIMIT)) as HistoryRow[];
      return rows.map(toHistory);
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
        `INSERT INTO saved_queries (id, connection_id, name, sql, chart, param_values, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        id,
        input.connectionId,
        input.name,
        input.sql,
        input.chart ? JSON.stringify(input.chart) : null,
        input.paramValues ? JSON.stringify(input.paramValues) : null,
        t,
        t,
      );
      return requireSavedQuery(id);
    },
    updateSavedQuery(id, input) {
      requireSavedQuery(id);
      // paramValues absent keeps what is stored, so a client that knows nothing of parameters
      // (a rename, a chart change) never wipes them; null clears them.
      db.prepare(
        `UPDATE saved_queries SET connection_id = @connectionId, name = @name, sql = @sql, chart = @chart,
           param_values = CASE WHEN @keepParams = 1 THEN param_values ELSE @paramValues END, updated_at = @t
         WHERE id = @id`,
      ).run({
        id,
        connectionId: input.connectionId,
        name: input.name,
        sql: input.sql,
        chart: input.chart ? JSON.stringify(input.chart) : null,
        keepParams: input.paramValues === undefined ? 1 : 0,
        paramValues: input.paramValues ? JSON.stringify(input.paramValues) : null,
        t: now(),
      });
      return requireSavedQuery(id);
    },
    deleteSavedQuery(id) {
      db.prepare('DELETE FROM saved_queries WHERE id = ?').run(id);
    },

    listSnippets() {
      const rows = db.prepare('SELECT * FROM snippets ORDER BY name COLLATE NOCASE, name').all() as SnippetRow[];
      return rows.map(toSnippet);
    },
    createSnippet(input) {
      const id = randomUUID();
      const t = now();
      db.transaction(() => {
        refuseTakenSnippetName(input.name, null);
        db.prepare('INSERT INTO snippets (id, name, body, created_at, updated_at) VALUES (?, ?, ?, ?, ?)').run(
          id,
          input.name,
          input.body,
          t,
          t,
        );
      })();
      return requireSnippet(id);
    },
    updateSnippet(id, input) {
      db.transaction(() => {
        requireSnippet(id);
        refuseTakenSnippetName(input.name, id);
        db.prepare('UPDATE snippets SET name = ?, body = ?, updated_at = ? WHERE id = ?').run(
          input.name,
          input.body,
          now(),
          id,
        );
      })();
      return requireSnippet(id);
    },
    deleteSnippet(id) {
      db.prepare('DELETE FROM snippets WHERE id = ?').run(id);
    },

    close() {
      db.close();
    },
  };
}
