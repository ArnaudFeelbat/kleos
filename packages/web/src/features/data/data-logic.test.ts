import { describe, expect, it } from 'vitest';
import type { ForeignKey } from '@kleos/shared';
import type { TypeInfo } from '@/features/cells/classify';
import { chipsToFilters, chipToFilter, foreignKeyTarget, type FilterChip } from './filters';
import { renderPendingSql, tokenizeSql } from './pending-sql';
import {
  buildEdits,
  emptyStage,
  rowKeyOf,
  stageReducer,
  stageSize,
  type StageAction,
  type StageState,
} from './staging';
import { groupDigits, nextSort, pageCount } from './table-state';

const table = { schema: 'public', name: 'orders' };
const types: Record<string, TypeInfo> = {
  id: { type: 'bigint', typeName: 'int8', typeCategory: 'N' },
  customer_id: { type: 'uuid', typeName: 'uuid', typeCategory: 'U' },
  status: { type: 'order_status', typeName: 'order_status', typeCategory: 'E' },
  total: { type: 'numeric(12,2)', typeName: 'numeric', typeCategory: 'N' },
  note: { type: 'text', typeName: 'text', typeCategory: 'S' },
  metadata: { type: 'jsonb', typeName: 'jsonb', typeCategory: 'U' },
};

const reduce = (actions: StageAction[], from: StageState = emptyStage) => actions.reduce(stageReducer, from);
const k = (id: string) => ({ rowKey: rowKeyOf(['id'], { id }), key: { id } });

describe('stageReducer', () => {
  it('stages a changed cell and remembers the original value', () => {
    const s = reduce([{ type: 'setCell', ...k('100510'), column: 'total', value: '1194.00', original: '1249.00' }]);
    expect(s.updates).toEqual([
      { rowKey: '["100510"]', key: { id: '100510' }, set: { total: '1194.00' }, was: { total: '1249.00' } },
    ]);
  });

  it('keeps the first original when a cell is edited twice', () => {
    const s = reduce([
      { type: 'setCell', ...k('1'), column: 'total', value: '2', original: '1' },
      { type: 'setCell', ...k('1'), column: 'total', value: '3', original: '2' },
    ]);
    expect(s.updates[0]!.set).toEqual({ total: '3' });
    expect(s.updates[0]!.was).toEqual({ total: '1' });
  });

  it('treats typing the original value back as a revert', () => {
    const s = reduce([
      { type: 'setCell', ...k('1'), column: 'total', value: '2', original: '1' },
      { type: 'setCell', ...k('1'), column: 'total', value: '1', original: '2' },
    ]);
    expect(s.updates).toEqual([]);
  });

  it('reverts one column and drops the row once nothing is left', () => {
    let s = reduce([
      { type: 'setCell', ...k('1'), column: 'total', value: '2', original: '1' },
      { type: 'setCell', ...k('1'), column: 'note', value: null, original: 'x' },
      { type: 'revertCell', rowKey: k('1').rowKey, column: 'total' },
    ]);
    expect(s.updates[0]!.set).toEqual({ note: null });
    s = stageReducer(s, { type: 'revertCell', rowKey: k('1').rowKey, column: 'note' });
    expect(s.updates).toEqual([]);
  });

  it('stages inserts with DEFAULT for columns left out', () => {
    const s = reduce([
      { type: 'addInsert', id: 'n1' },
      { type: 'setInsertCell', id: 'n1', column: 'total', value: '42.00' },
      { type: 'setInsertCell', id: 'n1', column: 'note', value: null },
      { type: 'setInsertCell', id: 'n1', column: 'note', value: undefined },
    ]);
    expect(s.inserts).toEqual([{ id: 'n1', values: { total: '42.00' } }]);
    expect(stageReducer(s, { type: 'removeInserts', ids: ['n1'] }).inserts).toEqual([]);
  });

  it('deletes rows once, drops their pending updates, and restores them', () => {
    let s = reduce([
      { type: 'setCell', ...k('1'), column: 'total', value: '2', original: '1' },
      { type: 'deleteRows', rows: [k('1'), k('2')] },
      { type: 'deleteRows', rows: [k('2')] },
    ]);
    expect(s.updates).toEqual([]);
    expect(s.deletes.map((d) => d.rowKey)).toEqual(['["1"]', '["2"]']);
    s = stageReducer(s, { type: 'restoreRows', rowKeys: ['["1"]'] });
    expect(s.deletes.map((d) => d.rowKey)).toEqual(['["2"]']);
  });

  it('discards everything', () => {
    const s = reduce([{ type: 'addInsert', id: 'n1' }, { type: 'discard' }]);
    expect(s).toEqual(emptyStage);
  });

  it('maps a commit error to the failing cell by editIndex and column', () => {
    const s = reduce([
      { type: 'setCell', ...k('100510'), column: 'total', value: '1e20', original: '1249.00' },
      { type: 'setCell', ...k('100508'), column: 'status', value: 'cancelled', original: 'paid' },
      { type: 'deleteRows', rows: [k('100505')] },
      { type: 'addInsert', id: 'n1' },
    ]);
    const { targets } = buildEdits(s, table);
    const failed = stageReducer(s, {
      type: 'commitFailed',
      error: { code: '22003', message: 'numeric field overflow', editIndex: 0 },
      targets,
    });
    expect(failed.error).toMatchObject({
      target: { type: 'update', rowKey: '["100510"]', column: 'total' },
      column: 'total',
      code: '22003',
    });
    // The stage is kept as it was.
    expect(failed.updates).toEqual(s.updates);

    const insertFailed = stageReducer(s, {
      type: 'commitFailed',
      error: { code: '23502', message: 'null value in column "customer_id"', editIndex: 3, column: 'customer_id' },
      targets,
    });
    expect(insertFailed.error).toMatchObject({ target: { type: 'insert', id: 'n1' }, column: 'customer_id' });

    const unknown = stageReducer(s, { type: 'commitFailed', error: { code: 'X', message: 'boom' }, targets });
    expect(unknown.error).toMatchObject({ target: null, column: null });
    expect(stageReducer(failed, { type: 'clearError' }).error).toBeNull();
  });
});

describe('buildEdits', () => {
  it('sends one update per changed cell, then deletes, then inserts', () => {
    const s = reduce([
      { type: 'setCell', ...k('1'), column: 'total', value: '2', original: '1' },
      { type: 'setCell', ...k('1'), column: 'note', value: null, original: 'x' },
      { type: 'addInsert', id: 'n1' },
      { type: 'deleteRows', rows: [k('9')] },
    ]);
    const { edits, targets } = buildEdits(s, table);
    expect(edits).toEqual([
      { kind: 'update', table, key: { id: '1' }, set: { total: '2' } },
      { kind: 'update', table, key: { id: '1' }, set: { note: null } },
      { kind: 'delete', table, key: { id: '9' } },
      { kind: 'insert', table, values: {} },
    ]);
    expect(targets.map((t) => t.type)).toEqual(['update', 'update', 'delete', 'insert']);
    expect(stageSize(s)).toEqual({ updated: 2, inserted: 1, deleted: 1, total: 4 });
  });
});

describe('renderPendingSql', () => {
  it('renders an update per changed cell with casts and the old value', () => {
    const s = reduce([
      { type: 'setCell', ...k('100510'), column: 'total', value: '1194.00', original: '1249.00' },
      { type: 'setCell', ...k('100508'), column: 'status', value: 'cancelled', original: 'paid' },
    ]);
    expect(renderPendingSql(s, table, types)).toBe(
      [
        'BEGIN;',
        `UPDATE "public"."orders" SET "total" = 1194.00::numeric WHERE "id" = 100510;  -- was 1249.00`,
        `UPDATE "public"."orders" SET "status" = 'cancelled'::order_status WHERE "id" = 100508;  -- was 'paid'`,
        'COMMIT;',
      ].join('\n'),
    );
  });

  it('renders NULL without a cast, quotes text and escapes quotes', () => {
    const s = reduce([
      { type: 'setCell', ...k('1'), column: 'note', value: "it's", original: null },
      { type: 'setCell', ...k('2'), column: 'note', value: null, original: 'x' },
    ]);
    const sql = renderPendingSql(s, table, types);
    expect(sql).toContain(`SET "note" = 'it''s'::text WHERE "id" = 1;  -- was NULL`);
    expect(sql).toContain(`SET "note" = NULL WHERE "id" = 2;  -- was 'x'`);
  });

  it('renders deletes and inserts with only the given columns', () => {
    const s = reduce([
      { type: 'deleteRows', rows: [k('100505')] },
      { type: 'addInsert', id: 'n1' },
      { type: 'setInsertCell', id: 'n1', column: 'customer_id', value: '3f1c2a9e-8b7d-4c11-9e2f-0a6b5d4c3e21' },
      { type: 'setInsertCell', id: 'n1', column: 'status', value: 'pending' },
      { type: 'setInsertCell', id: 'n1', column: 'total', value: '42.00' },
      { type: 'setInsertCell', id: 'n1', column: 'metadata', value: '{"channel": "admin"}' },
      { type: 'addInsert', id: 'n2' },
    ]);
    expect(renderPendingSql(s, table, types)).toBe(
      [
        'BEGIN;',
        'DELETE FROM "public"."orders" WHERE "id" = 100505;',
        'INSERT INTO "public"."orders" ("customer_id", "status", "total", "metadata")',
        `  VALUES ('3f1c2a9e-8b7d-4c11-9e2f-0a6b5d4c3e21'::uuid, 'pending'::order_status, 42.00::numeric, '{"channel": "admin"}'::jsonb);`,
        'INSERT INTO "public"."orders" DEFAULT VALUES;',
        'COMMIT;',
      ].join('\n'),
    );
  });

  it('quotes identifiers with embedded quotes and joins composite keys', () => {
    const s = reduce([
      {
        type: 'setCell',
        rowKey: '["1","a"]',
        key: { order_id: '1', 'line"no': 'a' },
        column: 'note',
        value: 'x',
        original: 'y',
      },
    ]);
    expect(renderPendingSql(s, { schema: 'my schema', name: 't' }, types)).toContain(
      `UPDATE "my schema"."t" SET "note" = 'x'::text WHERE "order_id" = '1' AND "line""no" = 'a';`,
    );
  });

  it('tokenizes for highlighting', () => {
    const kinds = tokenizeSql(`UPDATE "t" SET "a" = 'x'::text WHERE "id" = 1;  -- was 2`)
      .filter((t) => t.text.trim())
      .map((t) => t.kind);
    expect(kinds).toEqual([
      'keyword',
      'plain',
      'keyword',
      'plain',
      'plain',
      'string',
      'plain',
      'plain',
      'plain',
      'keyword',
      'plain',
      'plain',
      'number',
      'plain',
      'comment',
    ]);
  });
});

describe('filters', () => {
  it('turns chips into API filters, dropping the value for null tests', () => {
    const chips: FilterChip[] = [
      { id: 'a', column: 'placed_at', op: 'gte', value: '2026-11-01' },
      { id: 'b', column: 'status', op: 'isNotNull', value: 'ignored' },
      { id: 'c', column: 'note', op: 'contains', value: 'ring' },
    ];
    expect(chipsToFilters(chips)).toEqual([
      { column: 'placed_at', op: 'gte', value: '2026-11-01' },
      { column: 'status', op: 'isNotNull' },
      { column: 'note', op: 'contains', value: 'ring' },
    ]);
    expect(chipToFilter({ id: 'd', column: 'x', op: 'isNull', value: '' })).toEqual({ column: 'x', op: 'isNull' });
  });

  it('links a foreign-key cell to the referenced row as equality filters', () => {
    const fk: ForeignKey = {
      name: 'orders_customer_fk',
      schema: 'public',
      table: 'orders',
      columns: ['customer_id'],
      refSchema: 'crm',
      refTable: 'customers',
      refColumns: ['id'],
    };
    let n = 0;
    const target = foreignKeyTarget(fk, { customer_id: '3f1c', total: '1' }, () => `id${(n += 1)}`);
    expect(target).toEqual({
      table: { schema: 'crm', name: 'customers' },
      chips: [{ id: 'id1', column: 'id', op: 'eq', value: '3f1c' }],
    });
    expect(chipsToFilters(target!.chips)).toEqual([{ column: 'id', op: 'eq', value: '3f1c' }]);
  });

  it('links composite foreign keys on every column and refuses NULL references', () => {
    const fk: ForeignKey = {
      name: 'fk',
      schema: 'public',
      table: 'order_items',
      columns: ['order_id', 'line'],
      refSchema: 'public',
      refTable: 'lines',
      refColumns: ['oid', 'lno'],
    };
    expect(
      foreignKeyTarget(fk, { order_id: '1', line: '2' }, () => 'x')!.chips.map((c) => [c.column, c.value]),
    ).toEqual([
      ['oid', '1'],
      ['lno', '2'],
    ]);
    expect(foreignKeyTarget(fk, { order_id: '1', line: null }, () => 'x')).toBeNull();
  });
});

describe('sorting and paging helpers', () => {
  it('cycles a single sort asc, desc, off', () => {
    expect(nextSort([], 'a', false)).toEqual([{ column: 'a', dir: 'asc' }]);
    expect(nextSort([{ column: 'a', dir: 'asc' }], 'a', false)).toEqual([{ column: 'a', dir: 'desc' }]);
    expect(nextSort([{ column: 'a', dir: 'desc' }], 'a', false)).toEqual([]);
    expect(nextSort([{ column: 'a', dir: 'asc' }], 'b', false)).toEqual([{ column: 'b', dir: 'asc' }]);
  });

  it('adds, flips and removes columns of a multi-sort with Shift', () => {
    const one = [{ column: 'a', dir: 'asc' as const }];
    const two = nextSort(one, 'b', true);
    expect(two).toEqual([
      { column: 'a', dir: 'asc' },
      { column: 'b', dir: 'asc' },
    ]);
    expect(nextSort(two, 'a', true)).toEqual([
      { column: 'a', dir: 'desc' },
      { column: 'b', dir: 'asc' },
    ]);
    expect(nextSort([{ column: 'a', dir: 'desc' }, ...two.slice(1)], 'a', true)).toEqual([{ column: 'b', dir: 'asc' }]);
  });

  it('groups digits and counts pages from text counts', () => {
    expect(groupDigits('1204380')).toBe('1,204,380');
    expect(groupDigits('99999999999999999999')).toBe('99,999,999,999,999,999,999');
    expect(pageCount('1204380')).toBe('6022');
    expect(pageCount('0')).toBe('1');
    expect(pageCount('200')).toBe('1');
    expect(pageCount('201')).toBe('2');
    expect(pageCount('-1')).toBeNull();
  });
});
