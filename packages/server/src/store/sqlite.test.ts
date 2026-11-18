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
      expect(store.getLayout('c1', 'public').positions).toEqual({ 'public.orders': { x: 1, y: 2 } });
      expect(store.getGridLayout('c1', 'public', 'orders')).toEqual(emptyGridLayout);
      store.saveGridLayout('c1', 'public', 'orders', { order: ['id'], widths: {} });
      store.close();

      const check = new Database(path);
      expect(check.prepare('SELECT max(version) AS v FROM schema_version').get()).toEqual({ v: 2 });
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
