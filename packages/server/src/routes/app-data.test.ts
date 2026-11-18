import { describe, expect, it } from 'vitest';
import type { HistoryEntry, NewHistoryEntry, SavedQuery, SavedQueryInput } from '@kleos/shared';
import { setup } from './test-utils';

describe('layout routes', () => {
  it('returns an empty layout, then round-trips a saved one', async () => {
    const { call, createConnection } = setup();
    const c = await createConnection();
    const schema = encodeURIComponent('sales data/2026');
    expect((await call('GET', `/layouts/${c.id}/${schema}`)).body).toEqual({ positions: {} });

    const layout = { positions: { 'sales data/2026.orders': { x: 10, y: -4.5 } } };
    const put = await call('PUT', `/layouts/${c.id}/${schema}`, layout);
    expect(put.status).toBe(204);
    expect((await call('GET', `/layouts/${c.id}/${schema}`)).body).toEqual(layout);
    expect((await call('GET', `/layouts/${c.id}/public`)).body).toEqual({ positions: {} });
  });

  it('validates the layout and refuses an unknown favorite', async () => {
    const { call, createConnection } = setup();
    const c = await createConnection();
    expect((await call('PUT', `/layouts/${c.id}/public`, { positions: { a: { x: 'left' } } })).status).toBe(400);
    expect((await call('PUT', '/layouts/nope/public', { positions: {} })).status).toBe(404);
  });
});

describe('history routes', () => {
  const entry = (sql: string, ranAt: string): NewHistoryEntry => ({
    sql,
    kind: 'query',
    ranAt,
    elapsedMs: 5,
    rowCount: 1,
    error: null,
    cancelled: false,
  });

  it('adds entries by hand and lists them newest first with ?limit', async () => {
    const { call, createConnection } = setup();
    const c = await createConnection();
    const added = await call('POST', `/history/${c.id}`, entry('select 1', '2026-11-18T10:00:00.000Z'));
    expect(added.status).toBe(200);
    expect(added.body).toMatchObject({ id: expect.any(String), connectionId: c.id, sql: 'select 1' });
    await call('POST', `/history/${c.id}`, entry('select 2', '2026-11-18T11:00:00.000Z'));
    await call('POST', `/history/${c.id}`, entry('select 3', '2026-11-18T12:00:00.000Z'));

    const all = (await call('GET', `/history/${c.id}`)).body as HistoryEntry[];
    expect(all.map((e) => e.sql)).toEqual(['select 3', 'select 2', 'select 1']);
    const two = (await call('GET', `/history/${c.id}?limit=2`)).body as HistoryEntry[];
    expect(two.map((e) => e.sql)).toEqual(['select 3', 'select 2']);
  });

  it('validates the limit and the entry', async () => {
    const { call, createConnection } = setup();
    const c = await createConnection();
    expect((await call('GET', `/history/${c.id}?limit=1001`)).status).toBe(400);
    expect((await call('GET', `/history/${c.id}?limit=0`)).status).toBe(400);
    expect((await call('GET', `/history/${c.id}?limit=1000`)).status).toBe(200);
    expect((await call('POST', `/history/${c.id}`, { sql: 'select 1' })).status).toBe(400);
    expect((await call('POST', '/history/nope', entry('select 1', '2026-11-18T10:00:00.000Z'))).status).toBe(404);
  });
});

describe('saved query routes', () => {
  it('creates, filters by connection, updates and deletes', async () => {
    const { call, createConnection } = setup();
    const a = await createConnection({ nickname: 'A' });
    const b = await createConnection({ nickname: 'B' });
    const input: SavedQueryInput = {
      connectionId: a.id,
      name: 'Revenue',
      sql: 'select day, sum(total) from orders group by 1',
      chart: { type: 'line', x: 'day', y: ['sum'] },
    };
    const created = await call('POST', '/saved-queries', input);
    expect(created.status).toBe(200);
    const saved = created.body as SavedQuery;
    expect(saved).toMatchObject(input);
    await call('POST', '/saved-queries', { connectionId: b.id, name: 'Other', sql: 'select 1', chart: null });

    expect(
      ((await call('GET', `/saved-queries?connectionId=${a.id}`)).body as SavedQuery[]).map((q) => q.name),
    ).toEqual(['Revenue']);
    expect(((await call('GET', '/saved-queries')).body as SavedQuery[]).map((q) => q.name)).toEqual([
      'Other',
      'Revenue',
    ]);

    const updated = await call('PUT', `/saved-queries/${saved.id}`, { ...input, name: 'Revenue by day', chart: null });
    expect(updated.status).toBe(200);
    expect(updated.body).toMatchObject({ id: saved.id, name: 'Revenue by day', chart: null });

    expect((await call('DELETE', `/saved-queries/${saved.id}`)).status).toBe(204);
    expect((await call('GET', `/saved-queries?connectionId=${a.id}`)).body).toEqual([]);
  });

  it('validates input and answers 404 for unknown ids', async () => {
    const { call, createConnection } = setup();
    const c = await createConnection();
    expect((await call('POST', '/saved-queries', { connectionId: c.id, name: ' ', sql: '', chart: null })).status).toBe(
      400,
    );
    expect(
      (
        await call('POST', '/saved-queries', {
          connectionId: c.id,
          name: 'x',
          sql: '',
          chart: { type: 'pie', x: 'a', y: ['b'] },
        })
      ).status,
    ).toBe(400);
    expect(
      (await call('PUT', '/saved-queries/nope', { connectionId: c.id, name: 'x', sql: '', chart: null })).status,
    ).toBe(404);
  });
});
