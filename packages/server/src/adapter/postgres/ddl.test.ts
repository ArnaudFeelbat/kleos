import { describe, expect, it } from 'vitest';
import { DdlChange } from '@kleos/shared';
import { KleosError } from '../../errors';
import type { DdlJob } from '../types';
import { buildStatements, planDdl, validateDdl } from './ddl';
import { expressionProblem, parseColumnType } from './ddl-grammar';
import type { Queryable } from './types';

const t = { schema: 'shop', name: 'orders' };

/** Applies the zod defaults, as the route does. */
const job = (change: DdlChange): DdlJob => DdlChange.parse(change);

/** Types as Postgres would spell them, for the builder alone. */
const types = new Map([
  ['int', 'integer'],
  ['text', 'text'],
  ['varchar(80)', 'character varying(80)'],
  ['timestamptz', 'timestamp with time zone'],
  ['serial', 'serial'],
]);

const sql = (change: DdlChange) => buildStatements([job(change)], types)[0];

function refusal(run: () => unknown): KleosError {
  try {
    run();
  } catch (err) {
    expect(err).toBeInstanceOf(KleosError);
    return err as KleosError;
  }
  throw new Error('Expected a refusal');
}

describe('buildStatements: one statement per change', () => {
  it('creates a table with types, NOT NULL, defaults and a primary key', () => {
    expect(
      sql({
        op: 'createTable',
        schema: 'shop',
        name: 'invoices',
        columns: [
          { name: 'id', type: 'serial', nullable: false },
          { name: 'status', type: 'text', nullable: false, default: "'draft'" },
          { name: 'note', type: 'varchar(80)' },
          { name: 'created_at', type: 'timestamptz', nullable: false, default: ' now() ' },
        ],
        primaryKey: ['id'],
      }),
    ).toBe(
      `create table "shop"."invoices" ("id" serial not null, "status" text not null default 'draft', ` +
        `"note" character varying(80), "created_at" timestamp with time zone not null default now(), primary key ("id"))`,
    );
  });

  it('creates a table without a primary key', () => {
    expect(sql({ op: 'createTable', schema: 'public', name: 'log', columns: [{ name: 'line', type: 'text' }] })).toBe(
      'create table "public"."log" ("line" text)',
    );
  });

  it('renames and drops tables', () => {
    expect(sql({ op: 'renameTable', table: t, newName: 'purchases' })).toBe(
      'alter table "shop"."orders" rename to "purchases"',
    );
    expect(sql({ op: 'dropTable', table: t })).toBe('drop table "shop"."orders"');
    expect(sql({ op: 'dropTable', table: t, cascade: true })).toBe('drop table "shop"."orders" cascade');
  });

  it('adds, renames and drops columns', () => {
    expect(
      sql({ op: 'addColumn', table: t, column: { name: 'total', type: 'int', nullable: false, default: '0' } }),
    ).toBe('alter table "shop"."orders" add column "total" integer not null default 0');
    expect(sql({ op: 'addColumn', table: t, column: { name: 'memo', type: 'text', default: '  ' } })).toBe(
      'alter table "shop"."orders" add column "memo" text',
    );
    expect(sql({ op: 'renameColumn', table: t, column: 'total', newName: 'amount' })).toBe(
      'alter table "shop"."orders" rename column "total" to "amount"',
    );
    expect(sql({ op: 'dropColumn', table: t, column: 'memo' })).toBe('alter table "shop"."orders" drop column "memo"');
    expect(sql({ op: 'dropColumn', table: t, column: 'memo', cascade: true })).toBe(
      'alter table "shop"."orders" drop column "memo" cascade',
    );
  });

  it('changes a column type, with and without USING', () => {
    expect(sql({ op: 'alterColumnType', table: t, column: 'total', type: 'text' })).toBe(
      'alter table "shop"."orders" alter column "total" type text',
    );
    expect(sql({ op: 'alterColumnType', table: t, column: 'code', type: 'int', using: 'code::integer' })).toBe(
      'alter table "shop"."orders" alter column "code" type integer using code::integer',
    );
  });

  it('sets and drops NOT NULL and defaults', () => {
    expect(sql({ op: 'setNotNull', table: t, column: 'total', notNull: true })).toBe(
      'alter table "shop"."orders" alter column "total" set not null',
    );
    expect(sql({ op: 'setNotNull', table: t, column: 'total', notNull: false })).toBe(
      'alter table "shop"."orders" alter column "total" drop not null',
    );
    expect(sql({ op: 'setDefault', table: t, column: 'status', default: "'new'" })).toBe(
      `alter table "shop"."orders" alter column "status" set default 'new'`,
    );
    expect(sql({ op: 'setDefault', table: t, column: 'status', default: null })).toBe(
      'alter table "shop"."orders" alter column "status" drop default',
    );
    expect(sql({ op: 'setDefault', table: t, column: 'status', default: '' })).toBe(
      'alter table "shop"."orders" alter column "status" drop default',
    );
  });

  it('creates and drops indexes', () => {
    expect(sql({ op: 'createIndex', table: t, columns: ['customer_id'] })).toBe(
      'create index on "shop"."orders" using btree ("customer_id")',
    );
    expect(
      sql({ op: 'createIndex', table: t, name: 'orders_cust_day', columns: ['customer_id', 'day'], unique: true }),
    ).toBe('create unique index "orders_cust_day" on "shop"."orders" using btree ("customer_id", "day")');
    expect(sql({ op: 'createIndex', table: t, columns: ['tags'], method: 'gin' })).toBe(
      'create index on "shop"."orders" using gin ("tags")',
    );
    expect(sql({ op: 'dropIndex', schema: 'shop', name: 'orders_cust_day' })).toBe(
      'drop index "shop"."orders_cust_day"',
    );
    expect(sql({ op: 'dropIndex', schema: 'shop', name: 'orders_cust_day', cascade: true })).toBe(
      'drop index "shop"."orders_cust_day" cascade',
    );
  });

  it('quotes awkward identifiers everywhere', () => {
    const odd = { schema: 'My Schema', name: 'Order "Lines"' };
    expect(sql({ op: 'renameTable', table: odd, newName: 'a;b' })).toBe(
      'alter table "My Schema"."Order ""Lines""" rename to "a;b"',
    );
    expect(sql({ op: 'renameColumn', table: odd, column: 'Total Due', newName: 'x") ; drop table y; --' })).toBe(
      'alter table "My Schema"."Order ""Lines""" rename column "Total Due" to "x"") ; drop table y; --"',
    );
    expect(sql({ op: 'createIndex', table: odd, name: 'Idx', columns: ['Total Due'] })).toBe(
      'create index "Idx" on "My Schema"."Order ""Lines""" using btree ("Total Due")',
    );
    expect(
      sql({
        op: 'createTable',
        schema: 'S',
        name: 'T',
        columns: [{ name: 'Weird "Col"', type: 'int' }],
        primaryKey: ['Weird "Col"'],
      }),
    ).toBe('create table "S"."T" ("Weird ""Col""" integer, primary key ("Weird ""Col"""))');
  });

  it('writes the resolved type, never the typed text', () => {
    expect(() =>
      buildStatements([job({ op: 'addColumn', table: t, column: { name: 'a', type: 'unknown' } })], types),
    ).toThrow('Type "unknown" was not resolved');
  });
});

describe('parseColumnType: a strict grammar', () => {
  const probe = (text: string) => {
    const parsed = parseColumnType(text);
    return parsed?.kind === 'type' ? parsed.probe : parsed;
  };

  it.each([
    ['text', 'text'],
    ['  int4  ', 'int4'],
    ['varchar(80)', 'varchar(80)'],
    ['numeric( 12 , 2 )', 'numeric(12,2)'],
    ['int[]', 'int[]'],
    ['text[][]', 'text[][]'],
    ['int[3]', 'int[3]'],
    ['shop.order_status', 'shop.order_status'],
    ['"My Schema"."My Type"', '"My Schema"."My Type"'],
    ['"we""ird"', '"we""ird"'],
    ['double precision', 'double precision'],
    ['DOUBLE PRECISION[]', 'double precision[]'],
    ['character varying(80)', 'character varying(80)'],
    ['char varying', 'char varying'],
    ['bit varying(5)', 'bit varying(5)'],
    ['timestamp with time zone', 'timestamp with time zone'],
    ['timestamp(3) without time zone', 'timestamp(3) without time zone'],
    ['time(6) with time zone', 'time(6) with time zone'],
    ['timestamp', 'timestamp'],
    ['interval', 'interval'],
    ['interval(3)', 'interval(3)'],
    ['interval day to second(3)', 'interval day to second(3)'],
    ['interval year to month', 'interval year to month'],
    ['interval hour', 'interval hour'],
    ['pg_catalog.timestamp', 'pg_catalog.timestamp'],
    ['café', 'café'],
  ])('accepts %j', (text, expected) => {
    expect(probe(text)).toBe(expected);
  });

  it('recognises serial types, alone and unqualified', () => {
    expect(parseColumnType('BIGSERIAL')).toEqual({ kind: 'serial', name: 'bigserial' });
    expect(parseColumnType('serial4')).toEqual({ kind: 'serial', name: 'serial4' });
    expect(probe('serial[]')).toBe('serial[]');
  });

  it.each([
    'int; drop table x',
    'text) ; --',
    'text -- comment',
    'text /* c */',
    "text default 'x'",
    'int where true',
    'int, pg_sleep(10)',
    'int union select 1',
    'varchar(80',
    'varchar(a)',
    'varchar(-1)',
    'numeric(1,2,3)',
    'varchar(1)(2)',
    'a.b.c',
    'shop.',
    '.text',
    'int[',
    'int[x]',
    'int[] []x',
    '"unterminated',
    '""',
    "'text'",
    'timestamp with zone',
    'interval month to year',
    'interval day(3)',
    '$1',
    '',
  ])('rejects %j', (text) => {
    expect(parseColumnType(text)).toBeNull();
  });
});

describe('expressionProblem', () => {
  it.each([
    "'draft'",
    'now()',
    '0',
    "nextval('shop.orders_id_seq'::regclass)",
    "'a;b, c -- d'",
    "E'it\\'s; fine'",
    '$$x;y$$',
    '$tag$a;b$tag$',
    '"weird;col" + 1',
    'array[1, 2]',
    'coalesce(a, b)',
    'x /* a; comment, with -- */ + 1',
    "(case when a then 'x' else 'y' end)",
    "jsonb_build_object('a', 1)",
  ])('accepts %j', (expr) => {
    expect(expressionProblem(expr)).toBeNull();
  });

  it.each([
    ['now(); drop table x', 'a ";" (one change is one statement)'],
    ['0;', 'a ";" (one change is one statement)'],
    ['0 -- zero', 'a "--" comment (use /* */ instead)'],
    ['1, "evil" int', 'a "," outside parentheses'],
    ["'open", 'an unterminated string'],
    ['"open', 'an unterminated quoted identifier'],
    ['$$open', 'an unterminated dollar-quoted string'],
    ['/* open', 'an unterminated comment'],
    ['0)', 'an unmatched ")"'],
    ['(0', 'an unclosed "("'],
    ['array[1)', 'an unmatched ")"'],
  ])('rejects %j', (expr, problem) => {
    expect(expressionProblem(expr)).toBe(problem);
  });
});

describe('validateDdl: the whole request before any SQL', () => {
  const validate = (...changes: DdlChange[]) => validateDdl(changes.map(job));

  it('names the change in the message and in statementIndex', () => {
    const err = refusal(() =>
      validate(
        { op: 'renameTable', table: t, newName: 'ok' },
        { op: 'setDefault', table: t, column: 'status', default: "'x'; drop table shop.orders" },
      ),
    );
    expect(err.status).toBe(400);
    expect(err.body).toEqual({
      code: 'KLEOS_VALIDATION',
      message:
        'Change 2: the default must be a single SQL expression, but it contains a ";" (one change is one statement)',
      statementIndex: 1,
    });
  });

  it('refuses ";" in a column default and in USING', () => {
    expect(
      refusal(() => validate({ op: 'addColumn', table: t, column: { name: 'a', type: 'int', default: '1; select 2' } }))
        .body.message,
    ).toBe(
      'Change 1: the default of "a" must be a single SQL expression, but it contains a ";" (one change is one statement)',
    );
    expect(
      refusal(() => validate({ op: 'alterColumnType', table: t, column: 'a', type: 'int', using: 'a::int;' })).body
        .message,
    ).toMatch(/^Change 1: the USING expression must be a single SQL expression/);
  });

  it('refuses a type outside the grammar, naming it', () => {
    const err = refusal(() =>
      validate({ op: 'addColumn', table: t, column: { name: 'a', type: 'int; drop table x' } }),
    );
    expect(err.body).toMatchObject({
      code: 'KLEOS_VALIDATION',
      message: 'Change 1: "int; drop table x" is not a type name',
      statementIndex: 0,
    });
    expect(err.body.detail).toMatch(/name or schema\.name/);
  });

  it('accepts serial when creating a column but not when changing a type', () => {
    expect(validate({ op: 'addColumn', table: t, column: { name: 'id', type: 'serial' } })).toHaveLength(1);
    expect(
      refusal(() => validate({ op: 'alterColumnType', table: t, column: 'id', type: 'bigserial' })).body.message,
    ).toBe('Change 1: bigserial only exists when a column is created');
  });

  it('checks a CREATE TABLE: duplicate columns, primary key columns', () => {
    const create = (columns: string[], primaryKey: string[]) =>
      refusal(() =>
        validate({
          op: 'createTable',
          schema: 's',
          name: 't',
          columns: columns.map((name) => ({ name, type: 'int' })),
          primaryKey,
        }),
      ).body.message;
    expect(create(['a', 'a'], [])).toBe('Change 1: the column "a" appears twice');
    expect(create(['a', 'b'], ['c'])).toBe('Change 1: the primary key names "c", which is not a column');
    expect(create(['a', 'b'], ['a', 'a'])).toBe('Change 1: the primary key names "a" twice');
    // Quoted identifiers are case-sensitive: "A" and "a" are two columns.
    expect(
      validate({
        op: 'createTable',
        schema: 's',
        name: 't',
        columns: [
          { name: 'A', type: 'int' },
          { name: 'a', type: 'int' },
        ],
      }),
    ).toHaveLength(2);
  });

  it('checks a CREATE INDEX against its method', () => {
    expect(
      refusal(() => validate({ op: 'createIndex', table: t, columns: ['a'], unique: true, method: 'gin' })).body
        .message,
    ).toBe('Change 1: a gin index cannot be unique; only btree indexes can');
    expect(
      refusal(() => validate({ op: 'createIndex', table: t, columns: ['a', 'b'], method: 'hash' })).body.message,
    ).toBe('Change 1: a hash index covers a single column');
  });

  it('refuses empty names, NUL characters and names Postgres would truncate', () => {
    expect(refusal(() => validate({ op: 'dropTable', table: { schema: '', name: 'x' } })).body.message).toBe(
      'Change 1: the schema name is empty',
    );
    expect(refusal(() => validate({ op: 'renameColumn', table: t, column: 'a\0b', newName: 'c' })).body.message).toBe(
      'Change 1: the column name contains a NUL character',
    );
    // 32 two-byte characters: 32 characters, 64 bytes.
    const long = 'é'.repeat(32);
    expect(refusal(() => validate({ op: 'renameTable', table: t, newName: long })).body.message).toBe(
      `Change 1: the new table name "${long}" is longer than 63 bytes`,
    );
  });
});

describe('planDdl', () => {
  it('validates everything before asking Postgres anything', async () => {
    const asked: string[] = [];
    const q: Queryable = {
      query: async (config) => {
        asked.push(config.text);
        return { rows: [], fields: [], rowCount: 0, command: 'SELECT', oid: 0 };
      },
    };
    const err = await planDdl(q, [
      job({ op: 'addColumn', table: t, column: { name: 'a', type: 'int' } }),
      job({ op: 'addColumn', table: t, column: { name: 'b', type: 'text) ; --' } }),
    ]).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(KleosError);
    expect((err as KleosError).body.statementIndex).toBe(1);
    expect(asked).toEqual([]);
  });

  it('asks nothing when no change has a type', async () => {
    const q: Queryable = {
      query: async () => {
        throw new Error('no query expected');
      },
    };
    expect(
      await planDdl(q, [
        job({ op: 'dropTable', table: t }),
        job({ op: 'addColumn', table: t, column: { name: 'id', type: 'serial' } }),
      ]),
    ).toEqual(['drop table "shop"."orders"', 'alter table "shop"."orders" add column "id" serial']);
  });
});
