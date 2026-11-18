import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ReactNode } from 'react';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Column, RowsPage, SchemaModel, Table } from '@kleos/shared';
import { TooltipProvider } from '@/components/ui/tooltip';
import { WorkspaceContext, type WorkspaceState } from '@/features/workspace/context';
import type * as apiModule from '@/lib/api';
import { api, ApiError } from '@/lib/api';
import { DataTab } from './data-tab';
import { getTableView, resetTableViews } from './table-state';

vi.mock('@/lib/api', async (importOriginal) => {
  const actual = await importOriginal<typeof apiModule>();
  return { ...actual, api: { rows: vi.fn(), count: vi.fn(), applyEdits: vi.fn() } };
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

beforeEach(() => {
  resetTableViews();
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

  it('explains why a table without a primary key is read-only', async () => {
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
