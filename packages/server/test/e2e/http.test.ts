// End to end through the HTTP API: real routes, real Postgres adapter, a Postgres
// container. Complements the route tests (fake adapter) and adapter tests (no HTTP).
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  ExplainResult,
  HistoryEntry,
  QueryPage,
  QueryStarted,
  RowsPage,
  SavedConnection,
  SchemaModel,
  SessionInfo,
  statsKinds,
} from '@kleos/shared';
import { createPostgresAdapter } from '../../src/adapter/postgres';
import { createApp } from '../../src/http/app';
import { SessionRegistry } from '../../src/sessions/registry';
import { createMemorySecretStore } from '../../src/store/keychain';
import { createSqliteStore } from '../../src/store/sqlite';
import type { AppStore } from '../../src/store/types';
import { startPostgres, type TestDatabase } from '../helpers/postgres';

const PORT = 47001;
const TOKEN = 'e2e-token-'.padEnd(64, 'x');

let db: TestDatabase;
let store: AppStore;
let sessions: SessionRegistry;
let app: ReturnType<typeof createApp>;

async function call(method: string, path: string, body?: unknown) {
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

function connectionBody(overrides: Record<string, unknown> = {}) {
  return {
    nickname: 'e2e',
    host: db.config.host,
    port: db.config.port,
    user: db.config.user,
    database: db.config.database,
    sslMode: 'disable',
    color: 'none',
    readOnly: false,
    password: db.password,
    savePassword: true,
    ...overrides,
  };
}

beforeAll(async () => {
  db = await startPostgres({ seeds: ['shop.sql'] });
  store = createSqliteStore(':memory:');
  sessions = new SessionRegistry();
  app = createApp(
    { adapter: createPostgresAdapter(), store, secrets: createMemorySecretStore(), sessions, version: 'e2e' },
    { token: TOKEN, getPort: () => PORT },
  );
});

afterAll(async () => {
  await sessions?.closeAll();
  store?.close();
  await db?.stop();
});

describe('Kleos over HTTP against Postgres', () => {
  let connectionId = '';
  let sid = '';

  it('saves a favorite, tests it with the stored password and opens a session', async () => {
    const created = await call('POST', '/connections', connectionBody());
    expect(created.status).toBe(200);
    connectionId = SavedConnection.parse(created.json).id;

    const tested = await call('POST', '/connections/test', {
      ...connectionBody(),
      password: null,
      connectionId,
    });
    expect(tested.status).toBe(200);
    expect(String(tested.json?.version)).toMatch(/PostgreSQL 17/);

    const opened = await call('POST', '/sessions', { connectionId });
    expect(opened.status).toBe(200);
    const info = SessionInfo.parse(opened.json);
    expect(info.serverVersionShort).toMatch(/^17\./);
    sid = info.sid;
  });

  it('asks for a password when none is stored or given', async () => {
    const created = await call('POST', '/connections', connectionBody({ password: null, savePassword: false }));
    const id = SavedConnection.parse(created.json).id;
    const opened = await call('POST', '/sessions', { connectionId: id });
    expect(opened.status).toBe(401);
    expect(opened.json?.code).toBe('KLEOS_PASSWORD_REQUIRED');
    const withPassword = await call('POST', '/sessions', { connectionId: id, password: db.password });
    expect(withPassword.status).toBe(200);
  });

  it('introspects, pages rows and applies edits, naming the failing cell', async () => {
    const schema = SchemaModel.parse((await call('GET', `/sessions/${sid}/schema`)).json);
    const orders = schema.tables.find((t) => t.schema === 'shop' && t.name === 'orders');
    expect(orders?.primaryKey).toEqual(['id']);

    const page = RowsPage.parse(
      (
        await call('POST', `/sessions/${sid}/rows`, {
          table: { schema: 'shop', name: 'orders' },
          limit: 2,
          offset: 0,
          sort: [{ column: 'id', dir: 'asc' }],
          filters: [],
        })
      ).json,
    );
    expect(page.rows).toHaveLength(2);
    const idCol = page.columns.findIndex((c) => c.name === 'id');
    const firstId = page.rows[0]![idCol]!;

    const bad = await call('POST', `/sessions/${sid}/edits`, {
      edits: [
        { kind: 'update', table: { schema: 'shop', name: 'orders' }, key: { id: firstId }, set: { note: 'ok' } },
        { kind: 'update', table: { schema: 'shop', name: 'orders' }, key: { id: firstId }, set: { total: 'abc' } },
      ],
    });
    expect(bad.status).toBe(400);
    expect(bad.json).toMatchObject({ code: '22P02', editIndex: 1, column: 'total' });

    const good = await call('POST', `/sessions/${sid}/edits`, {
      edits: [
        { kind: 'update', table: { schema: 'shop', name: 'orders' }, key: { id: firstId }, set: { total: '12.50' } },
      ],
    });
    expect(good.status).toBe(200);
    // The failed batch rolled back as a whole: note was not changed by it.
    const check = await db.sql('select note, total::text as total from shop.orders where id = $1', [firstId]);
    expect(check.rows[0]).toMatchObject({ total: '12.50' });
    expect(check.rows[0]?.note).not.toBe('ok');
  });

  it('pages a query, underlines errors and records history', async () => {
    const started = await call('POST', `/sessions/${sid}/queries`, {
      qid: 'q-page',
      tabId: 'tab-1',
      sql: 'select g from generate_series(1, 1200) g',
      pageSize: 500,
    });
    const first = QueryStarted.parse(started.json);
    expect(first.rows).toHaveLength(500);
    expect(first.hasMore).toBe(true);
    const second = QueryPage.parse((await call('GET', `/sessions/${sid}/queries/q-page/page?size=500`)).json);
    expect(second.rows[0]).toEqual(['501']);
    expect((await call('DELETE', `/sessions/${sid}/queries/q-page`)).status).toBe(204);

    const failed = await call('POST', `/sessions/${sid}/queries`, {
      qid: 'q-err',
      tabId: 'tab-1',
      sql: 'select o.stauts from shop.orders o',
    });
    expect(failed.status).toBe(400);
    expect(failed.json).toMatchObject({ code: '42703', position: 8 });

    const history = HistoryEntry.array().parse((await call('GET', `/history/${connectionId}`)).json);
    expect(history[0]?.error).toMatch(/^42703 /);
  });

  it('binds parameters, answers a missing value with 08P01 and finds the runs by search (0.7)', async () => {
    const bound = await call('POST', `/sessions/${sid}/queries`, {
      qid: 'q-params',
      tabId: 'tab-1',
      sql: 'select name from shop.customers where email = $1 or name is not distinct from $2 order by id',
      params: ['grace@example.com', null],
    });
    expect(bound.status).toBe(200);
    expect(QueryStarted.parse(bound.json).rows).toEqual([['Grace'], [null]]);

    const missing = await call('POST', `/sessions/${sid}/queries`, {
      qid: 'q-params-missing',
      tabId: 'tab-1',
      sql: 'select $1::int + $2::int',
      params: ['1'],
    });
    expect(missing.status).toBe(400);
    expect(missing.json).toEqual({
      code: '08P01',
      message: 'bind message supplies 1 parameters, but prepared statement "" requires 2',
    });

    const found = HistoryEntry.array().parse((await call('GET', '/history?q=bind%20message&outcome=error')).json);
    expect(found.map((e) => e.sql)).toEqual(['select $1::int + $2::int']);
    const ok = HistoryEntry.array().parse(
      (await call('GET', `/history?q=customers%20email&connectionId=${connectionId}&outcome=ok`)).json,
    );
    expect(ok[0]?.sql).toMatch(/^select name from shop.customers where email = \$1/);
  });

  it('cancels pg_sleep(60) within a second', async () => {
    const t0 = Date.now();
    const running = call('POST', `/sessions/${sid}/queries`, {
      qid: 'q-sleep',
      tabId: 'tab-2',
      sql: 'select pg_sleep(60)',
    });
    await new Promise((r) => setTimeout(r, 300));
    const cancelAt = Date.now();
    expect((await call('POST', `/sessions/${sid}/queries/q-sleep/cancel`)).status).toBe(204);
    const result = await running;
    const latency = Date.now() - cancelAt;
    expect(result.status).toBe(400);
    expect(result.json?.code).toBe('57014');
    expect(latency).toBeLessThan(1000);
    expect(Date.now() - t0).toBeLessThan(5000);
    const history = HistoryEntry.array().parse((await call('GET', `/history/${connectionId}`)).json);
    expect(history[0]).toMatchObject({ sql: 'select pg_sleep(60)', cancelled: true });
  });

  it('explains without side effects and answers every stats kind', async () => {
    const before = await db.sql('select count(*)::int as n from shop.customers');
    const explained = await call('POST', `/sessions/${sid}/explain`, {
      qid: 'q-explain',
      tabId: 'tab-1',
      sql: "insert into shop.customers (email) values ('explain@example.com')",
    });
    expect(explained.status).toBe(200);
    expect(ExplainResult.parse(explained.json).plan['Node Type']).toBe('ModifyTable');
    const after = await db.sql('select count(*)::int as n from shop.customers');
    expect(after.rows[0].n).toBe(before.rows[0].n);

    for (const kind of statsKinds) {
      const res = await call('GET', `/sessions/${sid}/stats/${kind}`);
      expect(res.status, kind).toBe(200);
      expect(res.json?.kind).toBe(kind);
    }
  });

  it('refuses writes on a read-only connection, in edits and in queries', async () => {
    const created = await call('POST', '/connections', connectionBody({ nickname: 'ro', readOnly: true }));
    const id = SavedConnection.parse(created.json).id;
    const roSid = SessionInfo.parse((await call('POST', '/sessions', { connectionId: id })).json).sid;
    const edit = await call('POST', `/sessions/${roSid}/edits`, {
      edits: [{ kind: 'delete', table: { schema: 'shop', name: 'orders' }, key: { id: '1' } }],
    });
    expect(edit.status).toBe(403);
    const query = await call('POST', `/sessions/${roSid}/queries`, {
      qid: 'q-ro',
      tabId: 'tab-ro',
      sql: 'delete from shop.orders',
    });
    expect(query.json?.code).toBe('25006');
  });

  it('closes the session', async () => {
    expect((await call('DELETE', `/sessions/${sid}`)).status).toBe(204);
    const gone = await call('GET', `/sessions/${sid}/schema`);
    expect(gone.status).toBe(404);
    expect(gone.json?.code).toBe('KLEOS_SESSION_NOT_FOUND');
  });
});
