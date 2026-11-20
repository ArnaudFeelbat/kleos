import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createPostgresAdapter } from '../../src/adapter/postgres';
import type { Session } from '../../src/adapter/types';
import { type TestDatabase, rejectionOf, startPostgres, waitUntil } from '../helpers/postgres';

/**
 * A read-only favorite must not write, whatever is typed in a query tab, the Explain box or
 * the grid's raw WHERE: Postgres refuses, Kleos does not parse SQL.
 */
let db: TestDatabase;
let session: Session;

beforeAll(async () => {
  db = await startPostgres({ seeds: ['shop.sql'] });
  // A function that writes, for the raw WHERE box to call.
  await db.sql(`create function shop.log_write() returns boolean language plpgsql as $$
                begin insert into shop.audit_log (message) values ('leaked'); return true; end $$`);
  session = await createPostgresAdapter().connect({ ...db.config, readOnly: true }, db.password);
});

afterAll(async () => {
  await session?.close();
  await db?.stop();
});

let qids = 0;
function run(sql: string, tabId: string, pageSize = 100) {
  qids += 1;
  return session.runQuery(sql, { qid: `q${qids}`, tabId, pageSize });
}

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const adaName = async () => (await db.sql('select name from shop.customers where id = 1')).rows[0].name as string;
const auditCount = async () => (await db.sql('select count(*)::int as n from shop.audit_log')).rows[0].n as number;

/**
 * Kleos backends inside a transaction. A suspended cursor shows as "active" (no Sync is sent
 * between pages), so the transaction start is what tells.
 */
const openTransactions = async () =>
  (
    await db.sql(
      `select count(*)::int as n from pg_stat_activity
        where application_name = 'Kleos' and datname = current_database() and xact_start is not null`,
    )
  ).rows[0].n as number;

/** The next statement on the tab still cannot write, nothing changed, and the session default is intact. */
async function expectStillReadOnly(tabId: string): Promise<void> {
  const update = await rejectionOf(run(`update shop.customers set name = 'hacked' where id = 1`, tabId));
  expect(update.code).toBe('25006');
  const insert = await rejectionOf(run(`insert into shop.audit_log (message) values ('hacked')`, tabId));
  expect(insert.code).toBe('25006');
  expect(await adaName()).toBe('Ada');
  expect((await run('show default_transaction_read_only', tabId)).rows).toEqual([['on']]);
  expect((await run('show transaction_read_only', tabId)).rows).toEqual([['on']]);
}

describe('query tabs on a read-only session: every bypass fails', () => {
  // [statements run one after the other on one tab, expected outcome of each: 'ok' or SQLSTATE]
  const bypasses: Array<[string, Array<[string, string]>]> = [
    ['SET default_transaction_read_only = off', [['set default_transaction_read_only = off', 'ok']]],
    ['SET default_transaction_read_only TO false', [['set default_transaction_read_only to false', 'ok']]],
    [
      'SET SESSION CHARACTERISTICS AS TRANSACTION READ WRITE',
      [['set session characteristics as transaction read write', 'ok']],
    ],
    ['BEGIN READ WRITE', [['begin read write', '25001']]],
    ['START TRANSACTION READ WRITE', [['start transaction read write', '25001']]],
    ['BEGIN ISOLATION LEVEL SERIALIZABLE, READ WRITE', [['begin isolation level serializable, read write', '25001']]],
    ['SET transaction_read_only = off', [['set transaction_read_only = off', '25001']]],
    ['SET TRANSACTION READ WRITE', [['set transaction read write', '25001']]],
    [
      'BEGIN, then SET TRANSACTION READ WRITE',
      [
        ['begin', 'ok'],
        ['set transaction read write', '25001'],
      ],
    ],
    [
      'set_config(default_transaction_read_only)',
      [[`select set_config('default_transaction_read_only', 'off', false)`, 'ok']],
    ],
    ['set_config(transaction_read_only)', [[`select set_config('transaction_read_only', 'off', false)`, '25001']]],
    [
      'SET default_transaction_read_only = off, then COMMIT',
      [
        ['set default_transaction_read_only = off', 'ok'],
        ['commit', 'ok'],
      ],
    ],
    [
      'COMMIT, then SET TRANSACTION READ WRITE',
      [
        ['commit', 'ok'],
        ['set transaction read write', '25001'],
      ],
    ],
    [
      'ROLLBACK, then BEGIN READ WRITE',
      [
        ['rollback', 'ok'],
        ['begin read write', '25001'],
      ],
    ],
    ['COMMIT AND CHAIN', [['commit and chain', 'ok']]],
    [
      'a DO block that flips the default and commits',
      [[`do $$ begin perform set_config('default_transaction_read_only', 'off', false); commit; end $$`, '2D000']],
    ],
    [
      'RESET ALL, then SET SESSION CHARACTERISTICS',
      [
        ['reset all', 'ok'],
        ['set session characteristics as transaction read write', 'ok'],
      ],
    ],
  ];

  for (const [name, steps] of bypasses) {
    it(name, async () => {
      const tabId = `bypass ${name}`;
      for (const [sql, expected] of steps) {
        const outcome = await run(sql, tabId).then(
          () => 'ok',
          (err: { code?: string }) => err.code ?? String(err),
        );
        expect(outcome, sql).toBe(expected);
      }
      await expectStillReadOnly(tabId);
      await session.closeTab(tabId);
    });
  }

  it('still refuses a write from a procedure that commits', async () => {
    await db.sql(`create procedure shop.flip_and_write() language plpgsql as $$
                  begin
                    perform set_config('default_transaction_read_only', 'off', false);
                    commit;
                    update shop.customers set name = 'hacked' where id = 1;
                  end $$`);
    const err = await rejectionOf(run('call shop.flip_and_write()', 'procedure'));
    expect(err.code).toBe('2D000');
    await expectStillReadOnly('procedure');
  });

  it('leaves no transaction open once the statements are done', async () => {
    await waitUntil(async () => (await openTransactions()) === 0);
  });
});

describe('query tabs on a read-only session: reading still works', () => {
  it('runs many SELECTs in a row on one tab', async () => {
    for (let i = 1; i <= 40; i += 1) {
      const result = await run(`select ${i} as n, name from shop.customers where id = 1`, 'many');
      expect(result.rows).toEqual([[String(i), 'Ada']]);
    }
    expect(await openTransactions()).toBe(0);
  });

  it('pages a cursor inside its read-only transaction, then ends it', async () => {
    const first = await run('select g from generate_series(1, 5000) g', 'paging', 500);
    expect(first.rows).toHaveLength(500);
    expect(first.hasMore).toBe(true);
    // The open cursor holds its READ ONLY transaction across pages.
    expect(await openTransactions()).toBe(1);
    const qid = `q${qids}`;
    let total = first.rows.length;
    let last = first.rows.at(-1)![0];
    let hasMore = true;
    while (hasMore) {
      const page = await session.nextPage(qid, 500);
      total += page.rows.length;
      last = page.rows.at(-1)?.[0] ?? last;
      hasMore = page.hasMore;
    }
    expect(total).toBe(5000);
    expect(last).toBe('5000');
    // The portal is exhausted: the wrapper ended with it, before the last page came back.
    expect(await openTransactions()).toBe(0);
    await session.closeQuery(qid);
    await expectStillReadOnly('paging');
  });

  it('ends the transaction of a cursor closed half-way, and of one replaced by the next run', async () => {
    await run('select generate_series(1, 100000)', 'half', 10);
    const qid = `q${qids}`;
    expect(await openTransactions()).toBe(1);
    await session.closeQuery(qid);
    expect(await openTransactions()).toBe(0);

    await run('select generate_series(1, 100000)', 'half', 10);
    expect(await openTransactions()).toBe(1);
    const next = await run('select 42', 'half');
    expect(next.rows).toEqual([['42']]);
    expect(await openTransactions()).toBe(0);
  });

  it('recovers from an error at the start and from an error while paging', async () => {
    expect((await rejectionOf(run('select nope from shop.customers', 'errors'))).code).toBe('42703');
    expect((await run('select 1', 'errors')).rows).toEqual([['1']]);

    const first = await run('select 10 / (500 - g) from generate_series(1, 600) g', 'errors', 100);
    expect(first.rows).toHaveLength(100);
    const qid = `q${qids}`;
    let err: unknown;
    try {
      for (;;) await session.nextPage(qid, 1000);
    } catch (caught) {
      err = caught;
    }
    expect((err as { code?: string }).code).toBe('22012');
    expect((await run('select 2', 'errors')).rows).toEqual([['2']]);
    expect(await openTransactions()).toBe(0);
    await expectStillReadOnly('errors');
  });

  it('cancels a running statement, then the tab still reads and still refuses writes', async () => {
    const running = run('select pg_sleep(60)', 'cancel');
    const qid = `q${qids}`;
    const outcome = running.then(
      () => null,
      (err: { code?: string }) => err.code,
    );
    await delay(300);
    await session.cancelQuery(qid);
    expect(await outcome).toBe('57014');
    expect((await run('select 1', 'cancel')).rows).toEqual([['1']]);
    await expectStillReadOnly('cancel');
    expect(await openTransactions()).toBe(0);
  });

  it('cancels a statement whose cancel arrives before it reaches the server', async () => {
    const running = run('select pg_sleep(60)', 'cancel-early');
    await session.cancelQuery(`q${qids}`);
    expect((await rejectionOf(running)).code).toBe('57014');
    expect((await run('select 1', 'cancel-early')).rows).toEqual([['1']]);
  });

  it('closes a tab whose statement is running or whose cursor is open', async () => {
    const running = run('select pg_sleep(60)', 'busy');
    const outcome = running.catch((err: { code?: string }) => err.code);
    await delay(300);
    await session.closeTab('busy');
    expect(await outcome).toBe('57014');

    await run('select generate_series(1, 100000)', 'open-cursor', 10);
    await session.closeTab('open-cursor');
    await waitUntil(async () => (await openTransactions()) === 0);
  });
});

describe('explain on a read-only session', () => {
  it('explains a select', async () => {
    const result = await session.explain('select * from shop.customers where id = 1', { qid: 'ex1', tabId: 'ex' });
    expect(result.plan['Node Type']).toBeDefined();
    expect(result.executionMs).toBeGreaterThanOrEqual(0);
  });

  it('refuses a write, even after a flip of the session default', async () => {
    await session.explain(`select set_config('default_transaction_read_only', 'off', false)`, {
      qid: 'ex2',
      tabId: 'ex',
    });
    for (let i = 0; i < 6; i += 1) {
      const err = await rejectionOf(
        session.explain(`update shop.customers set name = 'hacked' where id = 1`, { qid: `ex-w${i}`, tabId: 'ex' }),
      );
      expect(err.code).toBe('25006');
    }
    expect(await adaName()).toBe('Ada');
  });
});

describe('bind parameters on a read-only session (0.7)', () => {
  it('reads with parameters inside the read-only wrapper, and still refuses a write', async () => {
    const read = await session.runQuery(
      'select name, transaction_read_only from shop.customers, (select current_setting($2) as transaction_read_only) t where id = $1',
      {
        qid: 'ro-p1',
        tabId: 'ro-params',
        pageSize: 10,
        params: ['2', 'transaction_read_only'],
      },
    );
    expect(read.rows).toEqual([['Grace', 'on']]);

    const write = await rejectionOf(
      session.runQuery('update shop.customers set name = $1 where id = $2', {
        qid: 'ro-p2',
        tabId: 'ro-params',
        pageSize: 10,
        params: ['hacked', '1'],
      }),
    );
    expect(write.code).toBe('25006');
    const explained = await rejectionOf(
      session.explain('update shop.customers set name = $1 where id = $2', {
        qid: 'ro-p3',
        tabId: 'ro-params',
        params: ['hacked', '1'],
      }),
    );
    expect(explained.code).toBe('25006');
    expect(await adaName()).toBe('Ada');
    await expectStillReadOnly('ro-params');
  });
});

describe("the grid's raw WHERE on a read-only session", () => {
  const customers = { schema: 'shop', name: 'customers' };
  const rows = (where: string) =>
    session.fetchRows({ table: customers, limit: 50, offset: 0, sort: [], filters: [], where });

  it('cannot run a second statement', async () => {
    for (const where of [
      'true) ; set default_transaction_read_only = off ; select (true',
      'true) ; update shop.customers set name = $$hacked$$ ; select (true',
      'true);\ncommit;\nset default_transaction_read_only = off;\nselect (true',
    ]) {
      const err = await rejectionOf(rows(where));
      expect(err.code, where).toBe('42601');
    }
    expect(await adaName()).toBe('Ada');
  });

  it('cannot write through a function, before or after a set_config of the session default', async () => {
    const before = await auditCount();
    expect((await rejectionOf(rows('shop.log_write()'))).code).toBe('25006');

    const flipped = await rows(`set_config('default_transaction_read_only', 'off', false) = 'off'`);
    expect(flipped.rows).toHaveLength(3);
    // More attempts than the pool has clients, so whichever client ran the set_config is reused.
    for (let i = 0; i < 6; i += 1) {
      expect((await rejectionOf(rows('shop.log_write()'))).code).toBe('25006');
      expect(
        (await rejectionOf(session.count({ table: customers, filters: [], where: 'shop.log_write()' }))).code,
      ).toBe('25006');
      const still = await rows(`current_setting('default_transaction_read_only') = 'on'`);
      expect(still.rows).toHaveLength(3);
    }
    expect((await rejectionOf(rows(`set_config('transaction_read_only', 'off', false) is not null`))).code).toBe(
      '25001',
    );
    expect(await auditCount()).toBe(before);
  });

  it('still filters, counts and estimates', async () => {
    expect((await rows(`name = 'Ada'`)).rows).toHaveLength(1);
    expect(await session.count({ table: customers, filters: [], where: `name like 'G%'` })).toEqual({
      count: '1',
      exact: true,
    });
    const estimate = await session.estimateCount({ table: customers, filters: [], where: 'id > 0' });
    expect(estimate.exact).toBe(false);
    expect(await openTransactions()).toBe(0);
  });
});
