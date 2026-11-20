import { describe, expect, it } from 'vitest';
import type { SchemaModel } from '@kleos/shared';
import { KleosError } from '../errors';
import { pgError, setup } from './test-utils';

const table = { schema: 'shop', name: 'orders' };
const changes = [
  { op: 'addColumn', table, column: { name: 'note', type: 'text' } },
  { op: 'createIndex', table, columns: ['note'] },
];

describe('POST /sessions/:sid/ddl/preview', () => {
  it('passes the changes with zod defaults applied and returns the statements', async () => {
    const { call, openSession } = setup();
    const { sid, session } = await openSession();
    const res = await call('POST', `/sessions/${sid}/ddl/preview`, { changes });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ statements: ['-- addColumn 0', '-- createIndex 1'] });
    expect(session.callsTo('previewDdl')).toEqual([
      [
        [
          { op: 'addColumn', table, column: { name: 'note', type: 'text', nullable: true, default: null } },
          { op: 'createIndex', table, name: null, columns: ['note'], unique: false, method: 'btree' },
        ],
      ],
    ]);
    expect(session.callsTo('applyDdl')).toEqual([]);
  });

  it('previews on a read-only session too: nothing runs', async () => {
    const { call, openSession } = setup();
    const { sid } = await openSession({ readOnly: true });
    expect((await call('POST', `/sessions/${sid}/ddl/preview`, { changes })).status).toBe(200);
  });

  it('answers 400 for a malformed body, an empty batch or an unknown op, without calling the session', async () => {
    const { call, openSession } = setup();
    const { sid, session } = await openSession();
    for (const body of [
      'not json',
      {},
      { changes: [] },
      { changes: [{ op: 'truncate', table }] },
      { changes: [{ op: 'createIndex', table, columns: [] }] },
      { changes: [{ op: 'addColumn', table, column: { name: 'a', type: '   ' } }] },
      { changes: [{ op: 'createIndex', table, columns: ['a'], method: 'spgist' }] },
    ]) {
      const res = await call('POST', `/sessions/${sid}/ddl/preview`, body);
      expect(res.status).toBe(400);
      expect(res.body).toMatchObject({ code: 'KLEOS_VALIDATION' });
    }
    expect(session.callsTo('previewDdl')).toEqual([]);
  });

  it("answers the session's validation error with its statementIndex", async () => {
    const { call, openSession } = setup();
    const { sid, session } = await openSession();
    session.errors.set(
      'previewDdl',
      new KleosError(400, {
        code: 'KLEOS_VALIDATION',
        message: 'Change 2: unknown type "txet"',
        detail: 'type "txet" does not exist',
        statementIndex: 1,
      }),
    );
    const res = await call('POST', `/sessions/${sid}/ddl/preview`, { changes });
    expect(res.status).toBe(400);
    expect(res.body).toEqual({
      code: 'KLEOS_VALIDATION',
      message: 'Change 2: unknown type "txet"',
      detail: 'type "txet" does not exist',
      statementIndex: 1,
    });
  });

  it('answers 404 for an unknown session', async () => {
    const { call } = setup();
    const res = await call('POST', '/sessions/nope/ddl/preview', { changes });
    expect(res.status).toBe(404);
    expect(res.body).toMatchObject({ code: 'KLEOS_SESSION_NOT_FOUND' });
  });
});

describe('POST /sessions/:sid/ddl', () => {
  it('runs the changes and returns the statements and the time taken', async () => {
    const { call, openSession } = setup();
    const { sid, session } = await openSession();
    const res = await call('POST', `/sessions/${sid}/ddl`, { changes });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ statements: ['-- addColumn 0', '-- createIndex 1'], elapsedMs: 5 });
    expect(session.callsTo('applyDdl')).toHaveLength(1);
  });

  it('refuses a read-only session with 403 KLEOS_READ_ONLY, before the session is asked', async () => {
    const { call, openSession } = setup();
    const { sid, session } = await openSession({ readOnly: true });
    const res = await call('POST', `/sessions/${sid}/ddl`, { changes });
    expect(res.status).toBe(403);
    expect(res.body).toEqual({ code: 'KLEOS_READ_ONLY', message: 'This connection is read-only' });
    expect(session.callsTo('applyDdl')).toEqual([]);
  });

  it("answers Postgres's error with the failing statement's index", async () => {
    const { call, openSession } = setup();
    const { sid, session } = await openSession();
    session.errors.set(
      'applyDdl',
      new KleosError(400, {
        code: '23502',
        message: 'column "note" of relation "orders" contains null values',
        statementIndex: 1,
      }),
    );
    const res = await call('POST', `/sessions/${sid}/ddl`, { changes });
    expect(res.status).toBe(400);
    expect(res.body).toEqual({
      code: '23502',
      message: 'column "note" of relation "orders" contains null values',
      statementIndex: 1,
    });
  });

  it('makes the next schema fetch introspect again, after a run or a failed one', async () => {
    const { call, openSession } = setup();
    const { sid, session } = await openSession();
    const schema = async () => ((await call('GET', `/sessions/${sid}/schema`)).body as SchemaModel).introspectedAt;
    expect(await schema()).toBe('run-1');
    expect(await schema()).toBe('run-1');
    await call('POST', `/sessions/${sid}/ddl`, { changes });
    expect(await schema()).toBe('run-2');
    session.errors.set('applyDdl', pgError('42P07', 'relation "orders_note_idx" already exists'));
    expect((await call('POST', `/sessions/${sid}/ddl`, { changes })).status).toBe(400);
    expect(await schema()).toBe('run-3');
  });

  it('answers 400 for an invalid body without running anything', async () => {
    const { call, openSession } = setup();
    const { sid, session } = await openSession();
    const res = await call('POST', `/sessions/${sid}/ddl`, { changes: [{ op: 'dropTable' }] });
    expect(res.status).toBe(400);
    expect(session.callsTo('applyDdl')).toEqual([]);
  });
});
