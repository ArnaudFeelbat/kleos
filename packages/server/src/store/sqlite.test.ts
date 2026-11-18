import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { ConnectionConfig } from '@kleos/shared';
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
