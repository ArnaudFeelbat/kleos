import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { kleosErrorCodes } from '@kleos/shared';
import { createPostgresAdapter } from '../../src/adapter/postgres';
import type { Session } from '../../src/adapter/types';
import { type KleosError, isPgError, pgErrorBody } from '../../src/errors';
import { type TestDatabase, kleosBackends, rejectionOf, startPostgres, waitUntil } from '../helpers/postgres';

let db: TestDatabase;
let session: Session;

beforeAll(async () => {
  db = await startPostgres({ seeds: ['shop.sql'] });
  session = await createPostgresAdapter().connect(db.config, db.password);
});

afterAll(async () => {
  await session?.close();
  await db?.stop();
});

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe('runQuery', () => {
  it('pages 20,000 rows through a server-side cursor, 500 at a time', async () => {
    const first = await session.runQuery("select g, g::text || '!' as label from generate_series(1, 20000) g", {
      qid: 'series',
      tabId: 'paging',
      pageSize: 500,
    });
    expect(first.columns).toEqual([
      { name: 'g', type: 'integer', typeName: 'int4', typeOid: 23, typeCategory: 'N' },
      { name: 'label', type: 'text', typeName: 'text', typeOid: 25, typeCategory: 'S' },
    ]);
    expect(first.rows).toHaveLength(500);
    expect(first.rows[0]).toEqual(['1', '1!']);
    expect(first.hasMore).toBe(true);
    expect(first.command).toBeNull();
    expect(first.rowCount).toBe(500);

    let total = first.rows.length;
    let last = first.rows.at(-1)![0];
    let pages = 1;
    let hasMore = first.hasMore;
    while (hasMore) {
      const page = await session.nextPage('series', 500);
      total += page.rows.length;
      last = page.rows.at(-1)?.[0] ?? last;
      hasMore = page.hasMore;
      pages += 1;
    }
    expect(total).toBe(20000);
    expect(last).toBe('20000');
    expect(pages).toBe(40);
    // Reading past the end is harmless.
    expect(await session.nextPage('series', 500)).toMatchObject({ rows: [], hasMore: false });
    await session.closeQuery('series');
  });

  it('reports hasMore exactly when the result is a whole number of pages', async () => {
    const first = await session.runQuery('select generate_series(1, 10)', {
      qid: 'exact',
      tabId: 'paging',
      pageSize: 5,
    });
    expect(first.hasMore).toBe(true);
    const second = await session.nextPage('exact', 5);
    expect(second.rows).toHaveLength(5);
    expect(second.hasMore).toBe(false);
  });

  it('returns the command tag and row count of statements without a result set', async () => {
    const opts = { tabId: 'commands', pageSize: 100 };
    const created = await session.runQuery('create temp table scratch (x int)', { qid: 'c1', ...opts });
    expect(created).toMatchObject({ columns: [], rows: [], hasMore: false, command: 'CREATE TABLE', rowCount: null });
    const inserted = await session.runQuery('insert into scratch select generate_series(1, 3)', { qid: 'c2', ...opts });
    expect(inserted).toMatchObject({ command: 'INSERT 0 3', rowCount: 3 });
    // The temp table lives on the tab's dedicated client.
    const updated = await session.runQuery('update scratch set x = x + 1', { qid: 'c3', ...opts });
    expect(updated).toMatchObject({ columns: [], command: 'UPDATE 3', rowCount: 3 });
    const returning = await session.runQuery('delete from scratch where x > 2 returning x', { qid: 'c4', ...opts });
    expect(returning.rows).toEqual([['3'], ['4']]);
    expect(returning.command).toBe('DELETE 2');
  });

  it('keeps a transaction open on the tab client, invisible to the pool until commit', async () => {
    const opts = { tabId: 'tx', pageSize: 100 };
    await session.runQuery('begin', { qid: 't1', ...opts });
    await session.runQuery(`insert into shop.audit_log (message) values ('in tx')`, { qid: 't2', ...opts });
    const where = `message = 'in tx'`;
    const table = { schema: 'shop', name: 'audit_log' };
    expect((await session.count({ table, filters: [], where })).count).toBe('0');
    await session.runQuery('rollback', { qid: 't3', ...opts });
    expect((await session.count({ table, filters: [], where })).count).toBe('0');
  });

  it('commits a transaction spanning several runs on a read-write tab', async () => {
    const opts = { tabId: 'tx-commit', pageSize: 100 };
    const table = { schema: 'shop', name: 'audit_log' };
    const where = `message like 'committed %'`;
    expect(await session.runQuery('begin', { qid: 'tc1', ...opts })).toMatchObject({ command: 'BEGIN' });
    await session.runQuery(`insert into shop.audit_log (message) values ('committed 1')`, { qid: 'tc2', ...opts });
    const paged = await session.runQuery('select g from generate_series(1, 50) g', {
      qid: 'tc3',
      ...opts,
      pageSize: 10,
    });
    expect(paged.hasMore).toBe(true);
    await session.runQuery(`insert into shop.audit_log (message) values ('committed 2')`, { qid: 'tc4', ...opts });
    const inside = await session.runQuery(`select count(*) from shop.audit_log where ${where}`, {
      qid: 'tc5',
      ...opts,
    });
    expect(inside.rows).toEqual([['2']]);
    expect((await session.count({ table, filters: [], where })).count).toBe('0');
    expect(await session.runQuery('commit', { qid: 'tc6', ...opts })).toMatchObject({ command: 'COMMIT' });
    expect((await session.count({ table, filters: [], where })).count).toBe('2');
    // Session settings stick across runs on a read-write tab.
    await session.runQuery('set statement_timeout = 12345', { qid: 'tc8', ...opts });
    expect((await session.runQuery('show statement_timeout', { qid: 'tc9', ...opts })).rows).toEqual([['12345ms']]);
  });

  it('rethrows Postgres errors untouched, keeping the position of the failing token', async () => {
    const err = await rejectionOf(
      session.runQuery('select nope from shop.customers', { qid: 'bad', tabId: 'errors', pageSize: 10 }),
    );
    expect(isPgError(err)).toBe(true);
    expect(err.code).toBe('42703');
    expect(pgErrorBody(err as never).position).toBe(8);
    // The tab still works afterwards, and the failed qid is gone.
    const ok = await session.runQuery('select 1', { qid: 'after', tabId: 'errors', pageSize: 10 });
    expect(ok.rows).toEqual([['1']]);
    const missing = await rejectionOf(session.nextPage('bad', 10));
    expect((missing as unknown as KleosError).body.code).toBe(kleosErrorCodes.queryNotFound);
  });

  it('reports an error raised while paging, then forgets the query', async () => {
    const first = await session.runQuery('select 10 / (5000 - g) from generate_series(1, 6000) g', {
      qid: 'div',
      tabId: 'errors',
      pageSize: 100,
    });
    expect(first.rows).toHaveLength(100);
    let err: unknown;
    try {
      for (;;) await session.nextPage('div', 1000);
    } catch (caught) {
      err = caught;
    }
    expect((err as { code?: string }).code).toBe('22012');
  });

  it('closes the open cursor of a tab before running the next query there', async () => {
    await session.runQuery('select generate_series(1, 100000)', { qid: 'open', tabId: 'reuse', pageSize: 10 });
    const next = await session.runQuery('select 42', { qid: 'next', tabId: 'reuse', pageSize: 10 });
    expect(next.rows).toEqual([['42']]);
    const err = await rejectionOf(session.nextPage('open', 10));
    expect((err as unknown as KleosError).status).toBe(404);
  });
});

describe('cancelQuery', () => {
  it('cancels select pg_sleep(60) within one second', async () => {
    const running = session.runQuery('select pg_sleep(60)', { qid: 'sleep', tabId: 'cancel', pageSize: 10 });
    const outcome = running.then(
      () => null,
      (err: unknown) => err,
    );
    await delay(300);
    const started = performance.now();
    await session.cancelQuery('sleep');
    const err = await outcome;
    const latency = performance.now() - started;
    console.log(`cancel latency: ${latency.toFixed(1)} ms`);
    expect((err as { code?: string } | null)?.code).toBe('57014');
    expect(latency).toBeLessThan(1000);
    // The tab client is usable again.
    const after = await session.runQuery('select 1', { qid: 'after-cancel', tabId: 'cancel', pageSize: 10 });
    expect(after.rows).toEqual([['1']]);
  });

  it('cancels a query whose cancel arrives before it reaches the server', async () => {
    const running = session.runQuery('select pg_sleep(60)', { qid: 'early', tabId: 'cancel-early', pageSize: 10 });
    await session.cancelQuery('early');
    expect((await rejectionOf(running)).code).toBe('57014');
  });

  it('ignores unknown or finished queries', async () => {
    await session.cancelQuery('never-started');
    await session.closeQuery('never-started');
  });
});

describe('explain', () => {
  it('returns the plan with timings and rolls back writes', async () => {
    const result = await session.explain(`insert into shop.audit_log (message) values ('explained')`, {
      qid: 'ex1',
      tabId: 'explain',
    });
    expect(result.plan['Node Type']).toBe('ModifyTable');
    expect(result.plan['Actual Rows']).toBe(0);
    expect(result.planningMs).toBeGreaterThanOrEqual(0);
    expect(result.executionMs).toBeGreaterThan(0);
    const count = await session.count({
      table: { schema: 'shop', name: 'audit_log' },
      filters: [],
      where: `message = 'explained'`,
    });
    expect(count.count).toBe('0');
  });

  it('explains a select with nested plan nodes', async () => {
    const result = await session.explain(
      'select c.name, count(*) from shop.customers c join shop.orders o on o.customer_id = c.id group by c.name',
      { qid: 'ex2', tabId: 'explain' },
    );
    expect(result.plan.Plans?.length).toBeGreaterThan(0);
  });

  it('is cancellable by qid', async () => {
    const running = session.explain('select pg_sleep(60)', { qid: 'ex-sleep', tabId: 'explain' });
    await delay(300);
    await session.cancelQuery('ex-sleep');
    expect((await rejectionOf(running)).code).toBe('57014');
  });

  it('runs a single statement only', async () => {
    const err = await rejectionOf(
      session.explain('select 1; commit; delete from shop.audit_log', { qid: 'ex-multi', tabId: 'explain' }),
    );
    expect(err.code).toBe('42601');
  });
});

describe('bind parameters (0.7)', () => {
  const opts = (qid: string, params: (string | null)[] | undefined, pageSize = 100) => ({
    qid,
    tabId: 'params',
    pageSize,
    params,
  });

  it('lets Postgres infer each type from where the value is used', async () => {
    // $1 against an int column, then a bigint and a text column.
    const byId = await session.runQuery('select id, note from shop.orders where id = $1', opts('p-int', ['3']));
    expect(byId.rows).toEqual([['3', '']]);
    const byBoth = await session.runQuery(
      'select name from shop.customers where id = $1 or email = $2 order by id',
      opts('p-two', ['1', 'grace@example.com']),
    );
    expect(byBoth.rows).toEqual([['Ada'], ['Grace']]);
    // The same placeholder used twice is one value.
    const twice = await session.runQuery('select $1::int + $1::int as doubled', opts('p-twice', ['21']));
    expect(twice.rows).toEqual([['42']]);
  });

  it('sends null as SQL NULL', async () => {
    const result = await session.runQuery(
      'select id from shop.orders where customer_id = $1 and note is not distinct from $2',
      opts('p-null', ['1', null]),
    );
    expect(result.rows).toEqual([['2']]);
    const isNull = await session.runQuery('select $1::text is null, $2::text is null', opts('p-null2', [null, '']));
    expect(isNull.rows).toEqual([['t', 'f']]);
  });

  it('treats a value as data, never as SQL', async () => {
    const evil = `'; drop table shop.customers; --`;
    const echoed = await session.runQuery('select $1::text as v', opts('p-evil1', [evil]));
    expect(echoed.rows).toEqual([[evil]]);
    const matched = await session.runQuery(
      'select count(*) from shop.customers where name = $1',
      opts('p-evil2', [evil]),
    );
    expect(matched.rows).toEqual([['0']]);
    expect((await db.sql('select count(*)::int as n from shop.customers')).rows[0].n).toBe(3);
  });

  it('pages a cursor opened with parameters and runs commands with them', async () => {
    const first = await session.runQuery('select g from generate_series(1, $1::int) g', opts('p-page', ['25'], 10));
    expect(first.rows).toHaveLength(10);
    expect(first.hasMore).toBe(true);
    expect((await session.nextPage('p-page', 10)).rows[0]).toEqual(['11']);
    const last = await session.nextPage('p-page', 10);
    expect(last).toMatchObject({ rows: [['21'], ['22'], ['23'], ['24'], ['25']], hasMore: false });

    await session.runQuery('create temp table bound (id int, label text)', opts('p-c1', undefined));
    const inserted = await session.runQuery('insert into bound values ($1, $2)', opts('p-c2', ['7', null]));
    expect(inserted).toMatchObject({ command: 'INSERT 0 1', rowCount: 1 });
    const read = await session.runQuery('select id, label from bound', opts('p-c3', []));
    expect(read.rows).toEqual([['7', null]]);
  });

  it("returns Postgres's own error for missing, extra or ill-typed values, and the tab keeps working", async () => {
    const tooFew = await rejectionOf(session.runQuery('select $1::int + $2::int', opts('p-few', ['1'])));
    expect(isPgError(tooFew)).toBe(true);
    expect(tooFew.code).toBe('08P01');
    expect(tooFew.message).toMatch(/bind message supplies 1 parameters, but prepared statement "" requires 2/);

    // Statements always go over the extended protocol, so no values at all is the same 08P01.
    const none = await rejectionOf(session.runQuery('select $1::int', opts('p-none', undefined)));
    expect(none.code).toBe('08P01');
    // A placeholder whose type nothing tells is text.
    expect((await session.runQuery('select $1 as v', opts('p-untyped', ['1']))).columns[0]?.typeName).toBe('text');

    const extra = await rejectionOf(session.runQuery('select 1', opts('p-extra', ['1'])));
    expect(extra.code).toBe('08P01');

    const typed = await rejectionOf(session.runQuery('select * from shop.orders where id = $1', opts('p-type', ['x'])));
    expect(typed.code).toBe('22P02');

    const after = await session.runQuery('select $1::text', opts('p-after', ['ok']));
    expect(after.rows).toEqual([['ok']]);
  });

  it('explains with the same values, and still rolls back writes', async () => {
    const result = await session.explain('select * from shop.orders where id = $1', {
      qid: 'p-ex1',
      tabId: 'params',
      params: ['2'],
    });
    expect(result.plan['Actual Rows']).toBe(1);

    await session.explain('insert into shop.audit_log (message) values ($1)', {
      qid: 'p-ex2',
      tabId: 'params',
      params: ['explained with params'],
    });
    const count = await db.sql(`select count(*)::int as n from shop.audit_log where message = 'explained with params'`);
    expect(count.rows[0].n).toBe(0);

    const tooFew = await rejectionOf(
      session.explain('select $1::int + $2::int', { qid: 'p-ex3', tabId: 'params', params: ['1'] }),
    );
    expect(tooFew.code).toBe('08P01');
  });
});

describe('closeTab', () => {
  it('releases the tab client', async () => {
    const before = await kleosBackends(db);
    await session.runQuery('select 1', { qid: 'ct', tabId: 'to-close', pageSize: 10 });
    expect(await kleosBackends(db)).toBe(before + 1);
    await session.closeTab('to-close');
    await waitUntil(async () => (await kleosBackends(db)) === before);
    // Closing again, or an unknown tab, is a no-op.
    await session.closeTab('to-close');
    await session.closeTab('unknown');
  });

  it('closes a tab whose query is still running', async () => {
    const running = session.runQuery('select pg_sleep(60)', { qid: 'busy', tabId: 'busy-tab', pageSize: 10 });
    const outcome = running.catch((err: unknown) => err);
    await delay(300);
    const started = performance.now();
    await session.closeTab('busy-tab');
    expect(performance.now() - started).toBeLessThan(2000);
    expect(((await outcome) as { code?: string }).code).toBe('57014');
  });
});
