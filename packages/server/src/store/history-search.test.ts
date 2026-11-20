import { afterEach, describe, expect, it } from 'vitest';
import type { ConnectionConfig, NewHistoryEntry } from '@kleos/shared';
import { historyMatchExpression } from './history-search';
import { createSqliteStore } from './sqlite';
import type { AppStore } from './types';

const config = (nickname: string): ConnectionConfig => ({
  nickname,
  host: 'localhost',
  port: 5432,
  user: 'kleos',
  database: nickname,
  sslMode: 'prefer',
  color: 'none',
  readOnly: false,
});

let store: AppStore | null = null;
afterEach(() => {
  store?.close();
  store = null;
});

let clock = Date.parse('2026-11-18T00:00:00Z');
function run(sql: string, outcome: Partial<NewHistoryEntry> = {}): NewHistoryEntry {
  clock += 1000;
  return {
    sql,
    kind: 'query',
    ranAt: new Date(clock).toISOString(),
    elapsedMs: 3,
    rowCount: 1,
    error: null,
    cancelled: false,
    ...outcome,
  };
}

/** Two servers with a few runs each, oldest first. */
function seeded() {
  const s = createSqliteStore(':memory:');
  store = s;
  const shop = s.createConnection(config('shop'), false);
  const crm = s.createConnection(config('crm'), false);
  s.addHistory(shop.id, run('select * from shop.orders where status = $1'));
  s.addHistory(shop.id, run('select o.stauts from shop.orders o', { error: '42703 column o.stauts does not exist' }));
  s.addHistory(crm.id, run('SELECT count(*) FROM crm.Customers'));
  s.addHistory(
    crm.id,
    run('select pg_sleep(60)', { error: '57014 canceling statement due to user request', cancelled: true }),
  );
  s.addHistory(shop.id, run(`update shop.orders set note = 'Café "it''s"' where id = 1`));
  return { store: s, shop, crm };
}

const sqls = (entries: { sql: string }[]) => entries.map((e) => e.sql);

describe('historyMatchExpression', () => {
  it('quotes every word as a prefix phrase and drops words with nothing to match', () => {
    expect(historyMatchExpression(undefined)).toBeNull();
    expect(historyMatchExpression('   ')).toBeNull();
    expect(historyMatchExpression('; -- *')).toBeNull();
    expect(historyMatchExpression('orders stat')).toBe('"orders"* "stat"*');
    expect(historyMatchExpression('o.stauts "x" NEAR(a b)')).toBe('"o.stauts"* """x"""* "NEAR(a"* "b)"*');
  });
});

describe('searchHistory', () => {
  it('matches every word as a prefix, ignoring case, in the SQL or the error text', () => {
    const { store: s } = seeded();
    expect(sqls(s.searchHistory({ q: 'ORDERS', limit: 200 }))).toEqual([
      `update shop.orders set note = 'Café "it''s"' where id = 1`,
      'select o.stauts from shop.orders o',
      'select * from shop.orders where status = $1',
    ]);
    // Both words must match; "stat" is a prefix of "status" and "stauts" is not.
    expect(sqls(s.searchHistory({ q: 'ord stat', limit: 200 }))).toEqual([
      'select * from shop.orders where status = $1',
    ]);
    // The error text is searched too, its SQLSTATE included.
    expect(sqls(s.searchHistory({ q: 'does not exist', limit: 200 }))).toEqual(['select o.stauts from shop.orders o']);
    expect(sqls(s.searchHistory({ q: '42703', limit: 200 }))).toEqual(['select o.stauts from shop.orders o']);
    expect(sqls(s.searchHistory({ q: 'customers', limit: 200 }))).toEqual(['SELECT count(*) FROM crm.Customers']);
    // Accents fold too.
    expect(sqls(s.searchHistory({ q: 'cafe', limit: 200 }))).toHaveLength(1);
    expect(s.searchHistory({ q: 'nothing like this', limit: 200 })).toEqual([]);
  });

  it('treats quotes, punctuation and FTS syntax in q as plain text', () => {
    const { store: s } = seeded();
    expect(sqls(s.searchHistory({ q: 'o.stauts', limit: 200 }))).toEqual(['select o.stauts from shop.orders o']);
    expect(sqls(s.searchHistory({ q: '"it\'s"', limit: 200 }))).toHaveLength(1);
    expect(sqls(s.searchHistory({ q: 'status = $1', limit: 200 }))).toEqual([
      'select * from shop.orders where status = $1',
    ]);
    for (const q of ['"', "'", 'AND', 'NOT orders', 'sql:orders', 'NEAR(orders', '*', '(', '^orders', 'orders AND']) {
      expect(() => s.searchHistory({ q, limit: 200 })).not.toThrow();
    }
    // FTS keywords are words to find, not operators: "not" prefixes "note" and the "not" of an error.
    expect(s.searchHistory({ q: 'orders AND', limit: 200 })).toEqual([]);
    expect(sqls(s.searchHistory({ q: 'NOT orders', limit: 200 }))).toEqual([
      `update shop.orders set note = 'Café "it''s"' where id = 1`,
      'select o.stauts from shop.orders o',
    ]);
    // Nothing searchable left: every run, newest first.
    expect(s.searchHistory({ q: '--', limit: 200 })).toHaveLength(5);
  });

  it('filters by outcome', () => {
    const { store: s } = seeded();
    expect(sqls(s.searchHistory({ outcome: 'ok', limit: 200 }))).toEqual([
      `update shop.orders set note = 'Café "it''s"' where id = 1`,
      'SELECT count(*) FROM crm.Customers',
      'select * from shop.orders where status = $1',
    ]);
    // Outcomes are exclusive: a cancelled run carries its 57014 error but counts as cancelled.
    expect(sqls(s.searchHistory({ outcome: 'error', limit: 200 }))).toEqual(['select o.stauts from shop.orders o']);
    expect(sqls(s.searchHistory({ outcome: 'cancelled', limit: 200 }))).toEqual(['select pg_sleep(60)']);
    expect(sqls(s.searchHistory({ q: 'orders', outcome: 'error', limit: 200 }))).toEqual([
      'select o.stauts from shop.orders o',
    ]);
  });

  it('searches across servers unless one is named, newest first, up to the limit', () => {
    const { store: s, shop, crm } = seeded();
    const all = s.searchHistory({ q: 'select', limit: 200 });
    expect(new Set(all.map((e) => e.connectionId))).toEqual(new Set([shop.id, crm.id]));
    expect(all.map((e) => e.ranAt)).toEqual([...all.map((e) => e.ranAt)].sort().reverse());
    expect(sqls(s.searchHistory({ q: 'select', connectionId: crm.id, limit: 200 }))).toEqual([
      'select pg_sleep(60)',
      'SELECT count(*) FROM crm.Customers',
    ]);
    expect(sqls(s.searchHistory({ limit: 2 }))).toEqual([
      `update shop.orders set note = 'Café "it''s"' where id = 1`,
      'select pg_sleep(60)',
    ]);
    expect(s.searchHistory({ connectionId: 'unknown', limit: 200 })).toEqual([]);
  });

  it('forgets the runs of a deleted favorite and the ones trimmed past 1,000', () => {
    const { store: s, shop, crm } = seeded();
    s.deleteConnection(shop.id);
    expect(s.searchHistory({ q: 'orders', limit: 200 })).toEqual([]);
    expect(sqls(s.searchHistory({ limit: 200 }))).toEqual([
      'select pg_sleep(60)',
      'SELECT count(*) FROM crm.Customers',
    ]);

    for (let i = 0; i < 1001; i += 1) s.addHistory(crm.id, run(`select ${i} as marker${i}`));
    expect(s.searchHistory({ q: 'customers', limit: 200 })).toEqual([]);
    expect(s.searchHistory({ q: 'marker0', limit: 200 })).toEqual([]);
    expect(sqls(s.searchHistory({ q: 'marker1000', limit: 200 }))).toEqual(['select 1000 as marker1000']);
    expect(s.searchHistory({ q: 'select', connectionId: crm.id, limit: 1000 })).toHaveLength(1000);
  });
});
