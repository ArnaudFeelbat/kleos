import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { kleosErrorCodes } from '@kleos/shared';
import { createPostgresAdapter } from '../../src/adapter/postgres';
import type { Session } from '../../src/adapter/types';
import { KleosError, isPgError } from '../../src/errors';
import { type TestDatabase, kleosBackends, rejectionOf, startPostgres, waitUntil } from '../helpers/postgres';

const adapter = createPostgresAdapter();
let db: TestDatabase;

beforeAll(async () => {
  db = await startPostgres({ seeds: ['shop.sql'] });
});

afterAll(async () => {
  await db?.stop();
});

describe('test()', () => {
  it('connects, reads the version and reports the elapsed time', async () => {
    const result = await adapter.test(db.config, db.password);
    expect(result.version).toMatch(/^PostgreSQL 17\./);
    expect(result.elapsedMs).toBeGreaterThanOrEqual(0);
  });

  it('throws the server error for a bad password, SQLSTATE kept', async () => {
    const err = await rejectionOf(adapter.test(db.config, 'wrong-password'));
    expect(isPgError(err)).toBe(true);
    expect(err.code).toBe('28P01');
  });

  it('sends no password when none is given, keeping the driver message', async () => {
    const err = await rejectionOf(adapter.test(db.config, null));
    expect(err).toBeInstanceOf(KleosError);
    expect(err.message).toMatch(/password must be a string/);
  });

  it('turns a refused connection into KLEOS_CONNECTION with the driver message', async () => {
    const err = await rejectionOf(adapter.test({ ...db.config, host: '127.0.0.1', port: 1 }, db.password));
    expect(err).toBeInstanceOf(KleosError);
    const kleos = err as unknown as KleosError;
    expect(kleos.status).toBe(502);
    expect(kleos.body.code).toBe(kleosErrorCodes.connection);
    expect(kleos.body.detail).toBe('ECONNREFUSED');
  });

  it('sslMode require fails against a server without TLS', async () => {
    const err = await rejectionOf(adapter.test({ ...db.config, sslMode: 'require' }, db.password));
    expect((err as unknown as KleosError).body.code).toBe(kleosErrorCodes.connection);
    expect(err.message).toBe('The server does not support SSL connections');
  });

  it('sslMode prefer falls back to plain when the server refuses TLS', async () => {
    const result = await adapter.test({ ...db.config, sslMode: 'prefer' }, db.password);
    expect(result.version).toMatch(/^PostgreSQL/);
  });
});

describe('connect()', () => {
  let session: Session;

  beforeAll(async () => {
    session = await adapter.connect({ ...db.config, sslMode: 'prefer' }, db.password);
  });

  afterAll(async () => {
    await session?.close();
  });

  it('exposes the server version', () => {
    expect(session.serverVersion).toMatch(/^PostgreSQL 17\./);
    expect(session.serverVersionShort).toMatch(/^17\.\d+$/);
    expect(session.readOnly).toBe(false);
  });

  it('sets the session time zone to the Mac zone, so timestamptz text carries the local offset', async () => {
    const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
    const shown = await session.runQuery('show timezone', { qid: 'tz', tabId: 't1', pageSize: 10 });
    expect(shown.rows).toEqual([[zone]]);
    const pooled = await session.fetchRows({
      table: { schema: 'shop', name: 'customers' },
      limit: 1,
      offset: 0,
      sort: [],
      filters: [],
    });
    expect(pooled.rows[0]?.[3]).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}(\.\d+)?[+-]\d{2}(:\d{2})?$/);
    const app = await session.runQuery('show application_name', { qid: 'app', tabId: 't1', pageSize: 10 });
    expect(app.rows).toEqual([['Kleos']]);
  });

  it('stats(statements) says how to install pg_stat_statements instead of failing', async () => {
    expect(await session.stats('statements')).toEqual({
      kind: 'statements',
      available: false,
      installHint: 'CREATE EXTENSION pg_stat_statements;',
      statements: [],
    });
    // Created but not preloaded: still no error.
    await db.sql('create extension pg_stat_statements');
    const notLoaded = await session.stats('statements');
    expect(notLoaded).toMatchObject({ available: false, statements: [] });
    expect(notLoaded.installHint).toMatch(/shared_preload_libraries/);
  });

  it('close() ends the pool and every tab client, and never throws', async () => {
    const other = await adapter.connect(db.config, db.password);
    await other.runQuery('select 1', { qid: 'a', tabId: 'tab-a', pageSize: 10 });
    await other.runQuery('select 1', { qid: 'b', tabId: 'tab-b', pageSize: 10 });
    // A cursor left open must not keep close() waiting.
    await other.runQuery('select generate_series(1, 100000)', { qid: 'c', tabId: 'tab-c', pageSize: 10 });
    const before = await kleosBackends(db);
    await other.close();
    await other.close();
    await waitUntil(async () => (await kleosBackends(db)) <= before - 4);
  });
});

describe('read-only connection', () => {
  let session: Session;

  beforeAll(async () => {
    session = await adapter.connect({ ...db.config, readOnly: true }, db.password);
  });

  afterAll(async () => {
    await session?.close();
  });

  it('is exposed as readOnly and the session refuses writes with 25006', async () => {
    expect(session.readOnly).toBe(true);
    const err = await rejectionOf(
      session.runQuery(`update shop.customers set name = 'x' where id = 1`, { qid: 'w', tabId: 't', pageSize: 10 }),
    );
    expect(err.code).toBe('25006');
    const reads = await session.runQuery('select count(*) from shop.customers', { qid: 'r', tabId: 't', pageSize: 10 });
    expect(reads.rows).toEqual([['3']]);
  });

  it('refuses applyEdits up front with KLEOS_READ_ONLY', async () => {
    const err = await rejectionOf(
      session.applyEdits([
        { kind: 'update', table: { schema: 'shop', name: 'customers' }, key: { id: '1' }, set: { name: 'x' } },
      ]),
    );
    const kleos = err as unknown as KleosError;
    expect(kleos.status).toBe(403);
    expect(kleos.body.code).toBe(kleosErrorCodes.readOnly);
  });
});
