import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ReactNode } from 'react';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  emptyGridLayout,
  type Column,
  type GridLayout,
  type RowsPage,
  type SchemaModel,
  type Table,
} from '@kleos/shared';
import { TooltipProvider } from '@/components/ui/tooltip';
import { WorkspaceContext, type WorkspaceState } from '@/features/workspace/context';
import type * as apiModule from '@/lib/api';
import { api, ApiError } from '@/lib/api';
import { DataTab } from './data-tab';
import { getTableView, resetTableViews, updateTableView } from './table-state';

vi.mock('@/lib/api', async (importOriginal) => {
  const actual = await importOriginal<typeof apiModule>();
  return {
    ...actual,
    api: {
      rows: vi.fn(),
      count: vi.fn(),
      applyEdits: vi.fn(),
      getGridLayout: vi.fn(),
      saveGridLayout: vi.fn(),
    },
  };
});
const mocked = vi.mocked(api);

// jsdom has no layout; give the grid's scroll element a viewport so rows render.
const sizes = { clientWidth: 1400, clientHeight: 800 };
const saved: Partial<Record<keyof typeof sizes, PropertyDescriptor | undefined>> = {};
beforeAll(() => {
  for (const [k, v] of Object.entries(sizes) as [keyof typeof sizes, number][]) {
    saved[k] = Object.getOwnPropertyDescriptor(HTMLElement.prototype, k);
    Object.defineProperty(HTMLElement.prototype, k, { configurable: true, get: () => v });
  }
});
afterAll(() => {
  for (const k of Object.keys(sizes) as (keyof typeof sizes)[]) {
    if (saved[k]) Object.defineProperty(HTMLElement.prototype, k, saved[k]);
  }
});

const col = (name: string, typeName: string, typeCategory: string, extra: Partial<Column> = {}): Column => ({
  name,
  type: typeName,
  typeName,
  typeOid: 0,
  typeCategory,
  nullable: true,
  default: null,
  identity: null,
  generated: false,
  ...extra,
});

const orders: Table = {
  schema: 'public',
  name: 'orders',
  kind: 'table',
  columns: [
    col('id', 'int8', 'N', { nullable: false, identity: 'by default' }),
    col('customer_id', 'uuid', 'U'),
    col('status', 'order_status', 'E', { enumValues: ['pending', 'paid', 'cancelled'] }),
    col('total', 'numeric', 'N', { type: 'numeric(12,2)' }),
    col('note', 'text', 'S'),
  ],
  primaryKey: ['id'],
  indexes: [],
  constraints: [],
  rowEstimate: 1204380,
  totalBytes: 0,
  comment: null,
};
const customers: Table = { ...orders, name: 'customers', columns: [col('id', 'uuid', 'U')] };
const model: SchemaModel = {
  schemas: ['public'],
  tables: [orders, customers],
  views: [{ ...orders, name: 'order_totals', kind: 'view', primaryKey: [] }],
  foreignKeys: [
    {
      name: 'orders_customer_fk',
      schema: 'public',
      table: 'orders',
      columns: ['customer_id'],
      refSchema: 'public',
      refTable: 'customers',
      refColumns: ['id'],
    },
  ],
  enums: [],
  introspectedAt: '',
};

const page: RowsPage = {
  columns: orders.columns.map(({ name, type, typeName, typeOid, typeCategory }) => ({
    name,
    type,
    typeName,
    typeOid,
    typeCategory,
  })),
  rows: [
    ['100512', '3f1c2a9e-8b7d-4c11-9e2f-0a6b5d4c3e21', 'paid', '129.90', null],
    ['100510', 'a7e09b44-12cd-4f8a-b3e1-6c2d90f7a512', 'shipped', '1249.00', ''],
  ],
  hasMore: true,
  elapsedMs: 3,
};

function renderTab(overrides: Partial<WorkspaceState> = {}) {
  const openTable = vi.fn();
  const state = {
    sid: 'sid-1',
    session: {} as WorkspaceState['session'],
    connection: { id: 'c1', nickname: 'shop_dev' } as WorkspaceState['connection'],
    readOnly: false,
    visible: true,
    schemaModel: model,
    refreshSchema: async () => {},
    currentSchema: 'public',
    setCurrentSchema: () => {},
    selectedTable: { schema: 'public', name: 'orders' },
    openTable,
    activeTab: 'data',
    setActiveTab: () => {},
    queryDraft: null,
    openInQuery: () => {},
    ...overrides,
  } satisfies WorkspaceState;
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  const wrap = (ui: ReactNode) => (
    <QueryClientProvider client={client}>
      <TooltipProvider>
        <WorkspaceContext.Provider value={state}>{ui}</WorkspaceContext.Provider>
      </TooltipProvider>
    </QueryClientProvider>
  );
  return { ...render(wrap(<DataTab />)), openTable };
}

const cell = (text: string) => screen.getAllByRole('gridcell').find((c) => c.textContent === text)!;
/** Cell texts of the first data row, left to right. */
const firstRow = () =>
  within(screen.getAllByRole('row')[1]!)
    .getAllByRole('gridcell')
    .map((c) => c.textContent);
const uuid1 = '3f1c2a9e-8b7d-4c11-9e2f-0a6b5d4c3e21';

beforeEach(() => {
  resetTableViews();
  mocked.getGridLayout.mockResolvedValue(emptyGridLayout);
  mocked.saveGridLayout.mockResolvedValue(undefined);
  mocked.rows.mockResolvedValue(page);
  mocked.count.mockImplementation(async (_sid, req) =>
    req.exact ? { count: '1204377', exact: true } : { count: '1204380', exact: false },
  );
});
afterEach(() => vi.clearAllMocks());

describe('DataTab', () => {
  it('asks for a table when none is selected', () => {
    renderTab({ selectedTable: null });
    expect(screen.getByText('No table selected')).toBeInTheDocument();
  });

  it('loads the first 200 rows and shows type-aware cells, NULL and the planner estimate', async () => {
    renderTab();
    await screen.findByText('100512');
    expect(mocked.rows).toHaveBeenCalledWith('sid-1', {
      table: { schema: 'public', name: 'orders' },
      limit: 200,
      offset: 0,
      sort: [],
      filters: [],
      where: undefined,
    });
    expect(screen.getByText('NULL')).toBeInTheDocument();
    expect(screen.getByRole('columnheader', { name: /customer_id/ })).toHaveTextContent('uuid → customers');
    expect(await screen.findByText('~1,204,380')).toBeInTheDocument();
    expect(screen.getByLabelText('Page 1 of 6022')).toHaveTextContent('1 / 6,022');
  });

  it('counts exactly on request', async () => {
    const user = userEvent.setup();
    renderTab();
    await user.click(await screen.findByRole('button', { name: 'Count exactly' }));
    expect(await screen.findByText('1,204,377')).toBeInTheDocument();
    expect(screen.getByText('(exact)')).toBeInTheDocument();
  });

  it('sorts on the server when a header is clicked', async () => {
    const user = userEvent.setup();
    renderTab();
    await screen.findByText('100512');
    await user.click(within(screen.getByRole('columnheader', { name: /^total/ })).getByRole('button'));
    await waitFor(() =>
      expect(mocked.rows).toHaveBeenLastCalledWith(
        'sid-1',
        expect.objectContaining({ sort: [{ column: 'total', dir: 'asc' }] }),
      ),
    );
  });

  it('stages an edit, shows the pending SQL and commits all edits in one request', async () => {
    const user = userEvent.setup();
    mocked.applyEdits.mockResolvedValue({ applied: 1, rows: [], columns: [] });
    renderTab();
    await user.dblClick(await screen.findByText('1249.00'));
    const input = screen.getByLabelText('total value');
    await user.clear(input);
    await user.type(input, '1194.00{Enter}');

    expect(cell('1194.00')).toHaveAttribute('title', 'Was 1249.00');
    const sql = screen.getByLabelText('SQL that will run');
    expect(sql).toHaveTextContent(
      `UPDATE "public"."orders" SET "total" = 1194.00::numeric WHERE "id" = 100510; -- was 1249.00`,
    );
    expect(screen.getByText('1 updated')).toBeInTheDocument();
    expect(screen.getByRole('img', { name: 'Changed' })).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: /Commit 1 change/ }));
    expect(mocked.applyEdits).toHaveBeenCalledWith('sid-1', [
      { kind: 'update', table: { schema: 'public', name: 'orders' }, key: { id: '100510' }, set: { total: '1194.00' } },
    ]);
    await waitFor(() => expect(screen.queryByLabelText('Pending changes')).not.toBeInTheDocument());
  });

  it('keeps the stage and names the failing cell when the commit fails', async () => {
    const user = userEvent.setup();
    mocked.applyEdits.mockRejectedValue(
      new ApiError(400, { code: '22003', message: 'numeric field overflow', editIndex: 0, column: 'total' }),
    );
    renderTab();
    await user.dblClick(await screen.findByText('1249.00'));
    const input = screen.getByLabelText('total value');
    await user.clear(input);
    await user.type(input, '99999999999{Enter}');
    await user.click(screen.getByRole('button', { name: /Commit 1 change/ }));

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('Commit failed — nothing was saved');
    expect(alert).toHaveTextContent('Row 100510 · total: 22003 numeric field overflow');
    expect(cell('99999999999')).toHaveAttribute('aria-invalid', 'true');
    expect(screen.getByLabelText('SQL that will run')).toBeInTheDocument();
  });

  it('validates typed values before staging them', async () => {
    const user = userEvent.setup();
    renderTab();
    await user.dblClick(await screen.findByText('1249.00'));
    const input = screen.getByLabelText('total value');
    await user.clear(input);
    await user.type(input, '12,5{Enter}');
    expect(screen.getByText('Enter a number, like 1194.00.')).toBeInTheDocument();
    expect(screen.queryByLabelText('Pending changes')).not.toBeInTheDocument();
  });

  it('adds a new row with DEFAULT cells and deletes rows as staged edits', async () => {
    const user = userEvent.setup();
    renderTab();
    await screen.findByText('100512');
    await user.click(screen.getByRole('button', { name: 'Add row' }));
    expect(screen.getByRole('img', { name: 'New row' })).toBeInTheDocument();
    expect(screen.getAllByRole('gridcell').filter((c) => c.textContent === 'DEFAULT')).toHaveLength(5);

    await user.click(screen.getAllByRole('rowheader')[0]!);
    await user.click(screen.getByRole('button', { name: /^Delete$/ }));
    expect(screen.getByRole('img', { name: 'Deleted' })).toBeInTheDocument();
    expect(screen.getByLabelText('SQL that will run')).toHaveTextContent(
      'DELETE FROM "public"."orders" WHERE "id" = 100512;',
    );
    expect(screen.getByLabelText('SQL that will run')).toHaveTextContent(
      'INSERT INTO "public"."orders" DEFAULT VALUES;',
    );
  });

  it('explains why editing is off on a read-only connection', async () => {
    renderTab({ readOnly: true });
    await screen.findByText('100512');
    expect(screen.getByRole('note')).toHaveTextContent('Read-only connection: editing is off.');
    expect(screen.queryByRole('button', { name: 'Add row' })).not.toBeInTheDocument();
  });

  it('explains what a table without a primary key allows', async () => {
    renderTab({ schemaModel: { ...model, tables: [{ ...orders, primaryKey: [] }, customers] } });
    await screen.findByText('100512');
    expect(screen.getByRole('note')).toHaveTextContent(/No primary key/);
  });

  it('follows a foreign key to the referenced row', async () => {
    const user = userEvent.setup();
    const { openTable } = renderTab();
    await user.click(
      await screen.findByRole('button', { name: 'Open customers 3f1c2a9e-8b7d-4c11-9e2f-0a6b5d4c3e21' }),
    );
    expect(openTable).toHaveBeenCalledWith({ schema: 'public', name: 'customers' }, 'data');
    expect(getTableView('sid-1', 'public.customers').chips).toEqual([
      expect.objectContaining({ column: 'id', op: 'eq', value: '3f1c2a9e-8b7d-4c11-9e2f-0a6b5d4c3e21' }),
    ]);
  });

  it('applies filters from the builder and the raw WHERE box', async () => {
    const user = userEvent.setup();
    renderTab();
    await screen.findByText('100512');
    const where = screen.getByLabelText('WHERE');
    await user.type(where, "note <> ''{Enter}");
    await waitFor(() =>
      expect(mocked.rows).toHaveBeenLastCalledWith('sid-1', expect.objectContaining({ where: "note <> ''" })),
    );
  });
});

describe('DataTab filter chips', () => {
  const chips = [
    { id: 'a', column: 'status', op: 'eq' as const, value: 'paid' },
    { id: 'b', column: 'total', op: 'gt' as const, value: '100' },
    { id: 'c', column: 'note', op: 'isNull' as const, value: '' },
  ];
  beforeEach(() => updateTableView('sid-1', 'public.orders', (s) => ({ ...s, chips })));

  it('opens the builder pre-filled from a chip and applies the change in place', async () => {
    const user = userEvent.setup();
    renderTab();
    await screen.findByText('100512');
    await user.click(screen.getByRole('button', { name: 'Edit filter total greater than 100' }));
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText('Edit filter')).toBeInTheDocument();
    expect(within(dialog).getByLabelText('Column')).toHaveTextContent('total');
    expect(within(dialog).getByLabelText('Operator')).toHaveTextContent('greater than');
    const value = within(dialog).getByLabelText('Value');
    expect(value).toHaveValue('100');
    await user.clear(value);
    await user.type(value, '250');
    await user.click(within(dialog).getByRole('button', { name: 'Apply' }));

    expect(getTableView('sid-1', 'public.orders').chips).toEqual([
      chips[0],
      { id: 'b', column: 'total', op: 'gt', value: '250' },
      chips[2],
    ]);
    await waitFor(() =>
      expect(mocked.rows).toHaveBeenLastCalledWith(
        'sid-1',
        expect.objectContaining({
          filters: [
            { column: 'status', op: 'eq', value: 'paid' },
            { column: 'total', op: 'gt', value: '250' },
            { column: 'note', op: 'isNull' },
          ],
        }),
      ),
    );
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Edit filter total greater than 250' })).toHaveFocus(),
    );
  });

  it('opens from the keyboard and leaves the filter unchanged on Escape, focus back on the chip', async () => {
    const user = userEvent.setup();
    renderTab();
    await screen.findByText('100512');
    const chip = screen.getByRole('button', { name: 'Edit filter status equals paid' });
    chip.focus();
    await user.keyboard('{Enter}');
    const value = await screen.findByLabelText('Value');
    await user.clear(value);
    await user.type(value, 'cancelled');
    await user.keyboard('{Escape}');

    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(getTableView('sid-1', 'public.orders').chips).toEqual(chips);
    await waitFor(() => expect(chip).toHaveFocus());
  });

  it('cancels with the Cancel button and removes from the builder or the chip', async () => {
    const user = userEvent.setup();
    renderTab();
    await screen.findByText('100512');
    await user.click(screen.getByRole('button', { name: 'Edit filter note is null' }));
    await user.click(await screen.findByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(getTableView('sid-1', 'public.orders').chips).toEqual(chips);

    await user.click(screen.getByRole('button', { name: 'Edit filter note is null' }));
    await user.click(await screen.findByRole('button', { name: 'Remove' }));
    expect(getTableView('sid-1', 'public.orders').chips).toEqual([chips[0], chips[1]]);
    await waitFor(() => expect(screen.getByRole('button', { name: 'Add filter' })).toHaveFocus());

    await user.click(screen.getByRole('button', { name: 'Remove filter status equals paid' }));
    expect(getTableView('sid-1', 'public.orders').chips).toEqual([chips[1]]);
  });
});

describe('DataTab on a table without a primary key', () => {
  const noKey: SchemaModel = { ...model, tables: [{ ...orders, primaryKey: [] }, customers] };

  it('adds rows, but neither edits nor deletes existing ones', async () => {
    const user = userEvent.setup();
    mocked.applyEdits.mockResolvedValue({ applied: 1, rows: [], columns: [] });
    renderTab({ schemaModel: noKey });
    await screen.findByText('100512');
    expect(screen.getByRole('note')).toHaveTextContent(
      'No primary key: you can add rows, but not edit or delete existing ones.',
    );

    await user.dblClick(screen.getByText('1249.00'));
    expect(screen.queryByLabelText('total value')).not.toBeInTheDocument();
    await user.click(screen.getAllByRole('rowheader')[0]!);
    expect(screen.getByRole('button', { name: /^Delete$/ })).toBeDisabled();
    await user.keyboard('{Backspace}');
    expect(screen.queryByRole('img', { name: 'Deleted' })).not.toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Add row' }));
    expect(screen.getByRole('img', { name: 'New row' })).toBeInTheDocument();
    const defaults = screen.getAllByRole('gridcell').filter((c) => c.textContent === 'DEFAULT');
    expect(defaults).toHaveLength(5);
    await user.dblClick(defaults[3]!);
    await user.type(screen.getByLabelText('total value'), '12.50{Enter}');
    expect(screen.getByLabelText('SQL that will run')).toHaveTextContent('INSERT INTO "public"."orders" ("total")');

    // The new row can be taken back out before committing.
    await user.click(screen.getAllByRole('rowheader')[2]!);
    expect(screen.getByRole('button', { name: /^Delete$/ })).toBeEnabled();

    await user.click(screen.getByRole('button', { name: /Commit 1 change/ }));
    expect(mocked.applyEdits).toHaveBeenCalledWith('sid-1', [
      { kind: 'insert', table: { schema: 'public', name: 'orders' }, values: { total: '12.50' } },
    ]);
  });

  it('keeps views read-only', async () => {
    renderTab({ selectedTable: { schema: 'public', name: 'order_totals' } });
    await screen.findByText('100512');
    expect(screen.getByRole('note')).toHaveTextContent('Views are read-only here; edit the base table.');
    expect(screen.queryByRole('button', { name: 'Add row' })).not.toBeInTheDocument();
  });
});

describe('DataTab column layout', () => {
  const widths100 = { id: 100, customer_id: 100, status: 100, total: 100, note: 100 };

  it('holds the grid until the remembered layout loads, then draws its order and widths', async () => {
    let resolve!: (layout: GridLayout) => void;
    mocked.getGridLayout.mockReturnValue(new Promise((r) => (resolve = r)));
    renderTab();
    await waitFor(() => expect(mocked.rows).toHaveBeenCalled());
    await new Promise((r) => setTimeout(r, 20));
    expect(screen.queryByRole('grid')).not.toBeInTheDocument();
    expect(mocked.getGridLayout).toHaveBeenCalledWith('c1', 'public', 'orders');

    resolve({ order: ['total', 'dropped_column', 'status'], widths: { note: 333, dropped_column: 90 } });
    await screen.findByText('100512');
    expect(firstRow()).toEqual(['129.90', 'paid', '100512', uuid1, 'NULL']);
    const headers = screen.getAllByRole('columnheader').slice(1);
    expect(headers[0]).toHaveAccessibleName(/^total/);
    expect(headers[1]).toHaveAccessibleName(/^status/);
    expect(screen.getByRole('columnheader', { name: /^note/ })).toHaveStyle({ width: '333px' });
  });

  it('draws the natural layout when the remembered one is slow to come', async () => {
    mocked.getGridLayout.mockReturnValue(new Promise(() => {}));
    renderTab();
    await screen.findByText('100512', undefined, { timeout: 2000 });
    expect(firstRow()).toEqual(['100512', uuid1, 'paid', '129.90', 'NULL']);
  });

  it('moves the focused column with ⌥→, saves once after a pause, and edits still reach the right column', async () => {
    const user = userEvent.setup();
    renderTab();
    await user.click(await screen.findByText('100512'));
    await user.keyboard('{Alt>}{ArrowRight}{ArrowRight}{/Alt}');

    expect(firstRow()).toEqual([uuid1, 'paid', '100512', '129.90', 'NULL']);
    expect(screen.getByText('Moved id to column 3 of 5.')).toBeInTheDocument();
    expect(screen.getByRole('grid')).toHaveAttribute('aria-activedescendant', cell('100512').id);
    expect(mocked.saveGridLayout).not.toHaveBeenCalled();
    await waitFor(() => expect(mocked.saveGridLayout).toHaveBeenCalled(), { timeout: 2000 });
    expect(mocked.saveGridLayout).toHaveBeenCalledTimes(1);
    expect(mocked.saveGridLayout).toHaveBeenCalledWith('c1', 'public', 'orders', {
      order: ['customer_id', 'status', 'id', 'total', 'note'],
      widths: {},
    });

    await user.dblClick(screen.getByText('1249.00'));
    const input = screen.getByLabelText('total value');
    await user.clear(input);
    await user.type(input, '1194.00{Enter}');
    expect(screen.getByLabelText('SQL that will run')).toHaveTextContent(
      `UPDATE "public"."orders" SET "total" = 1194.00::numeric WHERE "id" = 100510; -- was 1249.00`,
    );
  });

  it('reorders by dragging a header, with a drop indicator, without sorting', async () => {
    mocked.getGridLayout.mockResolvedValue({ order: [], widths: widths100 });
    renderTab();
    await screen.findByText('100512');
    const grid = screen.getByRole('grid');
    const idHeader = screen.getByRole('columnheader', { name: /^Primary keyid/ });
    // Gutter 55 px, then five 100 px columns: boundaries at 55, 155, 255, 355, 455, 555.
    fireEvent.pointerDown(idHeader, { pointerId: 1, button: 0, clientX: 100 });
    fireEvent.pointerMove(grid, { pointerId: 1, clientX: 340 });
    expect(grid.querySelector('[data-drop-indicator]')).toHaveStyle({ left: '354px' });
    fireEvent.pointerUp(grid, { pointerId: 1, clientX: 340 });
    fireEvent.click(within(idHeader).getByRole('button'));

    expect(grid.querySelector('[data-drop-indicator]')).toBeNull();
    expect(firstRow()).toEqual([uuid1, 'paid', '100512', '129.90', 'NULL']);
    expect(mocked.rows).not.toHaveBeenCalledWith(
      'sid-1',
      expect.objectContaining({ sort: [{ column: 'id', dir: 'asc' }] }),
    );
    await waitFor(() =>
      expect(mocked.saveGridLayout).toHaveBeenCalledWith('c1', 'public', 'orders', {
        order: ['customer_id', 'status', 'id', 'total', 'note'],
        widths: widths100,
      }),
    );
  });

  it('resets columns from the header menu and saves the empty layout', async () => {
    const user = userEvent.setup();
    mocked.getGridLayout.mockResolvedValue({ order: ['note'], widths: { total: 300 } });
    renderTab();
    await screen.findByText('100512');
    expect(firstRow()[0]).toBe('NULL');

    fireEvent.contextMenu(screen.getByRole('columnheader', { name: /^status/ }));
    const menu = await screen.findByRole('menu');
    expect(within(menu).getByRole('menuitem', { name: /Move column left/ })).toBeInTheDocument();
    await user.click(within(menu).getByRole('menuitem', { name: 'Reset columns' }));

    expect(firstRow()).toEqual(['100512', uuid1, 'paid', '129.90', 'NULL']);
    expect(screen.getByRole('columnheader', { name: /^total/ })).not.toHaveStyle({ width: '300px' });
    await waitFor(() => expect(mocked.saveGridLayout).toHaveBeenCalledWith('c1', 'public', 'orders', emptyGridLayout));
  });

  it('remembers a resized width when the drag ends', async () => {
    mocked.getGridLayout.mockResolvedValue({ order: [], widths: widths100 });
    renderTab();
    await screen.findByText('100512');
    const handle = screen.getByRole('separator', { name: 'Resize total' });
    fireEvent.pointerDown(handle, { pointerId: 2, button: 0, clientX: 455 });
    fireEvent.pointerMove(handle, { pointerId: 2, clientX: 535 });
    expect(screen.getByRole('columnheader', { name: /^total/ })).toHaveStyle({ width: '180px' });
    expect(mocked.saveGridLayout).not.toHaveBeenCalled();
    fireEvent.pointerUp(handle, { pointerId: 2, clientX: 535 });
    await waitFor(() =>
      expect(mocked.saveGridLayout).toHaveBeenCalledWith('c1', 'public', 'orders', {
        order: [],
        widths: { ...widths100, total: 180 },
      }),
    );
  });
});
