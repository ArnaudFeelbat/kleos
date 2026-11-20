import type { DdlChange } from '@kleos/shared';
import { describe, expect, it } from 'vitest';
import { col, table } from '@/features/schema/test-fixtures';
import { tokenizeDdl } from './ddl-sql';
import { changeCounts, describeChange } from './describe';
import { createTableChange, draftOf, emptyColumnDraft, hasErrors, validateNewTable, type NewTableDraft } from './model';
import { tableOverlay } from './overlay';
import { emptySchemaEdit, schemaEditReducer, type SchemaEditState, type StagedDdl } from './store';

const orders = { schema: 'public', name: 'orders' };

describe('describeChange', () => {
  it('puts every kind of change in plain words', () => {
    const changes: DdlChange[] = [
      {
        op: 'createTable',
        schema: 'shop',
        name: 'invoices',
        columns: [
          { name: 'id', type: 'bigint', nullable: false },
          { name: 'total', type: 'numeric(12,2)' },
        ],
        primaryKey: ['id'],
      },
      { op: 'renameTable', table: orders, newName: 'purchases' },
      { op: 'dropTable', table: orders, cascade: true },
      { op: 'addColumn', table: orders, column: { name: 'note', type: 'text', nullable: false, default: "''" } },
      { op: 'renameColumn', table: orders, column: 'email', newName: 'contact' },
      { op: 'alterColumnType', table: orders, column: 'total', type: 'numeric(12,2)', using: 'total::numeric' },
      { op: 'setNotNull', table: orders, column: 'email', notNull: true },
      { op: 'setNotNull', table: orders, column: 'email', notNull: false },
      { op: 'setDefault', table: orders, column: 'status', default: "'draft'" },
      { op: 'setDefault', table: orders, column: 'status', default: null },
      { op: 'dropColumn', table: orders, column: 'legacy' },
      { op: 'createIndex', table: orders, columns: ['customer_id', 'created_at'], unique: true, method: 'btree' },
      { op: 'createIndex', table: orders, name: 'orders_tags_idx', columns: ['tags'], method: 'gin' },
      { op: 'dropIndex', schema: 'public', name: 'orders_status_idx' },
    ];
    expect(changes.map(describeChange)).toEqual([
      'Create table shop.invoices with 2 columns, primary key (id)',
      'Rename table public.orders to purchases',
      'Drop table public.orders and everything that depends on it',
      "Add column note (text, not null, default '') to public.orders",
      'Rename column public.orders.email to contact',
      'Change the type of public.orders.total to numeric(12,2) using total::numeric',
      'Forbid NULL in public.orders.email',
      'Allow NULL in public.orders.email',
      "Set the default of public.orders.status to 'draft'",
      'Drop the default of public.orders.status',
      'Drop column public.orders.legacy',
      'Add a unique btree index on public.orders (customer_id, created_at)',
      'Add a gin index on public.orders (tags) named orders_tags_idx',
      'Drop index public.orders_status_idx',
    ]);
    expect(changeCounts(changes)).toEqual({ added: 4, altered: 7, dropped: 3 });
  });

  it('highlights DDL keywords in the preview', () => {
    const tokens = tokenizeDdl('ALTER TABLE "public"."orders" ADD COLUMN "note" text DEFAULT \'x\'');
    expect(tokens.filter((t) => t.kind === 'keyword').map((t) => t.text)).toEqual([
      'ALTER',
      'TABLE',
      'ADD',
      'COLUMN',
      'DEFAULT',
    ]);
    expect(tokens.find((t) => t.kind === 'string')?.text).toBe("'x'");
  });
});

describe('schemaEditReducer', () => {
  const stage = (state: SchemaEditState, id: string, change: DdlChange) =>
    schemaEditReducer(state, { type: 'stage', id, change });

  it('replaces an earlier setting of the same column and moves it last', () => {
    let s = stage(emptySchemaEdit, 'a', { op: 'setDefault', table: orders, column: 'status', default: "'x'" });
    s = stage(s, 'b', { op: 'renameColumn', table: orders, column: 'email', newName: 'contact' });
    s = stage(s, 'c', { op: 'setDefault', table: orders, column: 'status', default: "'y'" });
    expect(s.changes.map((c) => c.id)).toEqual(['b', 'c']);
    // Two renames of different columns both stay.
    s = stage(s, 'd', { op: 'renameColumn', table: orders, column: 'total', newName: 'amount' });
    expect(s.changes).toHaveLength(3);
  });

  it('clears a failure on any change to the list, and empties on discard', () => {
    let s = stage(emptySchemaEdit, 'a', { op: 'dropColumn', table: orders, column: 'x' });
    s = schemaEditReducer(s, {
      type: 'failed',
      failure: { changeId: 'a', statement: null, code: '42703', message: 'column "x" does not exist' },
    });
    expect(s.failure?.changeId).toBe('a');
    expect(s.changes).toHaveLength(1);
    s = schemaEditReducer(s, { type: 'update', id: 'a', change: { op: 'dropColumn', table: orders, column: 'y' } });
    expect(s.failure).toBeNull();
    expect(schemaEditReducer(s, { type: 'discard' })).toBe(emptySchemaEdit);
  });
});

describe('tableOverlay', () => {
  const t = table('orders', [col('id', 'bigint'), col('email', 'text', { nullable: true }), col('legacy', 'text')], {
    indexes: [
      { name: 'orders_email_idx', definition: '', columns: ['email'], unique: false, primary: false, method: 'btree' },
    ],
  });
  const staged = (changes: DdlChange[]): StagedDdl[] => changes.map((change, i) => ({ id: `s${i}`, change }));

  it('follows table and column renames through the list', () => {
    const o = tableOverlay(
      t,
      staged([
        { op: 'renameColumn', table: orders, column: 'email', newName: 'contact' },
        { op: 'renameTable', table: orders, newName: 'purchases' },
        // Written after the renames, so it names the new table and column.
        { op: 'setNotNull', table: { schema: 'public', name: 'purchases' }, column: 'contact', notNull: true },
        { op: 'addColumn', table: { schema: 'public', name: 'purchases' }, column: { name: 'note', type: 'text' } },
        { op: 'dropColumn', table: { schema: 'public', name: 'purchases' }, column: 'legacy' },
        { op: 'dropIndex', schema: 'public', name: 'orders_email_idx' },
        { op: 'setNotNull', table: { schema: 'public', name: 'other' }, column: 'id', notNull: true },
      ]),
    );
    expect(o.ref).toEqual({ schema: 'public', name: 'purchases' });
    expect(o.touching).toBe(6);
    const [id, email, legacy, note] = o.columns;
    expect(id?.changes).toEqual([]);
    expect(email).toMatchObject({ name: 'contact', nullable: false });
    expect(email?.changes.map((s) => s.id)).toEqual(['s0', 's2']);
    expect(legacy?.dropped?.id).toBe('s4');
    expect(note).toMatchObject({ key: 's3', name: 'note', original: null, nullable: true });
    expect(o.indexes[0]?.dropped?.id).toBe('s5');
  });
});

describe('validateNewTable', () => {
  const draft = (patch: Partial<NewTableDraft>): NewTableDraft => ({
    schema: 'public',
    name: 'invoices',
    columns: [{ ...emptyColumnDraft(), name: 'id', type: 'bigint', primaryKey: true }],
    ...patch,
  });

  it('requires a name, a new name, and at least one column', () => {
    expect(validateNewTable(draft({ name: '' }), []).name).toBe('Table name is required.');
    expect(validateNewTable(draft({}), ['invoices']).name).toBe('public already has a table named invoices.');
    expect(validateNewTable(draft({ columns: [emptyColumnDraft()] }), []).columns).toBe('Add at least one column.');
    expect(validateNewTable(draft({ name: 'x'.repeat(64) }), []).name).toBe('Table name is longer than 63 bytes.');
    expect(hasErrors(validateNewTable(draft({}), []))).toBe(false);
  });

  it('refuses duplicate column names and rows without a type', () => {
    const a = { ...emptyColumnDraft(), name: 'id', type: 'bigint' };
    const b = { ...emptyColumnDraft(), name: 'id', type: 'text' };
    const c = { ...emptyColumnDraft(), name: 'total', type: '' };
    const errors = validateNewTable(draft({ columns: [a, b, c, emptyColumnDraft()] }), []);
    expect(errors.rows[a.id]).toBeUndefined();
    expect(errors.rows[b.id]?.name).toBe('Another column is already named id.');
    expect(errors.rows[c.id]?.type).toBe('Type is required.');
  });

  it('builds the createTable change, primary-key columns NOT NULL, and back', () => {
    const d = draft({
      columns: [
        { ...emptyColumnDraft(), name: 'id', type: ' bigint ', nullable: true, primaryKey: true },
        { ...emptyColumnDraft(), name: 'note', type: 'text', default: " 'n/a' " },
        emptyColumnDraft(),
      ],
    });
    const change = createTableChange(d);
    expect(change).toEqual({
      op: 'createTable',
      schema: 'public',
      name: 'invoices',
      columns: [
        { name: 'id', type: 'bigint', nullable: false, default: null },
        { name: 'note', type: 'text', nullable: true, default: "'n/a'" },
      ],
      primaryKey: ['id'],
    });
    expect(createTableChange(draftOf(change))).toEqual(change);
  });
});
