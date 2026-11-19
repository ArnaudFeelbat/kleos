import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { SavedConnection, SessionInfo } from '@kleos/shared';
import { createPostgresAdapter } from '../../src/adapter/postgres';
import type { Session } from '../../src/adapter/types';
import { createApp } from '../../src/http/app';
import { SessionRegistry } from '../../src/sessions/registry';
import { createMemorySecretStore } from '../../src/store/keychain';
import { createSqliteStore } from '../../src/store/sqlite';
import type { AppStore } from '../../src/store/types';
import { type TestDatabase, rejectionOf, startPostgres } from '../helpers/postgres';

/**
 * Writes that leave the database through an extension, on a read-only favorite. postgres_fdw
 * goes through the local executor, which refuses any write in a read-only transaction; dblink
 * opens its own connection, which read-only cannot cover, hence the session notice.
 */
const PORT = 47002;
const TOKEN = 'remote-token-'.padEnd(64, 'x');
const adapter = createPostgresAdapter();

let db: TestDatabase;
let remote: pg.Client;
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

/** Rows of the table the foreign table points at, read on the remote database itself. */
const remoteNotes = async () =>
  (await remote.query<{ id: number; body: string }>('select id, body from notes order by id')).rows;

beforeAll(async () => {
  db = await startPostgres({ seeds: ['shop.sql'] });
  // The "other server": another database of the same instance, reached over TCP by postgres_fdw.
  await db.sql('create database remote');
  remote = new pg.Client({ ...db.config, database: 'remote', password: db.password });
  await remote.connect();
  await remote.query(`create table notes (id int primary key, body text not null);
                      insert into notes values (1, 'original')`);
  const quote = (value: string) => `'${value.replace(/'/g, "''")}'`;
  await db.sql(`create extension postgres_fdw;
                create server other foreign data wrapper postgres_fdw
                  options (host 'localhost', port '5432', dbname 'remote');
                create user mapping for current_user server other
                  options (user ${quote(db.config.user)}, password ${quote(db.password)});
                create schema far;
                create foreign table far.notes (id int, body text) server other options (schema_name 'public', table_name 'notes');
                create function far.write_note() returns boolean language plpgsql as $$
                  begin insert into far.notes values (99, 'from a function'); return true; end $$;`);

  store = createSqliteStore(':memory:');
  sessions = new SessionRegistry();
  app = createApp(
    { adapter, store, secrets: createMemorySecretStore(), sessions, version: 'remote' },
    { token: TOKEN, getPort: () => PORT },
  );
});

afterAll(async () => {
  await sessions?.closeAll();
  store?.close();
  await remote?.end();
  await db?.stop();
});

describe('postgres_fdw on a read-only session', () => {
  let session: Session;
  let qids = 0;
  const run = (sql: string) => {
    qids += 1;
    return session.runQuery(sql, { qid: `q${qids}`, tabId: 'fdw', pageSize: 100 });
  };

  beforeAll(async () => {
    session = await adapter.connect({ ...db.config, readOnly: true }, db.password);
  });

  afterAll(async () => {
    await session?.close();
  });

  it('reads the foreign table', async () => {
    expect((await run('select id, body from far.notes')).rows).toEqual([['1', 'original']]);
  });

  it('refuses INSERT, UPDATE, DELETE and a writing function on it in a query tab, with 25006', async () => {
    for (const sql of [
      `insert into far.notes values (2, 'leaked')`,
      `update far.notes set body = 'leaked'`,
      `delete from far.notes`,
      `select far.write_note()`,
      `with w as (insert into far.notes values (3, 'leaked') returning id) select * from w`,
    ]) {
      expect((await rejectionOf(run(sql))).code, sql).toBe('25006');
    }
    // A flip of the session default is undone before the next statement, as for local tables.
    await run(`select set_config('default_transaction_read_only', 'off', false)`);
    expect((await rejectionOf(run(`insert into far.notes values (4, 'leaked')`))).code).toBe('25006');
    expect(await remoteNotes()).toEqual([{ id: 1, body: 'original' }]);
  });

  it('refuses a grid edit of it through the HTTP route with KLEOS_READ_ONLY', async () => {
    const created = await call('POST', '/connections', {
      nickname: 'read-only',
      host: db.config.host,
      port: db.config.port,
      user: db.config.user,
      database: db.config.database,
      sslMode: 'disable',
      color: 'none',
      readOnly: true,
      password: db.password,
      savePassword: true,
    });
    const connectionId = SavedConnection.parse(created.json).id;
    const opened = await call('POST', '/sessions', { connectionId });
    const { sid } = SessionInfo.parse(opened.json);

    const table = { schema: 'far', name: 'notes' };
    for (const edit of [
      { kind: 'update', table, key: { id: '1' }, set: { body: 'leaked' } },
      { kind: 'insert', table, values: { id: '5', body: 'leaked' } },
      { kind: 'delete', table, key: { id: '1' } },
    ]) {
      const res = await call('POST', `/sessions/${sid}/edits`, { edits: [edit] });
      expect(res.status, edit.kind).toBe(403);
      expect(res.json).toMatchObject({ code: 'KLEOS_READ_ONLY' });
    }
    expect(await remoteNotes()).toEqual([{ id: 1, body: 'original' }]);
  });
});

describe('the dblink notice', () => {
  const readOnly = () => adapter.connect({ ...db.config, readOnly: true }, db.password);

  it('is absent while dblink is not installed', async () => {
    const session = await readOnly();
    expect(session.notices).toEqual([]);
    await session.close();
  });

  it('warns read-only sessions once dblink is installed, and only them', async () => {
    await db.sql('create extension dblink');
    const ro = await readOnly();
    const rw = await adapter.connect(db.config, db.password);
    try {
      expect(ro.notices).toEqual([
        {
          code: 'READ_ONLY_DBLINK',
          message:
            'dblink is installed in this database: dblink_exec can still write, here or on other servers, even on a read-only connection.',
        },
      ]);
      expect(rw.notices).toEqual([]);

      // Why the notice exists: dblink_exec writes through its own connection, read-only or not.
      const target = `host=localhost port=5432 dbname=remote user=${db.config.user} password=${db.password}`;
      const written = await ro.runQuery(
        `select dblink_exec('${target}', $$insert into notes values (7, 'through dblink')$$)`,
        { qid: 'dblink', tabId: 'dblink', pageSize: 10 },
      );
      expect(written.rows).toEqual([['INSERT 0 1']]);
      expect(await remoteNotes()).toContainEqual({ id: 7, body: 'through dblink' });
    } finally {
      await ro.close();
      await rw.close();
    }
  });

  it('is part of SessionInfo over HTTP', async () => {
    const created = await call('POST', '/connections', {
      nickname: 'read-only 2',
      host: db.config.host,
      port: db.config.port,
      user: db.config.user,
      database: db.config.database,
      sslMode: 'disable',
      color: 'none',
      readOnly: true,
      password: db.password,
      savePassword: true,
    });
    const connectionId = SavedConnection.parse(created.json).id;
    const info = SessionInfo.parse((await call('POST', '/sessions', { connectionId })).json);
    expect(info.notices?.map((n) => n.code)).toEqual(['READ_ONLY_DBLINK']);
  });
});
