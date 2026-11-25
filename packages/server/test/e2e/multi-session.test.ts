// Several sessions open at once, end to end through the HTTP API (0.7.2). Kleos keeps one
// window tab per connected server, each a session in the registry with its own pool, query tabs
// and jobs; these tests open them side by side and check that nothing one session does (search
// path, cancel, timeout, read-only, close, favorite deletion) reaches another.
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pg from 'pg';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import {
  HistoryEntry,
  type JobStatus,
  QueryStarted,
  RowsPage,
  SavedConnection,
  SchemaModel,
  SessionInfo,
  statsKinds,
} from '@kleos/shared';
import { createPostgresAdapter } from '../../src/adapter/postgres';
import { APPLICATION_NAME } from '../../src/adapter/postgres/connect';
import { createApp } from '../../src/http/app';
import { PARTIAL_SUFFIX } from '../../src/jobs/files';
import { SessionRegistry } from '../../src/sessions/registry';
import { createMemorySecretStore } from '../../src/store/keychain';
import { createSqliteStore } from '../../src/store/sqlite';
import type { AppStore } from '../../src/store/types';
import { type TestDatabase, startPostgres, waitUntil } from '../helpers/postgres';

const PORT = 47003;
const TOKEN = 'multi-session-token-'.padEnd(64, 'x');
/** A second database in the same container, for two favorites that differ only by database. */
const SECOND_DB = 'kleos_second';

let db: TestDatabase;
/** An older major next to the 17 one (scenario: two servers of different versions). */
let db16: TestDatabase;
let store: AppStore;
let sessions: SessionRegistry;
let app: ReturnType<typeof createApp>;
let dir: string;

type Reply = { status: number; json: Record<string, unknown> | null };

async function call(method: string, path: string, body?: unknown): Promise<Reply> {
  const res = await app.request(`/api${path}`, {
    method,
    headers: {
      host: `127.0.0.1:${PORT}`,
      authorization: `Bearer ${TOKEN}`,
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  return { status: res.status, json: text ? (JSON.parse(text) as Record<string, unknown>) : null };
}

/** Saves a favorite on the 17 container (or `target`) and returns its id. */
async function favorite(overrides: Record<string, unknown> = {}, target: TestDatabase = db): Promise<string> {
  const created = await call('POST', '/connections', {
    nickname: 'multi',
    host: target.config.host,
    port: target.config.port,
    user: target.config.user,
    database: target.config.database,
    sslMode: 'disable',
    color: 'none',
    readOnly: false,
    password: target.password,
    savePassword: true,
    ...overrides,
  });
  expect(created.status).toBe(200);
  return SavedConnection.parse(created.json).id;
}

async function open(connectionId: string, extra: Record<string, unknown> = {}): Promise<SessionInfo> {
  const opened = await call('POST', '/sessions', { connectionId, ...extra });
  expect(opened.status).toBe(200);
  return SessionInfo.parse(opened.json);
}

let qids = 0;
/** Runs SQL in a query tab of the session; a fresh qid unless one is given. */
function query(sid: string, sql: string, ids: { qid?: string; tabId?: string } = {}): Promise<Reply> {
  qids += 1;
  return call('POST', `/sessions/${sid}/queries`, { qid: ids.qid ?? `q${qids}`, tabId: ids.tabId ?? 'tab-1', sql });
}

/** The rows of a query that must succeed. */
async function rowsOf(reply: Promise<Reply> | Reply): Promise<QueryStarted['rows']> {
  const res = await reply;
  expect(res.status, JSON.stringify(res.json)).toBe(200);
  return QueryStarted.parse(res.json).rows;
}

function gridRows(sid: string, schema: string, name: string, where?: string): Promise<Reply> {
  return call('POST', `/sessions/${sid}/rows`, {
    table: { schema, name },
    limit: 100,
    offset: 0,
    sort: [{ column: 'id', dir: 'asc' }],
    filters: [],
    ...(where ? { where } : {}),
  });
}

/**
 * Kleos backends (application_name 'Kleos') executing a statement that contains `marker`, on any
 * database of the container. Each test tags its statements with its own marker, e.g.
 * `select pg_sleep(60) as in_a`, so two sessions' identical work can be told apart.
 */
async function running(marker: string, target: TestDatabase = db): Promise<number> {
  const { rows } = await target.sql(
    `select count(*)::int as n from pg_stat_activity
      where application_name = $1 and state = 'active' and position($2 in query) > 0`,
    [APPLICATION_NAME, marker],
  );
  return rows[0].n as number;
}

/** Every backend Kleos holds on the container, whatever the database. */
async function allKleosBackends(target: TestDatabase = db): Promise<number> {
  const { rows } = await target.sql('select count(*)::int as n from pg_stat_activity where application_name = $1', [
    APPLICATION_NAME,
  ]);
  return rows[0].n as number;
}

async function jobStatus(jobId: string): Promise<JobStatus> {
  const res = await call('GET', `/jobs/${jobId}`);
  expect(res.status).toBe(200);
  return res.json as JobStatus;
}

/** Runs SQL as the superuser on the second database (the helper's client targets the first). */
async function onSecondDb(sql: string): Promise<void> {
  const client = new pg.Client({
    host: db.config.host,
    port: db.config.port,
    user: db.config.user,
    password: db.password,
    database: SECOND_DB,
    application_name: 'kleos-test',
  });
  await client.connect();
  try {
    await client.query(sql);
  } finally {
    await client.end();
  }
}

beforeAll(async () => {
  // Both containers at once: the 16 one adds little to the suite's wall time this way.
  [db, db16] = await Promise.all([
    startPostgres({ seeds: ['shop.sql'] }),
    startPostgres({ image: 'postgres:16-alpine' }),
  ]);
  await db.sql(`create database ${SECOND_DB}`);
  // Same schema name as the first database, other rows, plus a schema only this one has.
  await onSecondDb(`
    create schema shop;
    create table shop.customers (id bigint primary key, email text not null, name text);
    insert into shop.customers values (1, 'zed@example.com', 'Zed');
    create schema inventory;
    create table inventory.items (id int primary key, label text not null);
    insert into inventory.items values (1, 'bolt'), (2, 'nut');`);
  store = createSqliteStore(':memory:');
  sessions = new SessionRegistry();
  app = createApp(
    { adapter: createPostgresAdapter(), store, secrets: createMemorySecretStore(), sessions, version: 'e2e' },
    { token: TOKEN, getPort: () => PORT },
  );
  dir = mkdtempSync(join(tmpdir(), 'kleos-multi-'));
});

// Every test opens its own sessions; none outlives it, so the leak check starts from zero.
afterEach(async () => {
  await sessions?.closeAll();
});

afterAll(async () => {
  await sessions?.closeAll();
  store?.close();
  await Promise.all([db?.stop(), db16?.stop()]);
  if (dir) rmSync(dir, { recursive: true, force: true });
});

describe('several sessions open at once', () => {
  it('two favorites on two databases of one server each answer from their own database', async () => {
    const first = await open(await favorite({ nickname: 'first' }));
    const second = await open(await favorite({ nickname: 'second', database: SECOND_DB }));

    // Queries, in parallel, on the same tab and qid names.
    const [dbA, dbB] = await Promise.all([
      rowsOf(query(first.sid, 'select current_database()', { qid: 'q-db', tabId: 'tab-1' })),
      rowsOf(query(second.sid, 'select current_database()', { qid: 'q-db', tabId: 'tab-1' })),
    ]);
    expect(dbA).toEqual([[db.config.database]]);
    expect(dbB).toEqual([[SECOND_DB]]);

    // Schema listing.
    const [schemaA, schemaB] = await Promise.all([
      call('GET', `/sessions/${first.sid}/schema`).then((r) => SchemaModel.parse(r.json)),
      call('GET', `/sessions/${second.sid}/schema`).then((r) => SchemaModel.parse(r.json)),
    ]);
    const tables = (s: SchemaModel) => s.tables.map((t) => `${t.schema}.${t.name}`);
    expect(tables(schemaA)).toContain('shop.orders');
    expect(tables(schemaA)).not.toContain('inventory.items');
    expect(tables(schemaB)).toEqual(expect.arrayContaining(['shop.customers', 'inventory.items']));
    expect(tables(schemaB)).not.toContain('shop.orders');

    // Table data: the same table name, each database's own rows.
    const [customersA, customersB] = await Promise.all([
      gridRows(first.sid, 'shop', 'customers').then((r) => RowsPage.parse(r.json)),
      gridRows(second.sid, 'shop', 'customers').then((r) => RowsPage.parse(r.json)),
    ]);
    const names = (page: RowsPage) => page.rows.map((row) => row[page.columns.findIndex((c) => c.name === 'name')]);
    expect(names(customersA)).toEqual(['Ada', 'Grace', null]);
    expect(names(customersB)).toEqual(['Zed']);
  });

  it('a search_path set in one session never reaches the other', async () => {
    const first = await open(await favorite({ nickname: 'first' }));
    const second = await open(await favorite({ nickname: 'second', database: SECOND_DB }));

    await rowsOf(query(first.sid, 'set search_path = shop'));
    await rowsOf(query(second.sid, 'set search_path = inventory'));
    expect(await rowsOf(query(first.sid, 'show search_path'))).toEqual([['shop']]);
    expect(await rowsOf(query(second.sid, 'show search_path'))).toEqual([['inventory']]);
    // Unqualified names resolve in each session's own schema and database.
    expect(await rowsOf(query(first.sid, 'select count(*) from orders'))).toEqual([['4']]);
    expect(await rowsOf(query(second.sid, 'select label from items order by id'))).toEqual([['bolt'], ['nut']]);
    const missing = await query(second.sid, 'select count(*) from orders');
    expect(missing.json?.code).toBe('42P01');

    // A third session on the first favorite starts from the server's default, not from `shop`.
    const third = await open(first.connection.id);
    expect(await rowsOf(query(third.sid, 'show search_path'))).toEqual([['"$user", public']]);
  });

  it('a query cancelled in one session leaves the same qid running in the other', async () => {
    const a = await open(await favorite({ nickname: 'a' }));
    const b = await open(await favorite({ nickname: 'b' }));
    // Same qid and tab id in both: they are scoped by session, as the windows reuse them.
    const ids = { qid: 'q-sleep', tabId: 'tab-1' };
    const sleepA = query(a.sid, 'select pg_sleep(60) as in_a', ids);
    let bSettled = false;
    const sleepB = query(b.sid, 'select pg_sleep(60) as in_b', ids).finally(() => {
      bSettled = true;
    });
    await waitUntil(async () => (await running('as in_a')) === 1 && (await running('as in_b')) === 1);

    expect((await call('POST', `/sessions/${a.sid}/queries/q-sleep/cancel`)).status).toBe(204);
    const cancelled = await sleepA;
    expect(cancelled.status).toBe(400);
    expect(cancelled.json?.code).toBe('57014');

    // B answers another tab meanwhile, and its own pg_sleep is still running.
    expect(await rowsOf(query(b.sid, 'select 42', { tabId: 'tab-2' }))).toEqual([['42']]);
    // Longer than the cancel's repeated signals (5 × 150 ms), so a stray one would have landed.
    await new Promise((resolve) => setTimeout(resolve, 1000));
    expect(await running('as in_b')).toBe(1);
    expect(bSettled).toBe(false);
    // A's tab is usable again.
    expect(await rowsOf(query(a.sid, 'select 1', ids))).toEqual([['1']]);

    const historyA = HistoryEntry.array().parse((await call('GET', `/history/${a.connection.id}`)).json);
    expect(historyA.find((e) => e.sql.includes('in_a'))).toMatchObject({ cancelled: true });
    const historyB = HistoryEntry.array().parse((await call('GET', `/history/${b.connection.id}`)).json);
    expect(historyB.some((e) => e.sql.includes('in_b'))).toBe(false);

    expect((await call('POST', `/sessions/${b.sid}/queries/q-sleep/cancel`)).status).toBe(204);
    expect((await sleepB).json?.code).toBe('57014');
  });

  it('a statement timeout given to one session does not apply to the other', async () => {
    const connectionId = await favorite();
    const a = await open(connectionId, { statementTimeoutSeconds: 1 });
    const b = await open(connectionId);
    expect(await rowsOf(query(a.sid, 'show statement_timeout'))).toEqual([['1s']]);
    expect(await rowsOf(query(b.sid, 'show statement_timeout'))).toEqual([['0']]);

    const [slowA, slowB] = await Promise.all([
      query(a.sid, 'select 1 as n from pg_sleep(1.5)'),
      query(b.sid, 'select 1 as n from pg_sleep(1.5)'),
    ]);
    expect(slowA.json?.code).toBe('57014');
    expect(await rowsOf(slowB)).toEqual([['1']]);

    // The pooled clients (grid) follow their own session's setting too. The id test comes first,
    // so only one row sleeps.
    const where = 'id = 1 and pg_sleep(1.5) is not null';
    const [gridA, gridB] = await Promise.all([
      gridRows(a.sid, 'shop', 'customers', where),
      gridRows(b.sid, 'shop', 'customers', where),
    ]);
    expect(gridA.json?.code).toBe('57014');
    expect(RowsPage.parse(gridB.json).rows).toHaveLength(1);
  });

  it('a read-only and a writable session on one database: only the writable one writes, and both see it', async () => {
    await db.sql('create table shop.multi_notes (id int primary key, body text not null)');
    const ro = await open(await favorite({ nickname: 'ro', readOnly: true }));
    const rw = await open(await favorite({ nickname: 'rw' }));
    const notes = { schema: 'shop', name: 'multi_notes' };

    const [roEdit, roQuery, rwEdit, rwQuery] = await Promise.all([
      call('POST', `/sessions/${ro.sid}/edits`, {
        edits: [{ kind: 'insert', table: notes, values: { id: '1', body: 'from ro' } }],
      }),
      query(ro.sid, "insert into shop.multi_notes values (2, 'from ro')"),
      call('POST', `/sessions/${rw.sid}/edits`, {
        edits: [{ kind: 'insert', table: notes, values: { id: '1', body: 'from rw' } }],
      }),
      query(rw.sid, "insert into shop.multi_notes values (3, 'typed in rw')"),
    ]);
    expect(roEdit.status).toBe(403);
    expect(roQuery.json?.code).toBe('25006');
    expect(rwEdit.status).toBe(200);
    expect(rwQuery.status).toBe(200);

    expect(await rowsOf(query(ro.sid, 'show default_transaction_read_only'))).toEqual([['on']]);
    expect(await rowsOf(query(rw.sid, 'show default_transaction_read_only'))).toEqual([['off']]);

    // The writable session's commits are visible to the read-only one, in the grid and in a query.
    const page = RowsPage.parse((await gridRows(ro.sid, 'shop', 'multi_notes')).json);
    expect(page.rows).toEqual([
      ['1', 'from rw'],
      ['3', 'typed in rw'],
    ]);
    expect(await rowsOf(query(ro.sid, 'select body from shop.multi_notes order by id'))).toEqual([
      ['from rw'],
      ['typed in rw'],
    ]);
  });

  it("closing a session cancels its export and import jobs, not the other session's", async () => {
    // An import that cannot finish on its own: every row waits in a trigger.
    await db.sql(`
      create table shop.slow_import (id serial primary key, name text);
      create function shop.slow_row() returns trigger language plpgsql as $$
        begin perform pg_sleep(60); return new; end $$;
      create trigger slow_row before insert on shop.slow_import for each row execute function shop.slow_row();
      create table shop.fast_import (id serial primary key, name text);`);
    const csv = join(dir, 'people.csv');
    writeFileSync(csv, 'name\nada\ngrace\n');
    const importBody = (jobId: string, name: string) => ({
      jobId,
      table: { schema: 'shop', name },
      path: csv,
      delimiter: ',',
      hasHeader: true,
      mapping: [{ fileColumn: 0, column: 'name' }],
    });
    const exportBody = (jobId: string, sql: string) => ({
      jobId,
      source: { kind: 'query', sql },
      format: 'csv',
      path: join(dir, `${jobId}.csv`),
    });

    const a = await open(await favorite({ nickname: 'a' }));
    const b = await open(await favorite({ nickname: 'b' }));
    for (const [sid, path, body] of [
      [a.sid, 'exports', exportBody('a-export', 'select pg_sleep(60) as a_export')],
      [a.sid, 'imports', importBody('a-import', 'slow_import')],
      [b.sid, 'exports', exportBody('b-export', 'select pg_sleep(60) as b_export')],
    ] as const) {
      expect((await call('POST', `/sessions/${sid}/${path}`, body)).status).toBe(202);
    }
    await waitUntil(
      async () =>
        (await running('as a_export')) === 1 &&
        (await running('slow_import"')) === 1 &&
        (await running('as b_export')) === 1,
    );

    expect((await call('DELETE', `/sessions/${a.sid}`)).status).toBe(204);
    // The close waits for A's jobs to stop: they are cancelled by the time it answers.
    expect(await jobStatus('a-export')).toMatchObject({ state: 'cancelled' });
    expect(await jobStatus('a-import')).toMatchObject({ state: 'cancelled' });
    const aExport = join(dir, 'a-export.csv');
    expect(existsSync(aExport) || existsSync(`${aExport}${PARTIAL_SUFFIX}`)).toBe(false);
    expect((await db.sql('select count(*)::int as n from shop.slow_import')).rows[0].n).toBe(0);
    await waitUntil(async () => (await running('as a_export')) + (await running('slow_import"')) === 0);

    // B's job is untouched, and B still starts and finishes new work.
    expect(await jobStatus('b-export')).toMatchObject({ state: 'running' });
    expect(await running('as b_export')).toBe(1);
    expect((await call('POST', `/sessions/${b.sid}/imports`, importBody('b-import', 'fast_import'))).status).toBe(202);
    await waitUntil(async () => (await jobStatus('b-import')).state !== 'running');
    expect(await jobStatus('b-import')).toMatchObject({ state: 'done', rows: 2 });
    expect(await rowsOf(query(b.sid, 'select name from shop.fast_import order by id'))).toEqual([['ada'], ['grace']]);

    expect((await call('POST', '/jobs/b-export/cancel')).status).toBe(204);
    await waitUntil(async () => (await jobStatus('b-export')).state === 'cancelled');
  });

  it("deleting a favorite closes that favorite's sessions only", async () => {
    const doomed = await favorite({ nickname: 'doomed' });
    const kept = await favorite({ nickname: 'kept' });
    const a1 = await open(doomed);
    const a2 = await open(doomed);
    const b = await open(kept);
    const sleepA = query(a1.sid, 'select pg_sleep(60) as doomed_sleep');
    let bSettled = false;
    const sleepB = query(b.sid, 'select pg_sleep(60) as kept_sleep').finally(() => {
      bSettled = true;
    });
    await waitUntil(async () => (await running('doomed_sleep')) === 1 && (await running('kept_sleep')) === 1);

    expect((await call('DELETE', `/connections/${doomed}`)).status).toBe(204);
    for (const sid of [a1.sid, a2.sid]) {
      const gone = await call('GET', `/sessions/${sid}`);
      expect(gone.status).toBe(404);
      expect(gone.json?.code).toBe('KLEOS_SESSION_NOT_FOUND');
    }
    expect((await sleepA).status).not.toBe(200);
    await waitUntil(async () => (await running('doomed_sleep')) === 0);

    expect((await call('GET', `/sessions/${b.sid}`)).status).toBe(200);
    expect(await rowsOf(query(b.sid, 'select 1', { tabId: 'tab-2' }))).toEqual([['1']]);
    expect(await running('kept_sleep')).toBe(1);
    expect(bSettled).toBe(false);
    const ids = SavedConnection.array()
      .parse((await call('GET', '/connections')).json)
      .map((c) => c.id);
    expect(ids).toContain(kept);
    expect(ids).not.toContain(doomed);

    await call('DELETE', `/sessions/${b.sid}`);
    expect((await sleepB).status).not.toBe(200);
  });

  it('one favorite opened twice gives two independent sessions; closing one leaves the other usable', async () => {
    const connectionId = await favorite();
    const a = await open(connectionId);
    const b = await open(connectionId);
    expect(a.sid).not.toBe(b.sid);

    const [pidA, pidB] = await Promise.all([
      rowsOf(query(a.sid, 'select pg_backend_pid()', { qid: 'q-pid', tabId: 'tab-1' })),
      rowsOf(query(b.sid, 'select pg_backend_pid()', { qid: 'q-pid', tabId: 'tab-1' })),
    ]);
    expect(pidA).not.toEqual(pidB);
    // A transaction left open in A's tab is A's alone.
    await rowsOf(query(a.sid, 'begin'));
    await rowsOf(query(a.sid, "insert into shop.audit_log (message) values ('uncommitted in a')"));
    expect(
      await rowsOf(query(b.sid, "select count(*) from shop.audit_log where message = 'uncommitted in a'")),
    ).toEqual([['0']]);

    expect((await call('DELETE', `/sessions/${a.sid}`)).status).toBe(204);
    expect((await call('GET', `/sessions/${a.sid}/schema`)).status).toBe(404);
    // A's open transaction ended with its session, rolled back.
    expect(
      (await db.sql("select count(*)::int as n from shop.audit_log where message = 'uncommitted in a'")).rows[0].n,
    ).toBe(0);

    expect(SessionInfo.parse((await call('GET', `/sessions/${b.sid}`)).json).connection.id).toBe(connectionId);
    expect(await rowsOf(query(b.sid, 'select 1'))).toEqual([['1']]);
    expect(SchemaModel.parse((await call('GET', `/sessions/${b.sid}/schema`)).json).tables.length).toBeGreaterThan(0);
    expect(RowsPage.parse((await gridRows(b.sid, 'shop', 'orders')).json).rows).toHaveLength(4);
  });

  // Before 0.7.2 the close waited for the pool to drain, so this DELETE answered only once the
  // 60 s statement had finished on its own (and the server's shutdown did the same).
  it('closing a session cancels a slow grid request on its pool and ends its backend', async () => {
    const s = await open(await favorite());
    const grid = gridRows(s.sid, 'shop', 'customers', 'pg_sleep(60) is not null and true');
    await waitUntil(async () => (await running('pg_sleep(60) is not null and true')) === 1);
    const started = Date.now();
    expect((await call('DELETE', `/sessions/${s.sid}`)).status).toBe(204);
    expect(Date.now() - started).toBeLessThan(5000);
    expect((await grid).status).not.toBe(200);
    await waitUntil(async () => (await allKleosBackends()) === 0);
  });

  it('opening and closing sessions, some mid-query, leaves no Kleos backend behind', async () => {
    await waitUntil(async () => (await allKleosBackends()) === 0);
    const connectionId = await favorite();
    for (let i = 0; i < 6; i += 1) {
      const s = await open(connectionId);
      expect(await rowsOf(query(s.sid, `select ${i}`))).toEqual([[String(i)]]);
      const inFlight: Promise<Reply>[] = [];
      if (i % 2 === 0) {
        // Still running when the session closes: a query tab, and an export job.
        inFlight.push(query(s.sid, `select pg_sleep(60) as leak_${i}`, { tabId: 'tab-2' }));
        await call('POST', `/sessions/${s.sid}/exports`, {
          jobId: `leak-export-${i}`,
          source: { kind: 'query', sql: `select pg_sleep(60) as leak_export_${i}` },
          format: 'csv',
          path: join(dir, `leak-${i}.csv`),
        });
        await waitUntil(
          async () => (await running(`as leak_${i}`)) === 1 && (await running(`as leak_export_${i}`)) === 1,
        );
      }
      expect((await call('DELETE', `/sessions/${s.sid}`)).status).toBe(204);
      for (const reply of await Promise.all(inFlight)) expect(reply.status).not.toBe(200);
    }
    await waitUntil(async () => (await allKleosBackends()) === 0);
  });

  it('a session on Postgres 16 and one on 17 each report and answer with their own version', async () => {
    const [on16, on17] = await Promise.all([
      favorite({ nickname: 'pg16' }, db16).then((id) => open(id)),
      favorite({ nickname: 'pg17' }).then((id) => open(id)),
    ]);
    expect(on16.serverVersionShort).toMatch(/^16\./);
    expect(on17.serverVersionShort).toMatch(/^17\./);
    const [num16, num17] = await Promise.all([
      rowsOf(query(on16.sid, "select current_setting('server_version_num')::int / 10000")),
      rowsOf(query(on17.sid, "select current_setting('server_version_num')::int / 10000")),
    ]);
    expect(num16).toEqual([['16']]);
    expect(num17).toEqual([['17']]);
    // The monitor reads catalogs whose columns differ between majors (checkpointer stats moved in 17).
    for (const kind of statsKinds) {
      const [r16, r17] = await Promise.all([
        call('GET', `/sessions/${on16.sid}/stats/${kind}`),
        call('GET', `/sessions/${on17.sid}/stats/${kind}`),
      ]);
      expect(r16.status, `16 ${kind}`).toBe(200);
      expect(r17.status, `17 ${kind}`).toBe(200);
    }
    await call('DELETE', `/sessions/${on16.sid}`);
    await waitUntil(async () => (await allKleosBackends(db16)) === 0);
  });
});
