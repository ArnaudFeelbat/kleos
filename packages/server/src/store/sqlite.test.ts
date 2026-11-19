import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';
import { type ConnectionConfig, emptyGridLayout } from '@kleos/shared';
import { KleosError } from '../errors';
import { migrations } from './migrations';
import { createSqliteStore } from './sqlite';
import type { AppStore } from './types';

const config: ConnectionConfig = {
  nickname: 'shop_dev',
  host: 'localhost',
  port: 5432,
  user: 'kleos',
  database: 'shop_dev',
  sslMode: 'prefer',
  color: 'none',
  readOnly: false,
};

let store: AppStore | null = null;
afterEach(() => {
  store?.close();
  store = null;
});

describe('sqlite app store', () => {
  it('creates, updates, lists and deletes favorites', () => {
    store = createSqliteStore(':memory:');
    const created = store.createConnection(config, true);
    expect(created).toMatchObject({ ...config, hasPassword: true });
    const updated = store.updateConnection(created.id, { ...config, color: 'red', readOnly: true }, false);
    expect(updated).toMatchObject({ color: 'red', readOnly: true, hasPassword: false });
    expect(store.listConnections()).toHaveLength(1);
    store.deleteConnection(created.id);
    expect(store.listConnections()).toEqual([]);
  });

  it('stores the SSH tunnel, CA path and passphrase flag, null when absent', () => {
    store = createSqliteStore(':memory:');
    const plain = store.createConnection(config, false);
    expect(plain).toMatchObject({ ssh: null, sslRootCertPath: null, hasSshPassphrase: false });

    const ssh = { host: 'bastion.example.com', port: 22, user: 'deploy', auth: 'key' as const, keyPath: '~/.ssh/id' };
    const tunneled = store.createConnection({ ...config, ssh, sslRootCertPath: '~/ca.pem' }, false, true);
    expect(tunneled).toMatchObject({ ssh, sslRootCertPath: '~/ca.pem', hasSshPassphrase: true });

    // Undefined keeps the passphrase flag; an explicit value replaces it.
    const kept = store.updateConnection(
      tunneled.id,
      { ...config, ssh: { ...ssh, auth: 'agent', keyPath: null } },
      false,
    );
    expect(kept).toMatchObject({
      ssh: { auth: 'agent', keyPath: null },
      sslRootCertPath: null,
      hasSshPassphrase: true,
    });
    expect(store.updateConnection(tunneled.id, config, false, false)).toMatchObject({
      ssh: null,
      hasSshPassphrase: false,
    });
  });

  it('remembers one trusted SSH host key per host and port', () => {
    store = createSqliteStore(':memory:');
    expect(store.getKnownHost('bastion', 22)).toBeNull();
    store.trustKnownHost('bastion', 22, 'SHA256:aaa');
    store.trustKnownHost('bastion', 2222, 'SHA256:bbb');
    expect(store.getKnownHost('bastion', 22)).toBe('SHA256:aaa');
    expect(store.getKnownHost('bastion', 2222)).toBe('SHA256:bbb');
    store.trustKnownHost('bastion', 22, 'SHA256:ccc');
    expect(store.getKnownHost('bastion', 22)).toBe('SHA256:ccc');
  });

  it('saves the window state and drops servers of deleted favorites when read back', () => {
    store = createSqliteStore(':memory:');
    expect(store.getWindowState()).toEqual({ servers: [], activeConnectionId: null });
    const a = store.createConnection(config, false);
    const b = store.createConnection({ ...config, nickname: 'b' }, false);
    const server = (connectionId: string) => ({
      connectionId,
      queryTabs: [{ title: 'Query 1', sql: 'select 1', chart: null, savedQueryId: null }],
      activeQueryTab: 0,
      workspaceTab: 'query' as const,
    });
    store.saveWindowState({ servers: [server(a.id), server(b.id)], activeConnectionId: b.id });
    expect(store.getWindowState()).toEqual({ servers: [server(a.id), server(b.id)], activeConnectionId: b.id });

    store.deleteConnection(b.id);
    expect(store.getWindowState()).toEqual({ servers: [server(a.id)], activeConnectionId: null });
  });

  it('keeps only the latest 1,000 history entries per connection, newest first', () => {
    store = createSqliteStore(':memory:');
    const { id } = store.createConnection(config, false);
    const base = Date.parse('2026-11-18T00:00:00Z');
    for (let i = 0; i < 1005; i += 1) {
      store.addHistory(id, {
        sql: `select ${i}`,
        kind: 'query',
        ranAt: new Date(base + i * 1000).toISOString(),
        elapsedMs: 1,
        rowCount: 1,
        error: null,
        cancelled: false,
      });
    }
    const history = store.listHistory(id, 5000);
    expect(history).toHaveLength(1000);
    expect(history[0]?.sql).toBe('select 1004');
    expect(history.at(-1)?.sql).toBe('select 5');
  });

  it('round-trips layouts and saved queries, and cascades on delete', () => {
    store = createSqliteStore(':memory:');
    const { id } = store.createConnection(config, false);
    store.saveLayout(id, 'public', { positions: { 'public.orders': { x: 312, y: 40 } } });
    expect(store.getLayout(id, 'public').positions['public.orders']).toEqual({ x: 312, y: 40 });
    const saved = store.createSavedQuery({
      connectionId: id,
      name: 'revenue by channel',
      sql: 'select 1',
      chart: { type: 'line', x: 'day', y: ['web', 'ios'] },
    });
    expect(store.listSavedQueries(id)[0]?.chart).toEqual({ type: 'line', x: 'day', y: ['web', 'ios'] });
    store.deleteConnection(id);
    expect(store.getSavedQuery(saved.id)).toBeNull();
    expect(store.getLayout(id, 'public').positions).toEqual({});
  });

  it('round-trips grid layouts per table, replaces them, and cascades on delete', () => {
    store = createSqliteStore(':memory:');
    const { id } = store.createConnection(config, false);
    const other = store.createConnection({ ...config, nickname: 'other' }, false);
    expect(store.getGridLayout(id, 'public', 'orders')).toEqual(emptyGridLayout);

    const layout = { order: ['total', 'id'], widths: { total: 180, note: 320 } };
    store.saveGridLayout(id, 'public', 'orders', layout);
    expect(store.getGridLayout(id, 'public', 'orders')).toEqual(layout);
    // Keyed by connection, schema and table.
    expect(store.getGridLayout(id, 'public', 'customers')).toEqual(emptyGridLayout);
    expect(store.getGridLayout(id, 'sales', 'orders')).toEqual(emptyGridLayout);
    expect(store.getGridLayout(other.id, 'public', 'orders')).toEqual(emptyGridLayout);

    store.saveGridLayout(id, 'public', 'orders', { order: [], widths: { id: 60 } });
    expect(store.getGridLayout(id, 'public', 'orders')).toEqual({ order: [], widths: { id: 60 } });

    // The empty layout handed out is a copy, never the shared constant.
    store.getGridLayout(id, 'x', 'y').order.push('mutated');
    expect(emptyGridLayout.order).toEqual([]);

    store.saveGridLayout(other.id, 'public', 'orders', layout);
    store.deleteConnection(id);
    expect(store.getGridLayout(id, 'public', 'orders')).toEqual(emptyGridLayout);
    expect(store.getGridLayout(other.id, 'public', 'orders')).toEqual(layout);
  });

  it('refuses a grid layout for an unknown connection with a 404', () => {
    store = createSqliteStore(':memory:');
    let err: unknown;
    try {
      store.saveGridLayout('nope', 'public', 'orders', { order: [], widths: {} });
    } catch (caught) {
      err = caught;
    }
    expect(err).toBeInstanceOf(KleosError);
    expect((err as KleosError).status).toBe(404);
  });

  it('migrates a version 1 database, keeping its data', () => {
    const dir = mkdtempSync(join(tmpdir(), 'kleos-store-v1-'));
    try {
      const path = join(dir, 'app.db');
      // A database as 0.2 left it: only migration 1 applied, with a favorite and a layout.
      const v1 = new Database(path);
      v1.exec('CREATE TABLE schema_version (version INTEGER NOT NULL)');
      v1.exec(migrations.find((m) => m.version === 1)!.sql);
      v1.prepare('INSERT INTO schema_version (version) VALUES (1)').run();
      v1.prepare(
        `INSERT INTO connections (id, nickname, host, port, user, database, ssl_mode, color, read_only, has_password, created_at, updated_at)
         VALUES ('c1', 'shop_dev', 'localhost', 5432, 'kleos', 'shop_dev', 'prefer', 'none', 0, 0, 't', 't')`,
      ).run();
      v1.prepare(`INSERT INTO layouts VALUES ('c1', 'public', '{"public.orders":{"x":1,"y":2}}', 't')`).run();
      v1.close();

      store = createSqliteStore(path);
      expect(store.listConnections().map((c) => c.id)).toEqual(['c1']);
      // 0.4 columns arrive empty on an older favorite.
      expect(store.getConnection('c1')).toMatchObject({ ssh: null, sslRootCertPath: null, hasSshPassphrase: false });
      expect(store.getLayout('c1', 'public').positions).toEqual({ 'public.orders': { x: 1, y: 2 } });
      expect(store.getGridLayout('c1', 'public', 'orders')).toEqual(emptyGridLayout);
      store.saveGridLayout('c1', 'public', 'orders', { order: ['id'], widths: {} });
      store.close();

      const check = new Database(path);
      expect(check.prepare('SELECT max(version) AS v FROM schema_version').get()).toEqual({
        v: migrations.at(-1)!.version,
      });
      check.close();
      store = createSqliteStore(path);
      expect(store.getGridLayout('c1', 'public', 'orders')).toEqual({ order: ['id'], widths: {} });
      store.deleteConnection('c1');
      expect(store.getGridLayout('c1', 'public', 'orders')).toEqual(emptyGridLayout);
    } finally {
      store?.close();
      store = null;
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('applies migrations once across reopenings', () => {
    const dir = mkdtempSync(join(tmpdir(), 'kleos-store-'));
    try {
      const path = join(dir, 'app.db');
      createSqliteStore(path).close();
      store = createSqliteStore(path);
      expect(store.listConnections()).toEqual([]);
    } finally {
      store?.close();
      store = null;
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
