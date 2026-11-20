import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DdlChange, kleosErrorCodes } from '@kleos/shared';
import { createPostgresAdapter } from '../../src/adapter/postgres';
import type { DdlJob, Session } from '../../src/adapter/types';
import { KleosError } from '../../src/errors';
import { type TestDatabase, rejectionOf, startPostgres } from '../helpers/postgres';

/**
 * Schema editing (0.6) against a real Postgres: types resolved by Postgres, one transaction
 * per batch, a failure rolls everything back and names its statement.
 */
let db: TestDatabase;
let session: Session;

beforeAll(async () => {
  db = await startPostgres();
  await db.sql(`
    create schema ws;
    create schema "Other Schema";
    create type "Other Schema"."Mood" as enum ('calm', 'busy');
    create domain ws.positive as int not null check (value > 0);
    create domain ws.short as varchar(10);
    create table ws.items (id int primary key, code text, label text);
    insert into ws.items values (1, '10', 'a'), (2, '20', null), (3, null, 'c');
  `);
  session = await createPostgresAdapter().connect(db.config, db.password);
});

afterAll(async () => {
  await session?.close();
  await db?.stop();
});

const items = { schema: 'ws', name: 'items' };
const jobs = (...changes: DdlChange[]): DdlJob[] => changes.map((c) => DdlChange.parse(c));

function kleos(err: unknown): KleosError {
  expect(err).toBeInstanceOf(KleosError);
  return err as KleosError;
}

/** Every relation, column, index and type of the user schemas: what a preview must leave alone. */
async function catalogSnapshot(): Promise<string> {
  const { rows } = await db.sql(`
    select string_agg(format('%s.%s %s %s', n.nspname, c.relname, c.relkind, a.attname || ':' || format_type(a.atttypid, a.atttypmod) ||
                      ':' || a.attnotnull || ':' || coalesce(pg_get_expr(d.adbin, d.adrelid), '')), ',' order by 1) as s
      from pg_class c
      join pg_namespace n on n.oid = c.relnamespace
      left join pg_attribute a on a.attrelid = c.oid and a.attnum > 0 and not a.attisdropped
      left join pg_attrdef d on d.adrelid = c.oid and d.adnum = a.attnum
     where n.nspname in ('ws', 'Other Schema')`);
  return rows[0].s as string;
}

describe('previewDdl', () => {
  it("writes each type in Postgres's own spelling, and that SQL runs", async () => {
    const changes = jobs({
      op: 'createTable',
      schema: 'ws',
      name: 'typed',
      columns: [
        { name: 'id', type: 'bigserial', nullable: false },
        { name: 'a', type: 'VARCHAR(80)' },
        { name: 'b', type: 'timestamptz' },
        { name: 'c', type: 'int[]' },
        { name: 'd', type: 'numeric( 12, 2 )' },
        { name: 'e', type: '"Other Schema"."Mood"' },
        { name: 'f', type: 'ws.positive', nullable: false, default: '1' },
        { name: 'g', type: 'double precision' },
        { name: 'h', type: 'interval day to second(3)' },
        { name: 'i', type: 'timestamp(3) without time zone' },
        { name: 'j', type: 'float' },
        { name: 'k', type: 'ws.positive[]' },
        { name: 'l', type: 'ws.short' },
      ],
      primaryKey: ['id'],
    });
    const { statements } = await session.previewDdl(changes);
    expect(statements).toEqual([
      'create table "ws"."typed" ("id" bigserial not null, "a" character varying(80), "b" timestamp with time zone, ' +
        '"c" integer[], "d" numeric(12,2), "e" "Other Schema"."Mood", "f" ws.positive not null default 1, ' +
        '"g" double precision, "h" interval day to second(3), "i" timestamp(3) without time zone, ' +
        '"j" double precision, "k" ws.positive[], "l" ws.short, primary key ("id"))',
    ]);
    expect((await session.applyDdl(changes)).statements).toEqual(statements);
    const { rows } = await db.sql(
      `select string_agg(format_type(atttypid, atttypmod), ', ' order by attnum) as types
         from pg_attribute where attrelid = 'ws.typed'::regclass and attnum > 0`,
    );
    expect(rows[0].types).toBe(
      'bigint, character varying(80), timestamp with time zone, integer[], numeric(12,2), "Other Schema"."Mood", ' +
        'ws.positive, double precision, interval day to second(3), timestamp(3) without time zone, double precision, ' +
        'ws.positive[], ws.short',
    );
  });

  it('refuses an unknown type with KLEOS_VALIDATION naming the change and the type', async () => {
    const err = kleos(
      await rejectionOf(
        session.previewDdl(
          jobs(
            { op: 'addColumn', table: items, column: { name: 'x', type: 'text' } },
            { op: 'alterColumnType', table: items, column: 'code', type: 'txet' },
          ),
        ),
      ),
    );
    expect(err.status).toBe(400);
    expect(err.body).toEqual({
      code: kleosErrorCodes.validation,
      message: 'Change 2: unknown type "txet"',
      detail: 'type "txet" does not exist',
      statementIndex: 1,
    });
  });

  it('refuses a type modifier Postgres rejects', async () => {
    const err = kleos(
      await rejectionOf(
        session.previewDdl(jobs({ op: 'addColumn', table: items, column: { name: 'x', type: 'varchar(0)' } })),
      ),
    );
    expect(err.body).toMatchObject({ message: 'Change 1: unknown type "varchar(0)"', statementIndex: 0 });
    expect(err.body.detail).toMatch(/length for type varchar must be at least 1/);
  });

  it('never changes the database, even for a batch that would', async () => {
    const before = await catalogSnapshot();
    const preview = await session.previewDdl(
      jobs(
        { op: 'createTable', schema: 'ws', name: 'ghost', columns: [{ name: 'id', type: 'int' }] },
        { op: 'addColumn', table: items, column: { name: 'ghost', type: 'text' } },
        { op: 'setNotNull', table: items, column: 'label', notNull: true },
        { op: 'dropTable', table: items, cascade: true },
      ),
    );
    expect(preview.statements).toHaveLength(4);
    expect(await catalogSnapshot()).toBe(before);
    expect((await db.sql('select count(*)::int as n from ws.items')).rows[0].n).toBe(3);
  });

  it('works on a read-only session', async () => {
    const readOnly = await createPostgresAdapter().connect({ ...db.config, readOnly: true }, db.password);
    try {
      const { statements } = await readOnly.previewDdl(
        jobs({ op: 'addColumn', table: items, column: { name: 'x', type: 'int4' } }),
      );
      expect(statements).toEqual(['alter table "ws"."items" add column "x" integer']);
    } finally {
      await readOnly.close();
    }
  });
});

describe('applyDdl', () => {
  it('applies a CREATE TABLE, ADD COLUMN and CREATE INDEX batch, visible to introspection', async () => {
    const result = await session.applyDdl(
      jobs(
        {
          op: 'createTable',
          schema: 'ws',
          name: 'Order Lines',
          columns: [
            { name: 'id', type: 'serial', nullable: false },
            { name: 'Product', type: 'text', nullable: false, default: "'none'" },
            { name: 'qty', type: 'int' },
          ],
          primaryKey: ['id'],
        },
        {
          op: 'addColumn',
          table: { schema: 'ws', name: 'Order Lines' },
          column: { name: 'added_at', type: 'timestamptz', default: 'now()' },
        },
        {
          op: 'createIndex',
          table: { schema: 'ws', name: 'Order Lines' },
          name: 'lines_product',
          columns: ['Product', 'qty'],
          unique: true,
        },
      ),
    );
    expect(result.statements).toEqual([
      `create table "ws"."Order Lines" ("id" serial not null, "Product" text not null default 'none', "qty" integer, primary key ("id"))`,
      'alter table "ws"."Order Lines" add column "added_at" timestamp with time zone default now()',
      'create unique index "lines_product" on "ws"."Order Lines" using btree ("Product", "qty")',
    ]);
    expect(result.elapsedMs).toEqual(expect.any(Number));

    const model = await session.introspect();
    const table = model.tables.find((t) => t.schema === 'ws' && t.name === 'Order Lines')!;
    expect(table.primaryKey).toEqual(['id']);
    expect(table.columns.map((c) => [c.name, c.type, c.nullable, c.default])).toEqual([
      ['id', 'integer', false, `nextval('ws."Order Lines_id_seq"'::regclass)`],
      ['Product', 'text', false, `'none'::text`],
      ['qty', 'integer', true, null],
      ['added_at', 'timestamp with time zone', true, 'now()'],
    ]);
    expect(table.indexes.find((i) => i.name === 'lines_product')).toMatchObject({
      columns: ['Product', 'qty'],
      unique: true,
      method: 'btree',
    });
  });

  it('changes a column type with USING', async () => {
    await db.sql(
      `create table ws.codes (id int primary key, code text); insert into ws.codes values (1, '10'), (2, ' 7')`,
    );
    await session.applyDdl(
      jobs({
        op: 'alterColumnType',
        table: { schema: 'ws', name: 'codes' },
        column: 'code',
        type: 'int',
        using: 'trim(code)::integer',
      }),
    );
    const { rows } = await db.sql(`select code, pg_typeof(code)::text as type from ws.codes order by id`);
    expect(rows).toEqual([
      { code: 10, type: 'integer' },
      { code: 7, type: 'integer' },
    ]);
  });

  it('rolls the whole batch back when SET NOT NULL meets a NULL, and names that statement', async () => {
    const before = await catalogSnapshot();
    const err = kleos(
      await rejectionOf(
        session.applyDdl(
          jobs(
            { op: 'addColumn', table: items, column: { name: 'extra', type: 'text' } },
            { op: 'renameColumn', table: items, column: 'code', newName: 'sku' },
            { op: 'setNotNull', table: items, column: 'label', notNull: true },
            { op: 'renameTable', table: items, newName: 'never' },
          ),
        ),
      ),
    );
    expect(err.status).toBe(400);
    expect(err.body).toMatchObject({
      code: '23502',
      message: 'column "label" of relation "items" contains null values',
      statementIndex: 2,
    });
    // Nothing of the batch was applied, not even the statements before the failing one.
    expect(await catalogSnapshot()).toBe(before);
    // The pooled client went back clean: the next run works.
    await session.applyDdl(jobs({ op: 'setDefault', table: items, column: 'label', default: "'?'" }));
    await session.applyDdl(jobs({ op: 'setDefault', table: items, column: 'label', default: null }));
  });

  it("answers Postgres's position relative to the failing statement", async () => {
    const err = kleos(
      await rejectionOf(
        session.applyDdl(
          jobs(
            { op: 'addColumn', table: items, column: { name: 'tmp', type: 'text' } },
            { op: 'alterColumnType', table: items, column: 'code', type: 'int', using: 'no_such_column::integer' },
          ),
        ),
      ),
    );
    expect(err.body).toMatchObject({ code: '42703', statementIndex: 1 });
    const statement = 'alter table "ws"."items" alter column "code" type integer using no_such_column::integer';
    expect(statement.slice((err.body.position ?? 0) - 1)).toMatch(/^no_such_column/);
    expect(
      (
        await db.sql(
          `select count(*)::int as n from information_schema.columns where table_name = 'items' and column_name = 'tmp'`,
        )
      ).rows[0].n,
    ).toBe(0);
  });

  it('refuses a read-only session with KLEOS_READ_ONLY and changes nothing', async () => {
    const readOnly = await createPostgresAdapter().connect({ ...db.config, readOnly: true }, db.password);
    try {
      const err = kleos(await rejectionOf(readOnly.applyDdl(jobs({ op: 'dropTable', table: items }))));
      expect(err.status).toBe(403);
      expect(err.body).toEqual({ code: kleosErrorCodes.readOnly, message: 'This connection is read-only' });
      expect((await db.sql('select count(*)::int as n from ws.items')).rows[0].n).toBe(3);
    } finally {
      await readOnly.close();
    }
  });

  it('renames and drops tables, columns and indexes', async () => {
    await db.sql(`
      create table ws.old_name (id int primary key, a text, b text);
      create index old_idx on ws.old_name (a);
      create view ws.old_view as select b from ws.old_name;`);
    const renamed = { schema: 'ws', name: 'new_name' };
    await session.applyDdl(
      jobs(
        { op: 'renameTable', table: { schema: 'ws', name: 'old_name' }, newName: 'new_name' },
        { op: 'renameColumn', table: renamed, column: 'a', newName: 'alpha' },
        { op: 'dropIndex', schema: 'ws', name: 'old_idx' },
        { op: 'dropColumn', table: renamed, column: 'b', cascade: true },
      ),
    );
    const { rows } = await db.sql(`
      select (select string_agg(column_name, ',' order by ordinal_position) from information_schema.columns
               where table_schema = 'ws' and table_name = 'new_name') as columns,
             to_regclass('ws.old_idx') is null as index_gone,
             to_regclass('ws.old_view') is null as view_gone`);
    expect(rows[0]).toEqual({ columns: 'id,alpha', index_gone: true, view_gone: true });

    // Without CASCADE, a dependent view makes DROP TABLE fail with Postgres's hint.
    await db.sql('create view ws.new_view as select id from ws.new_name');
    const err = kleos(await rejectionOf(session.applyDdl(jobs({ op: 'dropTable', table: renamed }))));
    expect(err.body).toMatchObject({ code: '2BP01', statementIndex: 0 });
    expect(err.body.hint).toMatch(/DROP \.\.\. CASCADE/);
    await session.applyDdl(jobs({ op: 'dropTable', table: renamed, cascade: true }));
    expect((await db.sql(`select to_regclass('ws.new_name') is null as gone`)).rows[0].gone).toBe(true);
  });

  it('gives up on a table lock after the lock timeout instead of hanging, and applies nothing', async () => {
    const holder = await db.admin();
    try {
      await holder.query('begin');
      await holder.query('lock table ws.items in access share mode');
      const err = kleos(
        await rejectionOf(
          session.applyDdl(
            jobs(
              { op: 'createTable', schema: 'ws', name: 'during_lock', columns: [{ name: 'id', type: 'int' }] },
              { op: 'addColumn', table: items, column: { name: 'waits', type: 'int' } },
            ),
          ),
        ),
      );
      expect(err.body).toMatchObject({ code: '55P03', statementIndex: 1 });
      expect(err.body.hint).toMatch(/Another session held a lock/);
      expect((await db.sql(`select to_regclass('ws.during_lock') is null as gone`)).rows[0].gone).toBe(true);
    } finally {
      await holder.query('rollback');
      await holder.end();
    }
  }, 30_000);
});
