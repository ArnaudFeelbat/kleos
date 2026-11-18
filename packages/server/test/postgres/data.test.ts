import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type Filter, type RowsRequest, type SchemaModel, kleosErrorCodes } from '@kleos/shared';
import { createPostgresAdapter } from '../../src/adapter/postgres';
import type { Session } from '../../src/adapter/types';
import { KleosError } from '../../src/errors';
import { type TestDatabase, rejectionOf, startPostgres } from '../helpers/postgres';

let db: TestDatabase;
let session: Session;

beforeAll(async () => {
  db = await startPostgres({ seeds: ['types.sql', 'shop.sql'] });
  session = await createPostgresAdapter().connect(db.config, db.password);
});

afterAll(async () => {
  await session?.close();
  await db?.stop();
});

const paging = { schema: 'shop', name: 'paging' };

function rows(table: { schema: string; name: string }, extra: Partial<RowsRequest> = {}) {
  return session.fetchRows({ table, limit: 200, offset: 0, sort: [], filters: [], ...extra });
}

function kleos(err: unknown): KleosError {
  expect(err).toBeInstanceOf(KleosError);
  return err as KleosError;
}

describe('introspect', () => {
  let model: SchemaModel;

  beforeAll(async () => {
    model = await session.introspect();
  });

  const table = (schema: string, name: string) => model.tables.find((t) => t.schema === schema && t.name === name);

  it('lists user schemas and hides the system ones', () => {
    expect(model.schemas).toEqual(expect.arrayContaining(['public', 'shop', 'types']));
    for (const hidden of model.schemas)
      expect(hidden).not.toMatch(/^(pg_catalog|information_schema|pg_toast|pg_temp_)/);
    expect(model.tables.some((t) => t.schema === 'pg_catalog' || t.schema === 'information_schema')).toBe(false);
  });

  it('reads columns with format_type, typname, category, nullability, defaults and identity', () => {
    const orders = table('shop', 'orders')!;
    expect(orders.kind).toBe('table');
    expect(orders.primaryKey).toEqual(['id']);
    const byName = Object.fromEntries(orders.columns.map((c) => [c.name, c]));
    expect(byName.id).toMatchObject({ type: 'integer', typeName: 'int4', typeCategory: 'N', nullable: false });
    expect(byName.id!.default).toMatch(/^nextval\('shop\.orders_id_seq'::regclass\)$/);
    expect(byName.total).toMatchObject({ type: 'numeric(12,2)', typeName: 'numeric', default: '0' });
    expect(byName.status).toMatchObject({
      type: 'shop.order_status',
      typeCategory: 'E',
      enumValues: ['pending', 'paid', 'shipped', 'cancelled'],
    });
    expect(byName.note!.nullable).toBe(true);

    const customers = table('shop', 'customers')!;
    const id = customers.columns.find((c) => c.name === 'id')!;
    expect(id).toMatchObject({ identity: 'always', default: null, typeName: 'int8' });
    expect(customers.comment).toBe('People who buy things');
    expect(customers.rowEstimate).toBe(3);
    expect(customers.totalBytes).toBeGreaterThan(0);

    const arrays = table('types', 'arrays')!;
    expect(arrays.columns.find((c) => c.name === 'ints')).toMatchObject({
      type: 'integer[]',
      typeName: '_int4',
      typeCategory: 'A',
    });
  });

  it('reads composite primary keys in key order, indexes and constraints', () => {
    const items = table('shop', 'order_items')!;
    expect(items.primaryKey).toEqual(['order_id', 'line']);
    const pk = items.indexes.find((i) => i.primary)!;
    expect(pk).toMatchObject({ columns: ['order_id', 'line'], unique: true, method: 'btree' });
    expect(pk.definition).toMatch(/^CREATE UNIQUE INDEX order_items_pkey ON shop\.order_items USING btree/);
    expect(items.constraints.map((c) => c.type).sort()).toEqual(['c', 'f', 'p']);
    expect(items.constraints.find((c) => c.type === 'c')!.definition).toBe('CHECK ((qty > 0))');

    const orders = table('shop', 'orders')!;
    expect(orders.indexes.find((i) => i.name === 'orders_customer_idx')).toMatchObject({
      columns: ['customer_id'],
      unique: false,
      primary: false,
    });
  });

  it('reads foreign keys with column arrays', () => {
    expect(model.foreignKeys).toEqual(
      expect.arrayContaining([
        {
          name: 'orders_customer_id_fkey',
          schema: 'shop',
          table: 'orders',
          columns: ['customer_id'],
          refSchema: 'shop',
          refTable: 'customers',
          refColumns: ['id'],
        },
        expect.objectContaining({
          table: 'order_items',
          columns: ['order_id'],
          refTable: 'orders',
          refColumns: ['id'],
        }),
      ]),
    );
  });

  it('lists views with their columns, apart from tables, and enums in sort order', () => {
    const view = model.views.find((v) => v.name === 'order_totals')!;
    expect(view).toMatchObject({ schema: 'shop', kind: 'view', primaryKey: [] });
    expect(view.columns.map((c) => c.name)).toEqual(['customer_id', 'orders', 'total']);
    expect(model.tables.some((t) => t.name === 'order_totals')).toBe(false);
    expect(model.enums).toEqual(
      expect.arrayContaining([
        { schema: 'types', name: 'mood', values: ['sad', 'ok', 'happy'] },
        { schema: 'shop', name: 'order_status', values: ['pending', 'paid', 'shipped', 'cancelled'] },
      ]),
    );
    expect(table('shop', 'audit_log')!.primaryKey).toEqual([]);
  });
});

describe('fetchRows: every value as text', () => {
  it('keeps bigint and numeric digits exactly', async () => {
    const ints = await rows({ schema: 'types', name: 'ints' });
    expect(ints.rows).toEqual([
      ['1', '32767', '2147483647', '9007199254740993'],
      ['2', '-32768', '-2147483648', '-9223372036854775808'],
      ['3', null, null, null],
    ]);
    expect(ints.columns.map((c) => c.type)).toEqual(['integer', 'smallint', 'integer', 'bigint']);

    const numerics = await rows({ schema: 'types', name: 'numerics' });
    expect(numerics.rows[0]).toEqual(['1', '12345678901234567890.123456789', '1234567890.12', '3.14159', '0.1']);
    expect(numerics.rows[1]).toEqual(['2', 'NaN', null, 'Infinity', '-Infinity']);
    expect(numerics.columns[2]).toMatchObject({ type: 'numeric(12,2)', typeName: 'numeric', typeCategory: 'N' });
  });

  it('keeps NULL and the empty string distinct', async () => {
    const texts = await rows({ schema: 'types', name: 'texts' });
    expect(texts.rows[1]).toEqual(['2', '', '']);
    expect(texts.rows[2]).toEqual(['3', null, null]);
    expect(texts.rows[3]).toEqual(['4', 'line one\nline two', 'ünïcödé ✓']);
    expect(texts.columns[2]!.type).toBe('character varying(20)');
  });

  it('returns the server text form for bool, dates, timestamps, json, arrays, uuid, enum and bytea', async () => {
    expect((await rows({ schema: 'types', name: 'bools' })).rows).toEqual([
      ['1', 't'],
      ['2', 'f'],
      ['3', null],
    ]);
    expect((await rows({ schema: 'types', name: 'dates' })).rows).toEqual([
      ['1', '2024-02-29'],
      ['2', 'infinity'],
      ['3', null],
    ]);
    expect((await rows({ schema: 'types', name: 'timestamps' })).rows[0]).toEqual(['1', '2024-02-29 13:45:01.123456']);
    const tstz = (await rows({ schema: 'types', name: 'timestamptzs' })).rows[0]![1]!;
    expect(tstz).toMatch(/^2024-06-01 \d{2}:\d{2}:00[+-]\d{2}(:\d{2})?$/);
    expect(new Date(tstz.replace(' ', 'T').replace(/([+-]\d{2})$/, '$1:00')).toISOString()).toBe(
      '2024-06-01T12:00:00.000Z',
    );

    const jsons = await rows({ schema: 'types', name: 'jsons' });
    expect(jsons.rows[0]).toEqual(['1', '{"b": 1,  "a": [1, 2]}', '{"a": [1, 2], "b": 1}']);
    expect(jsons.rows[1]).toEqual(['2', '{"n": 12345678901234567890}', '{"n": 12345678901234567890}']);
    expect(jsons.rows[2]).toEqual(['3', null, 'null']);

    const arrays = await rows({ schema: 'types', name: 'arrays' });
    expect(arrays.rows[0]).toEqual(['1', '{1,2,3}', '{a,"b c",NULL}', '{{1,2},{3,4}}']);
    expect(arrays.rows[1]).toEqual(['2', '{}', null, null]);

    expect((await rows({ schema: 'types', name: 'uuids' })).rows[0]).toEqual([
      '1',
      'a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11',
    ]);
    const enums = await rows({ schema: 'types', name: 'enums' });
    expect(enums.rows).toEqual([
      ['1', 'happy'],
      ['2', 'sad'],
      ['3', null],
    ]);
    expect(enums.columns[1]).toMatchObject({ type: 'types.mood', typeName: 'mood', typeCategory: 'E' });
    expect((await rows({ schema: 'types', name: 'byteas' })).rows).toEqual([
      ['1', '\\xdeadbeef'],
      ['2', '\\x'],
      ['3', null],
    ]);
  });
});

describe('fetchRows: paging, sorting, filters', () => {
  const ids = (page: { rows: (string | null)[][] }) => page.rows.map((r) => Number(r[0]));

  it('orders by the primary key when no sort is given, so paging is stable', async () => {
    const seen: number[] = [];
    for (let offset = 0; offset < 1000; offset += 100) {
      const page = await rows(paging, { limit: 100, offset });
      expect(page.hasMore).toBe(offset + 100 < 1000);
      seen.push(...ids(page));
    }
    expect(seen).toEqual(Array.from({ length: 1000 }, (_, i) => i + 1));
  });

  it('sets hasMore with the limit+1 trick', async () => {
    expect((await rows(paging, { limit: 999 })).hasMore).toBe(true);
    const all = await rows(paging, { limit: 1000 });
    expect(all.hasMore).toBe(false);
    expect(all.rows).toHaveLength(1000);
    const last = await rows(paging, { limit: 5, offset: 998 });
    expect(ids(last)).toEqual([999, 1000]);
    expect(last.hasMore).toBe(false);
  });

  it('sorts on the server, with the primary key as tie-breaker', async () => {
    const page = await rows(paging, { sort: [{ column: 'grp', dir: 'desc' }], limit: 3 });
    expect(page.rows.map((r) => [r[0], r[1]])).toEqual([
      ['6', '6'],
      ['13', '6'],
      ['20', '6'],
    ]);
    const byLabel = await rows(paging, { sort: [{ column: 'label', dir: 'asc' }], limit: 2 });
    expect(byLabel.rows.map((r) => r[2])).toEqual(['row 1', 'row 10']);
  });

  it('applies each filter operator with the value cast to the column type', async () => {
    const run = async (...filters: Filter[]) => ids(await rows(paging, { filters, limit: 2000 }));
    expect(await run({ column: 'id', op: 'eq', value: '42' })).toEqual([42]);
    expect(await run({ column: 'id', op: 'gt', value: '995' })).toEqual([996, 997, 998, 999, 1000]);
    expect(await run({ column: 'id', op: 'gte', value: '998' })).toEqual([998, 999, 1000]);
    expect(await run({ column: 'id', op: 'lt', value: '3' })).toEqual([1, 2]);
    expect(await run({ column: 'id', op: 'lte', value: '3' })).toEqual([1, 2, 3]);
    expect(await run({ column: 'id', op: 'neq', value: '1' }, { column: 'id', op: 'lte', value: '3' })).toEqual([2, 3]);
    expect(await run({ column: 'grp', op: 'eq', value: '3' })).toHaveLength(143);
    expect(await run({ column: 'label', op: 'contains', value: 'OW 99' })).toEqual([
      99, 990, 991, 992, 993, 994, 995, 996, 997, 998, 999,
    ]);

    const texts = { schema: 'types', name: 'texts' };
    const textIds = async (...filters: Filter[]) => ids(await rows(texts, { filters }));
    expect(await textIds({ column: 't', op: 'isNull' })).toEqual([3]);
    expect(await textIds({ column: 't', op: 'isNotNull' })).toEqual([1, 2, 4, 5, 6]);
    // LIKE wildcards in the value are matched literally.
    expect(await textIds({ column: 't', op: 'contains', value: '%' })).toEqual([5]);
    expect(await textIds({ column: 'v', op: 'contains', value: '_' })).toEqual([5]);
    // contains casts the column to text, so it works on any type.
    expect(
      ids(
        await rows({ schema: 'types', name: 'uuids' }, { filters: [{ column: 'u', op: 'contains', value: 'BB6D' }] }),
      ),
    ).toEqual([1]);
    // A value that does not cast is Postgres's error, not ours.
    expect((await rejectionOf(run({ column: 'id', op: 'eq', value: 'abc' }))).code).toBe('22P02');
  });

  it('refuses a filter on an unknown column, or without a value', async () => {
    expect(kleos(await rejectionOf(rows(paging, { filters: [{ column: 'nope', op: 'isNull' }] }))).body.code).toBe(
      kleosErrorCodes.validation,
    );
    expect(kleos(await rejectionOf(rows(paging, { filters: [{ column: 'id', op: 'eq' }] }))).body.code).toBe(
      kleosErrorCodes.validation,
    );
  });

  it('ANDs the raw WHERE text with the filters', async () => {
    const page = await rows(paging, { where: 'id <= 20', filters: [{ column: 'grp', op: 'eq', value: '3' }] });
    expect(ids(page)).toEqual([3, 10, 17]);
    // A trailing comment cannot swallow the closing parenthesis, LIMIT or OFFSET.
    expect(ids(await rows(paging, { where: 'id < 4 -- comment', limit: 2 }))).toEqual([1, 2]);
    // A trailing semicolon is tolerated.
    expect(ids(await rows(paging, { where: 'id = 5;' }))).toEqual([5]);
  });

  it('runs the raw WHERE as one statement only', async () => {
    const err = await rejectionOf(rows(paging, { where: 'true); delete from shop.paging where (true' }));
    expect(err.code).toBe('42601');
    expect((await session.count({ table: paging, filters: [] })).count).toBe('1000');
  });

  it('gives views no implicit order and pages them with hasMore', async () => {
    const page = await rows({ schema: 'shop', name: 'order_totals' }, { limit: 2 });
    expect(page.rows).toHaveLength(2);
    expect(page.hasMore).toBe(true);
  });

  it('answers 404 for a table that does not exist', async () => {
    expect(kleos(await rejectionOf(rows({ schema: 'shop', name: 'missing' }))).status).toBe(404);
  });
});

describe('counts', () => {
  it('estimates from reltuples when unfiltered and counts exactly on request', async () => {
    expect(await session.estimateCount({ table: paging, filters: [] })).toEqual({ count: '1000', exact: false });
    expect(await session.count({ table: paging, filters: [] })).toEqual({ count: '1000', exact: true });
  });

  it('uses the planner estimate when filtered', async () => {
    const filters: Filter[] = [{ column: 'grp', op: 'eq', value: '3' }];
    const estimate = await session.estimateCount({ table: paging, filters });
    expect(estimate.exact).toBe(false);
    expect(Number(estimate.count)).toBeGreaterThan(50);
    expect(Number(estimate.count)).toBeLessThan(300);
    expect(await session.count({ table: paging, filters })).toEqual({ count: '143', exact: true });
    expect(await session.count({ table: paging, filters: [], where: 'id > 990' })).toEqual({
      count: '10',
      exact: true,
    });
  });

  it('estimates a view through the planner', async () => {
    const estimate = await session.estimateCount({ table: { schema: 'shop', name: 'order_totals' }, filters: [] });
    expect(Number(estimate.count)).toBeGreaterThan(0);
  });
});

describe('applyEdits', () => {
  const customers = { schema: 'shop', name: 'customers' };
  const orders = { schema: 'shop', name: 'orders' };
  const items = { schema: 'shop', name: 'order_items' };

  const customerName = async (id: number) =>
    (await db.sql('select name from shop.customers where id = $1', [id])).rows[0].name;

  it('applies updates, inserts and deletes in one transaction and returns the rows as text', async () => {
    const result = await session.applyEdits([
      { kind: 'update', table: customers, key: { id: '2' }, set: { name: 'Grace H.', email: 'grace@navy.mil' } },
      { kind: 'insert', table: orders, values: { customer_id: '2', note: null } },
      { kind: 'delete', table: items, key: { order_id: '3', line: '1' } },
    ]);
    expect(result.applied).toBe(3);
    expect(result.columns.map((c) => c.name)).toEqual(['id', 'email', 'name', 'created_at']);
    expect(result.rows[0]!.slice(0, 3)).toEqual(['2', 'grace@navy.mil', 'Grace H.']);
    // Omitted columns took their DEFAULT; the numeric comes back with its scale.
    expect(result.rows[1]).toEqual([expect.stringMatching(/^\d+$/), '2', 'pending', '0.00', null]);
    expect(result.rows[2]).toBeNull();
    expect(await customerName(2)).toBe('Grace H.');
    expect((await db.sql('select count(*)::int as n from shop.order_items where order_id = 3')).rows[0].n).toBe(0);
  });

  it('follows a primary-key change within one update', async () => {
    const result = await session.applyEdits([
      { kind: 'update', table: items, key: { order_id: '2', line: '1' }, set: { line: '9', product: 'Big monitor' } },
    ]);
    expect(result.rows[0]).toEqual(['2', '9', 'Big monitor', '1']);
  });

  it('rolls the whole batch back on a bad cast and names the edit and the column', async () => {
    const err = kleos(
      await rejectionOf(
        session.applyEdits([
          { kind: 'update', table: customers, key: { id: '1' }, set: { name: 'Should not stick' } },
          { kind: 'update', table: orders, key: { id: '1' }, set: { note: 'fine', total: 'abc' } },
        ]),
      ),
    );
    expect(err.status).toBe(400);
    expect(err.body).toMatchObject({ code: '22P02', editIndex: 1, column: 'total' });
    expect(err.body.message).toMatch(/invalid input syntax for type numeric/);
    expect(await customerName(1)).toBe('Ada');
    expect((await db.sql('select note from shop.orders where id = 1')).rows[0].note).toBe('first');
  });

  it('names the column of a bad value in an insert', async () => {
    const err = kleos(
      await rejectionOf(
        session.applyEdits([
          { kind: 'insert', table: orders, values: { customer_id: '1', status: 'paid', total: '12,5' } },
        ]),
      ),
    );
    expect(err.body).toMatchObject({ code: '22P02', editIndex: 0, column: 'total' });
  });

  it('names the column of a NOT NULL violation', async () => {
    const err = kleos(
      await rejectionOf(
        session.applyEdits([{ kind: 'update', table: customers, key: { id: '1' }, set: { email: null } }]),
      ),
    );
    expect(err.body).toMatchObject({ code: '23502', editIndex: 0, column: 'email' });
  });

  it('refuses a key that matches no row with KLEOS_ROW_COUNT_MISMATCH and rolls back', async () => {
    const err = kleos(
      await rejectionOf(
        session.applyEdits([
          { kind: 'update', table: customers, key: { id: '1' }, set: { name: 'Should not stick' } },
          { kind: 'delete', table: orders, key: { id: '999999' } },
        ]),
      ),
    );
    expect(err.status).toBe(409);
    expect(err.body).toMatchObject({ code: kleosErrorCodes.rowCountMismatch, editIndex: 1 });
    expect(await customerName(1)).toBe('Ada');
  });

  it('refuses updates and deletes on a table without a primary key with KLEOS_NO_PRIMARY_KEY', async () => {
    const auditLog = { schema: 'shop', name: 'audit_log' };
    for (const edit of [
      { kind: 'delete', table: auditLog, key: { message: 'seeded' } },
      { kind: 'update', table: auditLog, key: { message: 'seeded' }, set: { message: 'changed' } },
    ] as const) {
      const err = kleos(await rejectionOf(session.applyEdits([edit])));
      expect(err.status).toBe(400);
      expect(err.body).toMatchObject({ code: kleosErrorCodes.noPrimaryKey, editIndex: 0 });
    }
    expect((await db.sql('select count(*)::int as n from shop.audit_log')).rows[0].n).toBe(2);
    expect((await db.sql(`select count(*)::int as n from shop.audit_log where message = 'seeded'`)).rows[0].n).toBe(1);
  });

  it('inserts into a table without a primary key and returns the inserted row', async () => {
    const auditLog = { schema: 'shop', name: 'audit_log' };
    const result = await session.applyEdits([
      { kind: 'insert', table: auditLog, values: { message: 'from the grid' } },
      { kind: 'insert', table: auditLog, values: {} },
    ]);
    expect(result.applied).toBe(2);
    expect(result.columns.map((c) => c.name)).toEqual(['at', 'message']);
    expect(result.rows[0]).toEqual([expect.any(String), 'from the grid']);
    // DEFAULT VALUES: the timestamp took its default, the message is null.
    expect(result.rows[1]).toEqual([expect.any(String), null]);
    expect((await db.sql('select count(*)::int as n from shop.audit_log')).rows[0].n).toBe(4);
  });

  it('inserts into a partitioned table without a primary key, but refuses deleting from it', async () => {
    await db.sql(`create table shop.events (day date not null, what text) partition by range (day);
                  create table shop.events_2026 partition of shop.events for values from ('2026-01-01') to ('2027-01-01')`);
    const events = { schema: 'shop', name: 'events' };
    const result = await session.applyEdits([
      { kind: 'insert', table: events, values: { day: '2026-11-18', what: 'launch' } },
    ]);
    expect(result.rows[0]).toEqual(['2026-11-18', 'launch']);
    expect((await db.sql('select count(*)::int as n from shop.events_2026')).rows[0].n).toBe(1);
    const err = kleos(
      await rejectionOf(session.applyEdits([{ kind: 'delete', table: events, key: { day: '2026-11-18' } }])),
    );
    expect(err.body.code).toBe(kleosErrorCodes.noPrimaryKey);
    expect((await db.sql('select count(*)::int as n from shop.events')).rows[0].n).toBe(1);
  });

  it('refuses every edit of a view or materialized view, inserts included', async () => {
    await db.sql('create materialized view shop.customer_names as select id, name from shop.customers');
    for (const table of [
      { schema: 'shop', name: 'order_totals' },
      { schema: 'shop', name: 'customer_names' },
    ]) {
      for (const edit of [
        { kind: 'insert', table, values: {} },
        { kind: 'delete', table, key: { id: '1' } },
      ] as const) {
        const err = kleos(await rejectionOf(session.applyEdits([edit])));
        expect(err.status).toBe(400);
        expect(err.body).toMatchObject({
          code: kleosErrorCodes.noPrimaryKey,
          message: expect.stringMatching(/not a table/),
        });
      }
    }
  });

  it('refuses a key that does not name the primary-key columns', async () => {
    const err = kleos(
      await rejectionOf(session.applyEdits([{ kind: 'delete', table: items, key: { order_id: '1' } }])),
    );
    expect(err.body).toMatchObject({ code: kleosErrorCodes.validation, editIndex: 0 });
  });
});
