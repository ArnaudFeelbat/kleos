import { describe, expect, it } from 'vitest';
import type { CountRequest, RowsRequest, SessionInfo } from '@kleos/shared';
import { KleosError } from '../errors';
import { pgError, setup } from './test-utils';

const table = { schema: 'public', name: 'orders' };

describe('opening and closing sessions', () => {
  it("connects with the favorite's Keychain password and returns SessionInfo", async () => {
    const { call, adapter, createConnection } = setup();
    const c = await createConnection({ password: 'stored', savePassword: true });
    const res = await call('POST', '/sessions', { connectionId: c.id });
    expect(res.status).toBe(200);
    const info = res.body as SessionInfo;
    expect(info).toMatchObject({
      connection: c,
      serverVersion: 'PostgreSQL 16.4 on aarch64-apple-darwin',
      serverVersionShort: '16.4',
    });
    expect(info.sid).toEqual(expect.any(String));
    expect(adapter.connectCalls).toHaveLength(1);
    expect(adapter.connectCalls[0]?.password).toBe('stored');
    expect(adapter.connectCalls[0]?.config).not.toHaveProperty('id');
    expect(adapter.connectCalls[0]?.config).not.toHaveProperty('hasPassword');

    const again = await call('GET', `/sessions/${info.sid}`);
    expect(again.status).toBe(200);
    expect(again.body).toEqual(info);
  });

  it('prefers the password sent in the body', async () => {
    const { call, adapter, createConnection } = setup();
    const c = await createConnection({ password: 'stored', savePassword: true });
    await call('POST', '/sessions', { connectionId: c.id, password: 'typed' });
    expect(adapter.connectCalls[0]?.password).toBe('typed');
  });

  it('connects without a password when none is stored or sent', async () => {
    const { call, adapter, createConnection } = setup();
    const c = await createConnection();
    expect((await call('POST', '/sessions', { connectionId: c.id })).status).toBe(200);
    expect(adapter.connectCalls[0]?.password).toBeNull();
  });

  it('answers 401 KLEOS_PASSWORD_REQUIRED when the server wants a password and none was available', async () => {
    const { call, adapter, createConnection } = setup();
    const c = await createConnection();
    adapter.connectError = pgError('28P01', 'password authentication failed for user "postgres"');
    const res = await call('POST', '/sessions', { connectionId: c.id });
    expect(res.status).toBe(401);
    expect(res.body).toMatchObject({ code: 'KLEOS_PASSWORD_REQUIRED' });

    adapter.connectError = new Error('SASL: SCRAM-SERVER-FIRST-MESSAGE: client password must be a string');
    expect((await call('POST', '/sessions', { connectionId: c.id })).body).toMatchObject({
      code: 'KLEOS_PASSWORD_REQUIRED',
    });
  });

  it('passes a wrong password error through when a password was given', async () => {
    const { call, adapter, createConnection } = setup();
    const c = await createConnection({ password: 'wrong', savePassword: true });
    adapter.connectError = pgError('28P01', 'password authentication failed for user "postgres"');
    const res = await call('POST', '/sessions', { connectionId: c.id });
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ code: '28P01', message: 'password authentication failed for user "postgres"' });
  });

  it('answers 404 for an unknown favorite and 400 for a bad body', async () => {
    const { call, adapter } = setup();
    const missing = await call('POST', '/sessions', { connectionId: 'nope' });
    expect(missing.status).toBe(404);
    expect(missing.body).toMatchObject({ code: 'KLEOS_NOT_FOUND' });
    expect((await call('POST', '/sessions', {})).status).toBe(400);
    expect(adapter.connectCalls).toEqual([]);
  });

  it('reflects later edits of the favorite in GET /sessions/:sid', async () => {
    const { call, openSession, store } = setup();
    const { connection, sid } = await openSession();
    store.updateConnection(connection.id, { ...connection, nickname: 'Prod', color: 'red' }, true);
    expect((await call('GET', `/sessions/${sid}`)).body).toMatchObject({
      connection: { nickname: 'Prod', color: 'red' },
    });
  });

  it('closes a session with DELETE and then forgets it', async () => {
    const { call, openSession } = setup();
    const { sid, session } = await openSession();
    const res = await call('DELETE', `/sessions/${sid}`);
    expect(res.status).toBe(204);
    expect(session.closed).toBe(true);
    const gone = await call('GET', `/sessions/${sid}`);
    expect(gone.status).toBe(404);
    expect(gone.body).toMatchObject({ code: 'KLEOS_SESSION_NOT_FOUND' });
  });

  it('answers 404 KLEOS_SESSION_NOT_FOUND on every sub-route of an unknown sid', async () => {
    const { call } = setup();
    const paths: Array<[string, string, unknown?]> = [
      ['GET', '/sessions/nope'],
      ['GET', '/sessions/nope/schema'],
      ['POST', '/sessions/nope/rows', {}],
      ['POST', '/sessions/nope/count', {}],
      ['POST', '/sessions/nope/edits', {}],
      ['POST', '/sessions/nope/queries', {}],
      ['GET', '/sessions/nope/queries/q1/page'],
      ['POST', '/sessions/nope/queries/q1/cancel'],
      ['DELETE', '/sessions/nope/queries/q1'],
      ['POST', '/sessions/nope/explain', {}],
      ['DELETE', '/sessions/nope/tabs/t1'],
      ['GET', '/sessions/nope/stats/sessions'],
      ['POST', '/sessions/nope/backends/12/cancel', { mode: 'cancel' }],
    ];
    for (const [method, path, body] of paths) {
      const res = await call(method, path, body);
      expect({ path, status: res.status, body: res.body }).toMatchObject({
        path,
        status: 404,
        body: { code: 'KLEOS_SESSION_NOT_FOUND' },
      });
    }
  });
});

describe('schema introspection', () => {
  it('introspects once and serves the cached model until ?refresh=1', async () => {
    const { call, openSession } = setup();
    const { sid, session } = await openSession();
    const first = await call('GET', `/sessions/${sid}/schema`);
    expect(first.status).toBe(200);
    expect(first.body).toMatchObject({ schemas: ['public'], introspectedAt: 'run-1' });
    expect((await call('GET', `/sessions/${sid}/schema`)).body).toMatchObject({ introspectedAt: 'run-1' });
    expect(session.callsTo('introspect')).toHaveLength(1);

    expect((await call('GET', `/sessions/${sid}/schema?refresh=1`)).body).toMatchObject({ introspectedAt: 'run-2' });
    expect((await call('GET', `/sessions/${sid}/schema`)).body).toMatchObject({ introspectedAt: 'run-2' });
    expect(session.callsTo('introspect')).toHaveLength(2);
  });

  it('shares one introspection between concurrent first calls', async () => {
    const { call, openSession } = setup();
    const { sid, session } = await openSession();
    await Promise.all([call('GET', `/sessions/${sid}/schema`), call('GET', `/sessions/${sid}/schema`)]);
    expect(session.callsTo('introspect')).toHaveLength(1);
  });

  it('does not cache a failed introspection', async () => {
    const { call, openSession } = setup();
    const { sid, session } = await openSession();
    session.errors.set('introspect', pgError('42501', 'permission denied for table pg_class'));
    const failed = await call('GET', `/sessions/${sid}/schema`);
    expect(failed.status).toBe(400);
    expect(failed.body).toMatchObject({ code: '42501' });
    session.errors.delete('introspect');
    expect((await call('GET', `/sessions/${sid}/schema`)).status).toBe(200);
    expect(session.callsTo('introspect')).toHaveLength(2);
  });
});

describe('table data routes', () => {
  const rowsReq: RowsRequest = {
    table,
    limit: 100,
    offset: 0,
    sort: [{ column: 'id', dir: 'desc' }],
    filters: [{ column: 'status', op: 'eq', value: 'paid' }],
  };

  it('fetches rows through the session', async () => {
    const { call, openSession } = setup();
    const { sid, session } = await openSession();
    const res = await call('POST', `/sessions/${sid}/rows`, rowsReq);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ rows: [['1'], ['2']], hasMore: false });
    expect(session.callsTo('fetchRows')).toEqual([[rowsReq]]);
  });

  it('rejects an invalid rows request', async () => {
    const { call, openSession } = setup();
    const { sid, session } = await openSession();
    const res = await call('POST', `/sessions/${sid}/rows`, { ...rowsReq, limit: 0 });
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ code: 'KLEOS_VALIDATION' });
    expect(session.callsTo('fetchRows')).toEqual([]);
  });

  it('counts exactly by default and estimates when exact is false', async () => {
    const { call, openSession } = setup();
    const { sid, session } = await openSession();
    const req: CountRequest = { table, filters: [] };

    expect((await call('POST', `/sessions/${sid}/count`, req)).body).toEqual({ count: '1234', exact: true });
    expect(session.callsTo('count')).toEqual([[{ ...req, exact: true }]]);

    expect((await call('POST', `/sessions/${sid}/count`, { ...req, exact: false })).body).toEqual({
      count: '1000',
      exact: false,
    });
    expect(session.callsTo('estimateCount')).toEqual([[{ ...req, exact: false }]]);
    expect(session.callsTo('count')).toHaveLength(1);
  });

  it('applies edits and passes the edit error through untouched', async () => {
    const { call, openSession } = setup();
    const { sid, session } = await openSession();
    const edits = [
      { kind: 'update', table, key: { id: '1' }, set: { status: 'paid' } },
      { kind: 'delete', table, key: { id: '2' } },
    ];
    const res = await call('POST', `/sessions/${sid}/edits`, { edits });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ applied: 2 });
    expect(session.callsTo('applyEdits')).toEqual([[edits]]);

    session.errors.set(
      'applyEdits',
      new KleosError(409, {
        code: 'KLEOS_ROW_COUNT_MISMATCH',
        message: 'Edit 1 affected 0 rows',
        editIndex: 1,
      }),
    );
    const failed = await call('POST', `/sessions/${sid}/edits`, { edits });
    expect(failed.status).toBe(409);
    expect(failed.body).toEqual({ code: 'KLEOS_ROW_COUNT_MISMATCH', message: 'Edit 1 affected 0 rows', editIndex: 1 });
  });

  it('rejects an empty edit list and edits on a read-only connection', async () => {
    const { call, openSession } = setup();
    const rw = await openSession();
    expect((await call('POST', `/sessions/${rw.sid}/edits`, { edits: [] })).status).toBe(400);

    const ro = await openSession({ nickname: 'RO', readOnly: true });
    const res = await call('POST', `/sessions/${ro.sid}/edits`, {
      edits: [{ kind: 'delete', table, key: { id: '1' } }],
    });
    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ code: 'KLEOS_READ_ONLY' });
    expect(ro.session.callsTo('applyEdits')).toEqual([]);
  });
});
