import type { DdlChange, Table } from '@kleos/shared';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TableDetailPanel } from '@/features/schema/table-detail-panel';
import { shopModel } from '@/features/schema/test-fixtures';
import type { WorkspaceState } from '@/features/workspace/context';
import { Providers, workspaceState } from '@/features/workspace/test-workspace';
import type * as ApiModule from '@/lib/api';
import { api, ApiError } from '@/lib/api';
import { NewTableButton } from './new-table-button';
import { SchemaPendingPanel } from './schema-pending-panel';
import { getSchemaEdit, resetSchemaEdits } from './store';

vi.mock('@/lib/api', async (importOriginal) => {
  const actual = await importOriginal<typeof ApiModule>();
  return { ...actual, api: { previewDdl: vi.fn(), applyDdl: vi.fn() } };
});

const mocked = vi.mocked(api);

/** A fake statement per change, so the SQL block and the list line up in assertions. */
const fakeStatement = (c: DdlChange, i: number) => `ALTER TABLE stmt_${i + 1} /* ${c.op} */`;

function ordersTable(): Table {
  const model = shopModel();
  const orders = model.tables.find((t) => t.name === 'orders')!;
  return {
    ...orders,
    indexes: [
      {
        name: 'orders_pkey',
        definition: 'CREATE UNIQUE INDEX orders_pkey ON public.orders USING btree (id)',
        columns: ['id'],
        unique: true,
        primary: true,
        method: 'btree',
      },
      {
        name: 'orders_customer_id_idx',
        definition: 'CREATE INDEX orders_customer_id_idx ON public.orders USING btree (customer_id)',
        columns: ['customer_id'],
        unique: false,
        primary: false,
        method: 'btree',
      },
    ],
    constraints: [{ name: 'orders_pkey', type: 'p', definition: 'PRIMARY KEY (id)' }],
  };
}

function renderEditor(patch: Partial<WorkspaceState> = {}, table: Table = ordersTable()) {
  const model = shopModel();
  const state = workspaceState({ schemaModel: model, selectedTable: { schema: 'public', name: table.name }, ...patch });
  render(
    <Providers state={state}>
      <NewTableButton schema="public" />
      <TableDetailPanel
        table={table}
        foreignKeys={model.foreignKeys}
        onClose={vi.fn()}
        onOpenTable={vi.fn()}
        onViewData={vi.fn()}
        onOpenInQuery={vi.fn()}
      />
      <SchemaPendingPanel />
    </Providers>,
  );
  return { state, panel: screen.getByRole('complementary', { name: 'Table details' }) };
}

const user = () => userEvent.setup();

async function columnMenu(u: ReturnType<typeof user>, column: string, item: string | RegExp) {
  await u.click(screen.getByRole('button', { name: `Actions for column ${column}` }));
  await u.click(await screen.findByRole('menuitem', { name: item }));
}

async function tableMenu(u: ReturnType<typeof user>, item: string | RegExp) {
  await u.click(screen.getByRole('button', { name: /^Actions for table / }));
  await u.click(await screen.findByRole('menuitem', { name: item }));
}

function listed(): string[] {
  const list = screen.queryByRole('list', { name: 'Staged changes' });
  return list
    ? within(list)
        .queryAllByRole('listitem')
        .map((li) => li.textContent ?? '')
    : [];
}

beforeEach(() => {
  mocked.previewDdl.mockImplementation(async (_sid, req) => ({ statements: req.changes.map(fakeStatement) }));
});
afterEach(() => {
  vi.clearAllMocks();
  resetSchemaEdits();
});

describe('Schema editing', { timeout: 20_000 }, () => {
  it('stages each kind of change from the detail panel and lists it in plain words', async () => {
    const u = user();
    const { panel } = renderEditor();
    expect(screen.queryByRole('region', { name: 'Pending schema changes' })).not.toBeInTheDocument();

    // Add column: a ghost row with a "new" badge.
    await u.click(within(panel).getByRole('button', { name: 'Add column' }));
    let dialog = await screen.findByRole('dialog');
    await u.type(within(dialog).getByLabelText('Name'), 'note');
    await u.type(within(dialog).getByLabelText('Type'), 'text');
    await u.type(within(dialog).getByLabelText(/^Default/), 'now()');
    await u.click(within(dialog).getByRole('button', { name: 'Stage column' }));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(within(panel).getByText('note')).toBeInTheDocument();
    expect(within(panel).getByText('new')).toBeInTheDocument();

    // Rename a column: later actions use the new name.
    await columnMenu(u, 'customer_id', 'Rename…');
    dialog = await screen.findByRole('dialog');
    await u.clear(within(dialog).getByLabelText('New name'));
    await u.type(within(dialog).getByLabelText('New name'), 'buyer_id');
    await u.click(within(dialog).getByRole('button', { name: 'Stage rename' }));
    expect(within(panel).getByText('buyer_id')).toBeInTheDocument();
    expect(within(panel).getByText('pending')).toBeInTheDocument();

    // Change type with USING.
    await columnMenu(u, 'metadata', 'Change type…');
    dialog = await screen.findByRole('dialog');
    await u.clear(within(dialog).getByLabelText('New type'));
    await u.type(within(dialog).getByLabelText('New type'), 'json');
    await u.type(within(dialog).getByLabelText('Using (optional)'), 'metadata::json');
    await u.click(within(dialog).getByRole('button', { name: 'Stage type change' }));

    // Forbid NULL (direct), set then drop a default (the drop replaces the set).
    await columnMenu(u, 'metadata', 'Forbid NULL');
    await columnMenu(u, 'metadata', 'Set default…');
    dialog = await screen.findByRole('dialog');
    await u.type(within(dialog).getByLabelText('Default expression'), '0');
    await u.click(within(dialog).getByRole('button', { name: 'Stage default' }));
    await columnMenu(u, 'metadata', 'Drop default');

    // Drop a column, with the explicit cascade checkbox.
    await columnMenu(u, 'buyer_id', /Drop column/);
    dialog = await screen.findByRole('dialog');
    await u.click(within(dialog).getByRole('checkbox', { name: /Also drop dependent objects/ }));
    await u.click(within(dialog).getByRole('button', { name: 'Stage drop' }));
    expect(within(panel).getByText('drop')).toBeInTheDocument();

    // Indexes: add one (columns in click order, unique, method), drop one; the primary key's has no drop.
    await u.click(within(panel).getByRole('button', { name: 'Add index' }));
    dialog = await screen.findByRole('dialog');
    const cols = within(dialog).getByRole('group', { name: 'Columns, in index order' });
    await u.click(within(cols).getByRole('checkbox', { name: /metadata/ }));
    await u.click(within(cols).getByRole('checkbox', { name: /id$/ }));
    await u.click(within(dialog).getByRole('checkbox', { name: 'Unique' }));
    await u.click(within(dialog).getByRole('button', { name: 'Stage index' }));
    expect(within(panel).queryByRole('button', { name: 'Drop index orders_pkey' })).not.toBeInTheDocument();
    await u.click(within(panel).getByRole('button', { name: 'Drop index orders_customer_id_idx' }));

    // Rename the table, then drop it after typing its (new) name.
    await tableMenu(u, 'Rename table…');
    dialog = await screen.findByRole('dialog');
    await u.clear(within(dialog).getByLabelText('New name'));
    await u.type(within(dialog).getByLabelText('New name'), 'purchases');
    await u.click(within(dialog).getByRole('button', { name: 'Stage rename' }));
    expect(within(panel).getByText('Renamed to')).toBeInTheDocument();
    await tableMenu(u, /Drop table/);
    dialog = await screen.findByRole('dialog');
    const drop = within(dialog).getByRole('button', { name: 'Stage drop' });
    expect(drop).toBeDisabled();
    await u.type(within(dialog).getByLabelText(/to confirm/), 'orders');
    expect(drop).toBeDisabled();
    await u.clear(within(dialog).getByLabelText(/to confirm/));
    await u.type(within(dialog).getByLabelText(/to confirm/), 'purchases');
    await u.click(drop);
    expect(within(panel).getByText('Staged to be dropped when you apply.')).toBeInTheDocument();
    // A dropped table offers nothing more to edit.
    expect(within(panel).queryByRole('button', { name: /^Actions for/ })).not.toBeInTheDocument();

    const expected = [
      'Add column note (text, default now()) to public.orders',
      'Rename column public.orders.customer_id to buyer_id',
      'Change the type of public.orders.metadata to json using metadata::json',
      'Forbid NULL in public.orders.metadata',
      'Drop the default of public.orders.metadata',
      'Drop column public.orders.buyer_id and everything that depends on it',
      'Add a unique btree index on public.orders (metadata, id)',
      'Drop index public.orders_customer_id_idx',
      'Rename table public.orders to purchases',
      'Drop table public.purchases',
    ];
    expect(listed()).toEqual(expected.map((text, i) => `${i + 1}${text}`));
    expect(screen.getByRole('button', { name: /Apply 10 changes/ })).toBeEnabled();

    // The preview is asked for the whole staged list, in order.
    await waitFor(() =>
      expect(mocked.previewDdl).toHaveBeenLastCalledWith('s1', {
        changes: getSchemaEdit('s1').changes.map((s) => s.change),
      }),
    );
    const last = mocked.previewDdl.mock.calls.at(-1)![1].changes;
    expect(last[0]).toEqual({
      op: 'addColumn',
      table: { schema: 'public', name: 'orders' },
      column: { name: 'note', type: 'text', nullable: true, default: 'now()' },
    });
    expect(last[6]).toEqual({
      op: 'createIndex',
      table: { schema: 'public', name: 'orders' },
      name: null,
      columns: ['metadata', 'id'],
      unique: true,
      method: 'btree',
    });
    expect(last[9]).toEqual({ op: 'dropTable', table: { schema: 'public', name: 'purchases' }, cascade: false });
    const sql = screen.getByLabelText('SQL that will run');
    await waitFor(() => expect(sql).toHaveTextContent('ALTER TABLE stmt_10 /* dropTable */;'));
    expect(sql).toHaveTextContent(/^BEGIN;.*COMMIT;$/);
  });

  it('undoes a toggle instead of stacking it, and removes or edits staged rows', async () => {
    const u = user();
    renderEditor();
    await columnMenu(u, 'metadata', 'Forbid NULL');
    expect(listed()).toEqual(['1Forbid NULL in public.orders.metadata']);
    await columnMenu(u, 'metadata', 'Allow NULL');
    expect(listed()).toEqual([]);

    await u.click(screen.getByRole('button', { name: 'Add column' }));
    let dialog = await screen.findByRole('dialog');
    await u.type(within(dialog).getByLabelText('Name'), 'note');
    await u.type(within(dialog).getByLabelText('Type'), 'text');
    await u.click(within(dialog).getByRole('button', { name: 'Stage column' }));
    await columnMenu(u, 'note', 'Edit new column…');
    dialog = await screen.findByRole('dialog');
    await u.clear(within(dialog).getByLabelText('Type'));
    await u.type(within(dialog).getByLabelText('Type'), 'varchar(80)');
    await u.click(within(dialog).getByRole('checkbox', { name: 'Allow NULL' }));
    await u.click(within(dialog).getByRole('button', { name: 'Update column' }));
    expect(listed()).toEqual(['1Add column note (varchar(80), not null) to public.orders']);

    await u.click(screen.getByRole('button', { name: 'Remove change 1' }));
    expect(screen.queryByRole('region', { name: 'Pending schema changes' })).not.toBeInTheDocument();
  });

  it('refuses names already taken in the column dialogs', async () => {
    const u = user();
    renderEditor();
    await columnMenu(u, 'metadata', 'Rename…');
    const dialog = await screen.findByRole('dialog');
    await u.clear(within(dialog).getByLabelText('New name'));
    await u.type(within(dialog).getByLabelText('New name'), 'customer_id');
    await u.click(within(dialog).getByRole('button', { name: 'Stage rename' }));
    expect(within(dialog).getByText('orders already has a column named customer_id.')).toBeInTheDocument();
    expect(listed()).toEqual([]);
  });

  it('shows a preview error on the change it names', async () => {
    const u = user();
    mocked.previewDdl.mockRejectedValue(
      new ApiError(400, { code: '42704', message: 'type "jsonx" does not exist', statementIndex: 1 }),
    );
    renderEditor();
    await columnMenu(u, 'metadata', 'Forbid NULL');
    await columnMenu(u, 'metadata', 'Change type…');
    const dialog = await screen.findByRole('dialog');
    await u.clear(within(dialog).getByLabelText('New type'));
    await u.type(within(dialog).getByLabelText('New type'), 'jsonx');
    await u.click(within(dialog).getByRole('button', { name: 'Stage type change' }));
    const items = await waitFor(() => {
      const li = within(screen.getByRole('list', { name: 'Staged changes' })).getAllByRole('listitem');
      expect(li[1]).toHaveTextContent('42704 type "jsonx" does not exist');
      return li;
    });
    expect(items[1]).toHaveAttribute('aria-invalid', 'true');
    expect(items[0]).not.toHaveAttribute('aria-invalid');
  });

  it('applies the list, says so and refreshes the schema', async () => {
    const u = user();
    mocked.applyDdl.mockResolvedValue({ statements: ['a', 'b'], elapsedMs: 12 });
    const { state } = renderEditor();
    await columnMenu(u, 'metadata', 'Forbid NULL');
    await tableMenu(u, 'Rename table…');
    const dialog = await screen.findByRole('dialog');
    await u.clear(within(dialog).getByLabelText('New name'));
    await u.type(within(dialog).getByLabelText('New name'), 'purchases');
    await u.click(within(dialog).getByRole('button', { name: 'Stage rename' }));

    await u.click(screen.getByRole('button', { name: /Apply 2 changes/ }));
    await waitFor(() => expect(state.refreshSchema).toHaveBeenCalledTimes(1));
    expect(mocked.applyDdl).toHaveBeenCalledWith('s1', {
      changes: [
        { op: 'setNotNull', table: { schema: 'public', name: 'orders' }, column: 'metadata', notNull: true },
        { op: 'renameTable', table: { schema: 'public', name: 'orders' }, newName: 'purchases' },
      ],
    });
    // The selection follows the renamed table; the list is cleared.
    expect(state.openTable).toHaveBeenCalledWith({ schema: 'public', name: 'purchases' });
    expect(getSchemaEdit('s1').changes).toEqual([]);
    expect(screen.queryByRole('region', { name: 'Pending schema changes' })).not.toBeInTheDocument();
  });

  it('keeps the list when apply fails, highlights the failing change and says nothing was applied', async () => {
    const u = user();
    mocked.applyDdl.mockRejectedValue(
      new ApiError(400, {
        code: '23502',
        message: 'column "metadata" of relation "orders" contains null values',
        detail: 'Failing row contains (7, null).',
        hint: 'Update the rows first.',
        statementIndex: 1,
      }),
    );
    const { state } = renderEditor();
    await columnMenu(u, 'customer_id', 'Rename…');
    const dialog = await screen.findByRole('dialog');
    await u.clear(within(dialog).getByLabelText('New name'));
    await u.type(within(dialog).getByLabelText('New name'), 'buyer_id');
    await u.click(within(dialog).getByRole('button', { name: 'Stage rename' }));
    await columnMenu(u, 'metadata', 'Forbid NULL');
    const sql = screen.getByLabelText('SQL that will run');
    await waitFor(() => expect(sql).toHaveTextContent('stmt_2'));
    await waitFor(() => expect(sql).not.toHaveAttribute('aria-busy'));

    // ⌘S applies while the schema tab is in front.
    await u.keyboard('{Meta>}s{/Meta}');
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('Apply failed. Nothing was applied.');
    expect(alert).toHaveTextContent('Change 2: 23502 column "metadata" of relation "orders" contains null values');
    expect(alert).toHaveTextContent('Failing row contains (7, null).');
    expect(alert).toHaveTextContent('Hint: Update the rows first.');
    expect(alert).toHaveTextContent('ALTER TABLE stmt_2 /* setNotNull */');
    const items = within(screen.getByRole('list', { name: 'Staged changes' })).getAllByRole('listitem');
    expect(items).toHaveLength(2);
    expect(items[1]).toHaveAttribute('aria-invalid', 'true');
    expect(items[1]).toHaveTextContent('This statement failed.');
    expect(sql.querySelector('[data-failed]')).toHaveTextContent('stmt_2');
    expect(state.refreshSchema).not.toHaveBeenCalled();
  });

  it('does not apply on ⌘S when the schema tab is not in front', async () => {
    const u = user();
    renderEditor({ activeTab: 'data' });
    await columnMenu(u, 'metadata', 'Forbid NULL');
    await u.keyboard('{Meta>}s{/Meta}');
    expect(mocked.applyDdl).not.toHaveBeenCalled();
  });

  it('offers no editing on a read-only session, and says why', async () => {
    const u = user();
    const { panel } = renderEditor({ readOnly: true });
    expect(within(panel).queryByRole('button', { name: /^Actions for/ })).not.toBeInTheDocument();
    expect(within(panel).queryByRole('button', { name: 'Add column' })).not.toBeInTheDocument();
    expect(within(panel).queryByRole('button', { name: 'Add index' })).not.toBeInTheDocument();
    expect(within(panel).queryByRole('button', { name: /Drop index/ })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'New table…' })).toBeDisabled();
    await u.hover(screen.getByLabelText(/^New table: /));
    expect(await screen.findByRole('tooltip')).toHaveTextContent('Read-only connection: schema changes are off.');
  });

  it('offers no editing on a view', () => {
    const view = shopModel().views[0]!;
    const { panel } = renderEditor({}, view);
    expect(within(panel).queryByRole('button', { name: /^Actions for/ })).not.toBeInTheDocument();
    expect(within(panel).queryByRole('button', { name: 'Add column' })).not.toBeInTheDocument();
  });
});

describe('New table dialog', { timeout: 20_000 }, () => {
  it('validates the name and columns, then stages a createTable', async () => {
    const u = user();
    renderEditor();
    await u.click(screen.getByRole('button', { name: 'New table…' }));
    const dialog = await screen.findByRole('dialog', { name: 'New table' });
    expect(within(dialog).getByRole('combobox', { name: 'Schema' })).toHaveTextContent('public');

    // Nothing filled in: name required, at least one column.
    await u.click(within(dialog).getByRole('button', { name: 'Stage table' }));
    expect(within(dialog).getByText('Table name is required.')).toBeInTheDocument();
    expect(within(dialog).getByText('Add at least one column.')).toBeInTheDocument();

    // A taken name, then duplicate column names.
    await u.type(within(dialog).getByLabelText('Table name'), 'orders');
    expect(within(dialog).getByText('public already has a table named orders.')).toBeInTheDocument();
    await u.clear(within(dialog).getByLabelText('Table name'));
    await u.type(within(dialog).getByLabelText('Table name'), 'invoices');
    await u.type(within(dialog).getByLabelText('Column 1 name'), 'id');
    await u.type(within(dialog).getByLabelText('Column 1 type'), 'bigint');
    await u.click(within(dialog).getByRole('checkbox', { name: 'Column 1 primary key' }));
    expect(within(dialog).getByRole('checkbox', { name: 'Column 1 nullable' })).toBeDisabled();
    await u.click(within(dialog).getByRole('button', { name: 'Add column' }));
    await u.type(within(dialog).getByLabelText('Column 2 name'), 'id');
    await u.type(within(dialog).getByLabelText('Column 2 type'), 'text');
    await u.click(within(dialog).getByRole('button', { name: 'Stage table' }));
    expect(within(dialog).getByText('Another column is already named id.')).toBeInTheDocument();
    expect(listed()).toEqual([]);

    await u.clear(within(dialog).getByLabelText('Column 2 name'));
    await u.type(within(dialog).getByLabelText('Column 2 name'), 'total');
    await u.clear(within(dialog).getByLabelText('Column 2 type'));
    await u.type(within(dialog).getByLabelText('Column 2 type'), 'numeric(12,2)');
    await u.type(within(dialog).getByLabelText('Column 2 default'), '0');
    await u.click(within(dialog).getByRole('button', { name: 'Stage table' }));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(listed()).toEqual(['1Create table public.invoices with 2 columns, primary key (id)']);
    expect(getSchemaEdit('s1').changes[0]?.change).toEqual({
      op: 'createTable',
      schema: 'public',
      name: 'invoices',
      columns: [
        { name: 'id', type: 'bigint', nullable: false, default: null },
        { name: 'total', type: 'numeric(12,2)', nullable: true, default: '0' },
      ],
      primaryKey: ['id'],
    });

    // Edit reopens it filled in.
    await u.click(screen.getByRole('button', { name: 'Edit change 1' }));
    const edit = await screen.findByRole('dialog', { name: 'Edit new table' });
    expect(within(edit).getByLabelText('Table name')).toHaveValue('invoices');
    expect(within(edit).getByLabelText('Column 2 type')).toHaveValue('numeric(12,2)');
  });

  it('suggests common types and the database enums', async () => {
    const u = user();
    renderEditor();
    await u.click(screen.getByRole('button', { name: 'New table…' }));
    const dialog = await screen.findByRole('dialog', { name: 'New table' });
    const input = within(dialog).getByLabelText('Column 1 type');
    const list = document.getElementById(input.getAttribute('list')!)!;
    const values = [...list.querySelectorAll('option')].map((o) => o.value);
    expect(values).toContain('timestamptz');
    expect(values).toContain('public.order_status');
  });
});
