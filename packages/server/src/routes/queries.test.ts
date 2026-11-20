import { describe, expect, it, vi } from 'vitest';
import type { HistoryEntry } from '@kleos/shared';
import { KleosError } from '../errors';
import { pgError, setup } from './test-utils';

const run = { qid: 'q1', sql: 'select 1', tabId: 't1' };

describe('query routes', () => {
  it('starts a query with the default page size and records it in history', async () => {
    const { call, openSession } = setup();
    const { sid, session, connection } = await openSession();
    const res = await call('POST', `/sessions/${sid}/queries`, run);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ qid: 'q1', rows: [['x']], hasMore: true, rowCount: 1, elapsedMs: 12 });
    expect(session.callsTo('runQuery')).toEqual([['select 1', { qid: 'q1', tabId: 't1', pageSize: 500 }]]);

    const history = (await call('GET', `/history/${connection.id}`)).body as HistoryEntry[];
    expect(history).toHaveLength(1);
    expect(history[0]).toMatchObject({
      connectionId: connection.id,
      sql: 'select 1',
      kind: 'query',
      elapsedMs: 12,
      rowCount: 1,
      error: null,
      cancelled: false,
    });
    expect(Number.isNaN(Date.parse(history[0]!.ranAt))).toBe(false);
  });

  it('passes an explicit page size and validates it', async () => {
    const { call, openSession } = setup();
    const { sid, session } = await openSession();
    await call('POST', `/sessions/${sid}/queries`, { ...run, pageSize: 50 });
    expect(session.callsTo('runQuery')[0]?.[1]).toMatchObject({ pageSize: 50 });
    expect((await call('POST', `/sessions/${sid}/queries`, { ...run, pageSize: 5001 })).status).toBe(400);
    expect((await call('POST', `/sessions/${sid}/queries`, { ...run, sql: '' })).status).toBe(400);
    expect(session.callsTo('runQuery')).toHaveLength(1);
  });

  it('records a failed query with its SQLSTATE and still returns the error with its position', async () => {
    const { call, openSession } = setup();
    const { sid, session, connection } = await openSession();
    session.errors.set('runQuery', pgError('42703', 'column o.stauts does not exist', { position: '8' }));
    const res = await call('POST', `/sessions/${sid}/queries`, { ...run, sql: 'select o.stauts from orders o' });
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ code: '42703', message: 'column o.stauts does not exist', position: 8 });

    const [entry] = (await call('GET', `/history/${connection.id}`)).body as HistoryEntry[];
    expect(entry).toMatchObject({
      sql: 'select o.stauts from orders o',
      kind: 'query',
      rowCount: null,
      error: '42703 column o.stauts does not exist',
      cancelled: false,
    });
    expect(entry?.elapsedMs).toEqual(expect.any(Number));
  });

  it('marks a query cancelled (57014) in history', async () => {
    const { call, openSession } = setup();
    const { sid, session, connection } = await openSession();
    session.errors.set('runQuery', pgError('57014', 'canceling statement due to user request'));
    const res = await call('POST', `/sessions/${sid}/queries`, { ...run, sql: 'select pg_sleep(60)' });
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ code: '57014' });
    const [entry] = (await call('GET', `/history/${connection.id}`)).body as HistoryEntry[];
    expect(entry).toMatchObject({ error: '57014 canceling statement due to user request', cancelled: true });
  });

  it('never lets a failing history write mask the query result or error', async () => {
    const { call, openSession, store } = setup();
    const { sid, session } = await openSession();
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    store.addHistory = () => {
      throw new Error('disk full');
    };
    try {
      expect((await call('POST', `/sessions/${sid}/queries`, run)).status).toBe(200);
      session.errors.set('runQuery', pgError('42601', 'syntax error at or near "selec"', { position: '1' }));
      const failed = await call('POST', `/sessions/${sid}/queries`, { ...run, sql: 'selec 1' });
      expect(failed.status).toBe(400);
      expect(failed.body).toEqual({ code: '42601', message: 'syntax error at or near "selec"', position: 1 });
      expect(log).toHaveBeenCalledWith('[kleos] could not record history', expect.any(Error));
    } finally {
      log.mockRestore();
    }
  });

  it('pages with ?size= (default 500, max 5000)', async () => {
    const { call, openSession } = setup();
    const { sid, session } = await openSession();
    const page = await call('GET', `/sessions/${sid}/queries/q1/page`);
    expect(page.status).toBe(200);
    expect(page.body).toEqual({ rows: [['y']], hasMore: false, elapsedMs: 2 });
    await call('GET', `/sessions/${sid}/queries/q1/page?size=1000`);
    expect(session.callsTo('nextPage')).toEqual([
      ['q1', 500],
      ['q1', 1000],
    ]);
    for (const size of ['0', '5001', 'abc', '1.5']) {
      const res = await call('GET', `/sessions/${sid}/queries/q1/page?size=${size}`);
      expect({ size, status: res.status }).toEqual({ size, status: 400 });
    }
    expect(session.callsTo('nextPage')).toHaveLength(2);
  });

  it('cancels a query and closes its cursor with 204', async () => {
    const { call, openSession } = setup();
    const { sid, session } = await openSession();
    const cancel = await call('POST', `/sessions/${sid}/queries/q1/cancel`);
    expect(cancel.status).toBe(204);
    expect(cancel.body).toBeNull();
    const close = await call('DELETE', `/sessions/${sid}/queries/q1`);
    expect(close.status).toBe(204);
    expect(session.callsTo('cancelQuery')).toEqual([['q1']]);
    expect(session.callsTo('closeQuery')).toEqual([['q1']]);
  });

  it('passes a session error on paging through untouched', async () => {
    const { call, openSession } = setup();
    const { sid, session } = await openSession();
    session.errors.set('nextPage', new KleosError(404, { code: 'KLEOS_QUERY_NOT_FOUND', message: 'No such query' }));
    const res = await call('GET', `/sessions/${sid}/queries/zz/page`);
    expect(res.status).toBe(404);
    expect(res.body).toEqual({ code: 'KLEOS_QUERY_NOT_FOUND', message: 'No such query' });
  });

  it('explains a statement and records it as kind explain', async () => {
    const { call, openSession } = setup();
    const { sid, session, connection } = await openSession();
    const res = await call('POST', `/sessions/${sid}/explain`, run);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ plan: { 'Node Type': 'Seq Scan' }, executionMs: 1.5 });
    expect(session.callsTo('explain')).toEqual([['select 1', { qid: 'q1', tabId: 't1' }]]);
    const [entry] = (await call('GET', `/history/${connection.id}`)).body as HistoryEntry[];
    expect(entry).toMatchObject({ kind: 'explain', sql: 'select 1', rowCount: null, error: null, cancelled: false });
  });

  it('records a failed explain and returns its error', async () => {
    const { call, openSession } = setup();
    const { sid, session, connection } = await openSession();
    session.errors.set('explain', pgError('42P01', 'relation "nope" does not exist', { position: '15' }));
    const res = await call('POST', `/sessions/${sid}/explain`, { ...run, sql: 'select * from nope' });
    expect(res.body).toEqual({ code: '42P01', message: 'relation "nope" does not exist', position: 15 });
    const [entry] = (await call('GET', `/history/${connection.id}`)).body as HistoryEntry[];
    expect(entry).toMatchObject({ kind: 'explain', error: '42P01 relation "nope" does not exist' });
  });

  it('releases a query tab with 204', async () => {
    const { call, openSession } = setup();
    const { sid, session } = await openSession();
    expect((await call('DELETE', `/sessions/${sid}/tabs/tab-7`)).status).toBe(204);
    expect(session.callsTo('closeTab')).toEqual([['tab-7']]);
  });

  it('passes bind values to the query and to explain, and validates them', async () => {
    const { call, openSession } = setup();
    const { sid, session, connection } = await openSession();
    const sql = 'select * from orders where id = $1 and note is not distinct from $2';
    const params = ['42', null];
    expect((await call('POST', `/sessions/${sid}/queries`, { ...run, sql, params })).status).toBe(200);
    expect(session.callsTo('runQuery')).toEqual([[sql, { qid: 'q1', tabId: 't1', pageSize: 500, params }]]);
    expect((await call('POST', `/sessions/${sid}/explain`, { ...run, qid: 'q2', sql, params })).status).toBe(200);
    expect(session.callsTo('explain')).toEqual([[sql, { qid: 'q2', tabId: 't1', params }]]);
    // History keeps the statement as typed, never the values.
    const history = (await call('GET', `/history/${connection.id}`)).body as HistoryEntry[];
    expect(history.map((e) => e.sql)).toEqual([sql, sql]);

    expect((await call('POST', `/sessions/${sid}/queries`, { ...run, params: [42] })).status).toBe(400);
    expect((await call('POST', `/sessions/${sid}/queries`, { ...run, params: 'x' })).status).toBe(400);
    expect((await call('POST', `/sessions/${sid}/explain`, { ...run, params: Array(101).fill('1') })).status).toBe(400);
    expect(session.callsTo('runQuery')).toHaveLength(1);
    expect(session.callsTo('explain')).toHaveLength(1);
  });
});

describe('monitoring routes', () => {
  it('returns one stats snapshot for a valid kind', async () => {
    const { call, openSession } = setup();
    const { sid, session } = await openSession();
    const res = await call('GET', `/sessions/${sid}/stats/tables`);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ kind: 'tables', tables: [] });
    expect(session.callsTo('stats')).toEqual([['tables']]);
  });

  it('rejects an unknown stats kind', async () => {
    const { call, openSession } = setup();
    const { sid, session } = await openSession();
    const res = await call('GET', `/sessions/${sid}/stats/vacuum`);
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ code: 'KLEOS_VALIDATION' });
    expect(session.callsTo('stats')).toEqual([]);
  });

  it('cancels or terminates a backend', async () => {
    const { call, openSession } = setup();
    const { sid, session } = await openSession();
    const res = await call('POST', `/sessions/${sid}/backends/4242/cancel`, { mode: 'terminate' });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });
    expect(session.callsTo('backendAction')).toEqual([[4242, 'terminate']]);
  });

  it('validates the backend pid and mode', async () => {
    const { call, openSession } = setup();
    const { sid, session } = await openSession();
    expect((await call('POST', `/sessions/${sid}/backends/abc/cancel`, { mode: 'cancel' })).status).toBe(400);
    expect((await call('POST', `/sessions/${sid}/backends/-1/cancel`, { mode: 'cancel' })).status).toBe(400);
    expect((await call('POST', `/sessions/${sid}/backends/12/cancel`, { mode: 'kill' })).status).toBe(400);
    expect(session.callsTo('backendAction')).toEqual([]);
  });
});
