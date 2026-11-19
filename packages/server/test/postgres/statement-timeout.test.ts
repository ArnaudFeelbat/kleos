import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createPostgresAdapter } from '../../src/adapter/postgres';
import type { Session } from '../../src/adapter/types';
import { type TestDatabase, rejectionOf, startPostgres } from '../helpers/postgres';

/**
 * Settings › Query timeout (0.5): a session opened with statementTimeoutSeconds starts every
 * client — the pool and each query tab's own — with that statement_timeout. 1 second here, so a
 * 1.5 s statement is cancelled by Postgres (SQLSTATE 57014, query_canceled).
 */
let db: TestDatabase;
const sessions: Session[] = [];

beforeAll(async () => {
  db = await startPostgres({ seeds: ['shop.sql'] });
});

afterAll(async () => {
  for (const s of sessions) await s.close();
  await db?.stop();
});

async function connect(statementTimeoutSeconds: number | undefined, readOnly = false): Promise<Session> {
  const session = await createPostgresAdapter().connect({ ...db.config, readOnly }, db.password, {
    ...(statementTimeoutSeconds === undefined ? {} : { statementTimeoutSeconds }),
  });
  sessions.push(session);
  return session;
}

let qids = 0;
function run(session: Session, sql: string, tabId = 'tab-1') {
  qids += 1;
  return session.runQuery(sql, { qid: `q${qids}`, tabId, pageSize: 100 });
}

/** A grid request whose raw WHERE sleeps: runs on a pooled client. */
const slowRows = (session: Session) =>
  session.fetchRows({
    table: { schema: 'shop', name: 'customers' },
    limit: 1,
    offset: 0,
    sort: [],
    filters: [],
    where: 'pg_sleep(1.5) is not null',
  });

describe('statement_timeout from Settings', { timeout: 60_000 }, () => {
  it('cancels a query tab statement longer than the timeout with 57014', async () => {
    const session = await connect(1);
    expect((await run(session, 'show statement_timeout')).rows).toEqual([['1s']]);
    const err = await rejectionOf(run(session, 'select pg_sleep(1.5)'));
    expect(err.code).toBe('57014');
    // The tab's client is still usable afterwards.
    expect((await run(session, 'select 1 as n')).rows).toEqual([['1']]);
  });

  it('holds on the pooled clients too (grid rows)', async () => {
    const session = await connect(1);
    const err = await rejectionOf(slowRows(session));
    expect(err.code).toBe('57014');
  });

  it('holds on read-only sessions, on both kinds of client', async () => {
    const session = await connect(1, true);
    expect((await run(session, 'show statement_timeout')).rows).toEqual([['1s']]);
    expect((await rejectionOf(run(session, 'select pg_sleep(1.5)'))).code).toBe('57014');
    expect((await rejectionOf(slowRows(session))).code).toBe('57014');
  });

  it('lets a statement SET its own timeout', async () => {
    const session = await connect(1);
    await run(session, 'set statement_timeout = 0', 'tab-own');
    expect((await run(session, 'select 1 as n from pg_sleep(1.5)', 'tab-own')).rows).toEqual([['1']]);
  });

  it('sets no timeout for 0 or when absent', async () => {
    for (const timeout of [0, undefined]) {
      const session = await connect(timeout);
      expect((await run(session, 'show statement_timeout')).rows).toEqual([['0']]);
      expect((await run(session, 'select 1 as n from pg_sleep(1.5)')).rows).toEqual([['1']]);
      expect((await slowRows(session)).rows).toHaveLength(1);
    }
  });
});
