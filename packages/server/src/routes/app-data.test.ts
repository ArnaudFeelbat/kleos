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

describe('grid layout routes', () => {
  it('returns the empty layout, then round-trips a saved one per table', async () => {
    const { call, createConnection } = setup();
    const c = await createConnection();
    const schema = encodeURIComponent('sales data/2026');
    const table = encodeURIComponent('order items.v2');
    expect((await call('GET', `/grid-layouts/${c.id}/${schema}/${table}`)).body).toEqual({ order: [], widths: {} });

    const layout = { order: ['total', 'id'], widths: { total: 180, 'unit price': 96 } };
    const put = await call('PUT', `/grid-layouts/${c.id}/${schema}/${table}`, layout);
    expect(put.status).toBe(204);
    expect(put.body).toBeNull();
    expect((await call('GET', `/grid-layouts/${c.id}/${schema}/${table}`)).body).toEqual(layout);
    expect((await call('GET', `/grid-layouts/${c.id}/${schema}/orders`)).body).toEqual({ order: [], widths: {} });
    expect((await call('GET', `/grid-layouts/${c.id}/public/${table}`)).body).toEqual({ order: [], widths: {} });

    // A second save replaces the first.
    await call('PUT', `/grid-layouts/${c.id}/${schema}/${table}`, { order: [], widths: { id: 40 } });
    expect((await call('GET', `/grid-layouts/${c.id}/${schema}/${table}`)).body).toEqual({
      order: [],
      widths: { id: 40 },
    });
  });

  it('validates the layout with the shared schema and refuses an unknown favorite', async () => {
    const { call, createConnection } = setup();
    const c = await createConnection();
    const path = `/grid-layouts/${c.id}/public/orders`;
    expect((await call('PUT', path, { order: ['id'] })).status).toBe(400);
    expect((await call('PUT', path, { order: ['id'], widths: { id: 39 } })).status).toBe(400);
    expect((await call('PUT', path, { order: ['id'], widths: { id: 2001 } })).status).toBe(400);
    expect((await call('PUT', path, { order: ['id'], widths: { id: 120.5 } })).status).toBe(400);
    expect((await call('PUT', path, { order: 'id', widths: {} })).status).toBe(400);
    expect((await call('PUT', path, 'not json')).status).toBe(400);
    expect((await call('GET', path)).body).toEqual({ order: [], widths: {} });
    const unknown = await call('PUT', '/grid-layouts/nope/public/orders', { order: [], widths: {} });
    expect(unknown.status).toBe(404);
    expect((unknown.body as { code: string }).code).toBe('KLEOS_NOT_FOUND');
  });

  it('forgets the layouts of a deleted favorite', async () => {
    const { call, createConnection } = setup();
    const c = await createConnection();
    await call('PUT', `/grid-layouts/${c.id}/public/orders`, { order: ['id'], widths: {} });
    expect((await call('DELETE', `/connections/${c.id}`)).status).toBe(204);
    expect((await call('GET', `/grid-layouts/${c.id}/public/orders`)).body).toEqual({ order: [], widths: {} });
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

  it('searches across servers with ?q, ?connectionId, ?outcome and ?limit', async () => {
    const { call, createConnection } = setup();
    const a = await createConnection({ nickname: 'A' });
    const b = await createConnection({ nickname: 'B' });
    await call('POST', `/history/${a.id}`, entry('select * from orders', '2026-11-18T10:00:00.000Z'));
    await call('POST', `/history/${b.id}`, {
      ...entry('select o.stauts from orders o', '2026-11-18T11:00:00.000Z'),
      error: '42703 column o.stauts does not exist',
    });
    await call('POST', `/history/${b.id}`, {
      ...entry('select pg_sleep(60)', '2026-11-18T12:00:00.000Z'),
      error: '57014 canceling statement due to user request',
      cancelled: true,
    });
    const search = async (qs: string) => {
      const res = await call('GET', `/history?${qs}`);
      expect(res.status).toBe(200);
      return (res.body as HistoryEntry[]).map((e) => e.sql);
    };

    expect(await search('')).toEqual(['select pg_sleep(60)', 'select o.stauts from orders o', 'select * from orders']);
    expect(await search('q=ORD')).toEqual(['select o.stauts from orders o', 'select * from orders']);
    expect(await search(`q=${encodeURIComponent('o.stauts "does')}`)).toEqual(['select o.stauts from orders o']);
    expect(await search(`q=orders&connectionId=${a.id}`)).toEqual(['select * from orders']);
    expect(await search('outcome=ok')).toEqual(['select * from orders']);
    expect(await search('outcome=error')).toEqual(['select o.stauts from orders o']);
    expect(await search('outcome=cancelled')).toEqual(['select pg_sleep(60)']);
    expect(await search('limit=1')).toEqual(['select pg_sleep(60)']);
    // Empty values are "no filter", as the web client may send them.
    expect(await search('q=&connectionId=')).toHaveLength(3);
    // The per-favorite list is still its own route.
    expect(((await call('GET', `/history/${a.id}`)).body as HistoryEntry[]).map((e) => e.sql)).toEqual([
      'select * from orders',
    ]);

    // Deleting a favorite takes its runs out of the search.
    expect((await call('DELETE', `/connections/${b.id}`)).status).toBe(204);
    expect(await search('q=select')).toEqual(['select * from orders']);
  });

  it('validates the search', async () => {
    const { call } = setup();
    expect((await call('GET', '/history?outcome=failed')).status).toBe(400);
    expect((await call('GET', '/history?limit=0')).status).toBe(400);
    expect((await call('GET', '/history?limit=1001')).status).toBe(400);
    expect((await call('GET', `/history?q=${'x'.repeat(501)}`)).status).toBe(400);
    expect((await call('GET', '/history?limit=1000')).status).toBe(200);
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

  it('remembers parameter values: absent keeps them, null clears them, an object replaces them', async () => {
    const { call, createConnection } = setup();
    const c = await createConnection();
    const input: SavedQueryInput = {
      connectionId: c.id,
      name: 'Orders of a customer',
      sql: 'select * from orders where customer_id = :customer and status = $2',
      chart: null,
    };
    const created = (await call('POST', '/saved-queries', input)).body as SavedQuery;
    expect(created.paramValues).toBeNull();

    const put = async (body: unknown) => {
      const res = await call('PUT', `/saved-queries/${created.id}`, body);
      expect(res.status).toBe(200);
      return (res.body as SavedQuery).paramValues;
    };
    expect(await put({ ...input, paramValues: { ':customer': '42', $2: null } })).toEqual({
      ':customer': '42',
      $2: null,
    });
    expect(await put({ ...input, name: 'Renamed' })).toEqual({ ':customer': '42', $2: null });
    const [listed] = (await call('GET', `/saved-queries?connectionId=${c.id}`)).body as SavedQuery[];
    expect(listed).toMatchObject({ name: 'Renamed', paramValues: { ':customer': '42', $2: null } });
    expect(await put({ ...input, paramValues: { ':customer': '7' } })).toEqual({ ':customer': '7' });
    expect(await put({ ...input, paramValues: null })).toBeNull();

    const withValues = await call('POST', '/saved-queries', { ...input, name: 'Again', paramValues: { $1: 'x' } });
    expect((withValues.body as SavedQuery).paramValues).toEqual({ $1: 'x' });
    expect((await call('POST', '/saved-queries', { ...input, paramValues: { $1: 5 } })).status).toBe(400);
    expect((await call('PUT', `/saved-queries/${created.id}`, { ...input, paramValues: ['x'] })).status).toBe(400);
  });
});
