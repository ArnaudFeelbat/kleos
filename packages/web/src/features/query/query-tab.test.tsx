import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { TooltipProvider } from '@/components/ui/tooltip';
import { WorkspaceContext, type WorkspaceState } from '@/features/workspace/context';
import type * as apiModule from '@/lib/api';
import { api, ApiError } from '@/lib/api';
import { QueryTab } from './query-tab';
import { getQueryWorkspace, resetQueryWorkspaces, updateTab } from './store';

vi.mock('@/lib/api', async (importOriginal) => {
  const actual = await importOriginal<typeof apiModule>();
  return {
    ...actual,
    api: {
      startQuery: vi.fn(),
      nextPage: vi.fn(),
      cancelQuery: vi.fn(),
      closeQuery: vi.fn(),
      closeTab: vi.fn(),
      explain: vi.fn(),
      history: vi.fn(),
      savedQueries: vi.fn(),
      createSavedQuery: vi.fn(),
      updateSavedQuery: vi.fn(),
      deleteSavedQuery: vi.fn(),
    },
  };
});
const mocked = vi.mocked(api);

const sizes = { clientWidth: 1400, clientHeight: 800 };
const saved: Partial<Record<keyof typeof sizes, PropertyDescriptor | undefined>> = {};
beforeAll(() => {
  // CodeMirror measures text ranges; jsdom lacks these.
  const empty = () => ({ length: 0, item: () => null, [Symbol.iterator]: [][Symbol.iterator] });
  Range.prototype.getClientRects ??= empty as unknown as Range['getClientRects'];
  Range.prototype.getBoundingClientRect ??= () => new DOMRect();
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

const sid = 'sid-q';

function renderTab(overrides: Partial<WorkspaceState> = {}) {
  const state = {
    sid,
    session: {} as WorkspaceState['session'],
    connection: { id: 'c1', nickname: 'shop_dev' } as WorkspaceState['connection'],
    readOnly: false,
    schemaModel: undefined,
    refreshSchema: async () => {},
    currentSchema: 'public',
    setCurrentSchema: () => {},
    selectedTable: null,
    openTable: () => {},
    activeTab: 'query',
    setActiveTab: () => {},
    queryDraft: null,
    openInQuery: () => {},
    ...overrides,
  } satisfies WorkspaceState;
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <TooltipProvider>
        <WorkspaceContext.Provider value={state}>
          <QueryTab />
        </WorkspaceContext.Provider>
      </TooltipProvider>
    </QueryClientProvider>,
  );
}

function setSql(sql: string) {
  const tab = getQueryWorkspace(sid).tabs[0]!;
  updateTab(sid, tab.id, (t) => ({ ...t, sql }));
  return tab.id;
}

beforeEach(() => {
  resetQueryWorkspaces();
  mocked.history.mockResolvedValue([]);
  mocked.savedQueries.mockResolvedValue([]);
  mocked.closeTab.mockResolvedValue(undefined);
  mocked.closeQuery.mockResolvedValue(undefined);
  mocked.cancelQuery.mockResolvedValue(undefined);
});
afterEach(() => vi.clearAllMocks());

describe('QueryTab', () => {
  it('runs the statement under the cursor and shows rows with count and timing', async () => {
    const user = userEvent.setup();
    const tabId = setSql('select 1 as n;\nselect 2;');
    mocked.startQuery.mockResolvedValue({
      qid: 'q',
      columns: [{ name: 'n', type: 'integer', typeName: 'int4', typeOid: 23, typeCategory: 'N' }],
      rows: [['1']],
      hasMore: false,
      command: null,
      rowCount: 1,
      elapsedMs: 4,
    });
    renderTab();
    await user.click(screen.getByRole('button', { name: /^Run/ }));
    expect(mocked.startQuery).toHaveBeenCalledWith(
      sid,
      expect.objectContaining({ sql: 'select 1 as n', tabId, pageSize: 500, qid: expect.any(String) }),
    );
    expect(await screen.findByText('1 row')).toBeInTheDocument();
    expect(screen.getByText(/4\.0 ms · statement on line 1/)).toBeInTheDocument();
    expect(screen.getAllByRole('gridcell').map((c) => c.textContent)).toEqual(['1']);
    await waitFor(() => expect(mocked.history).toHaveBeenCalledTimes(2));
  });

  it('shows the command tag for statements without rows', async () => {
    const user = userEvent.setup();
    setSql("update orders set status = 'paid' where id = 3");
    mocked.startQuery.mockResolvedValue({
      qid: 'q',
      columns: [],
      rows: [],
      hasMore: false,
      command: 'UPDATE 3',
      rowCount: 3,
      elapsedMs: 2,
    });
    renderTab();
    await user.click(screen.getByRole('button', { name: /^Run/ }));
    expect((await screen.findAllByText('UPDATE 3')).length).toBeGreaterThan(0);
  });

  it('shows code, message, hint and the line and column of an error, and underlines the token', async () => {
    const user = userEvent.setup();
    setSql('select o.stauts, count(*)\nfrom orders o group by 1');
    mocked.startQuery.mockRejectedValue(
      new ApiError(400, {
        code: '42703',
        message: 'column o.stauts does not exist',
        position: 8,
        hint: 'Perhaps you meant to reference the column "o.status".',
      }),
    );
    const { container } = renderTab();
    await user.click(screen.getByRole('button', { name: /^Run/ }));
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('42703 column o.stauts does not exist');
    expect(alert).toHaveTextContent('Line 1, column 8');
    expect(alert).toHaveTextContent('Hint: Perhaps you meant');
    await waitFor(() => expect(container.querySelector('.cm-lintRange-error')).toHaveTextContent('o.stauts'));
  });

  it('presents read-only refusals from the session clearly', async () => {
    const user = userEvent.setup();
    setSql('delete from orders');
    mocked.startQuery.mockRejectedValue(
      new ApiError(400, { code: '25006', message: 'cannot execute DELETE in a read-only transaction' }),
    );
    renderTab({ readOnly: true });
    await user.click(screen.getByRole('button', { name: /^Run/ }));
    expect(await screen.findByRole('alert')).toHaveTextContent('This connection is read-only');
  });

  it('enables Cancel while running and cancels by the qid sent with the query', async () => {
    const user = userEvent.setup();
    setSql('select pg_sleep(60)');
    mocked.startQuery.mockReturnValue(new Promise(() => {}));
    renderTab();
    const cancel = screen.getByRole('button', { name: 'Cancel' });
    expect(cancel).toBeDisabled();
    await user.click(screen.getByRole('button', { name: /^Run/ }));
    await waitFor(() => expect(cancel).toBeEnabled());
    await user.click(cancel);
    const qid = mocked.startQuery.mock.calls[0]![1].qid;
    expect(mocked.cancelQuery).toHaveBeenCalledWith(sid, qid);
  });

  it('adds and closes query tabs, releasing the server tab', async () => {
    const user = userEvent.setup();
    renderTab();
    await user.click(screen.getByRole('button', { name: 'New query tab' }));
    expect(screen.getAllByRole('tab', { name: /Query \d/ })).toHaveLength(2);
    const second = getQueryWorkspace(sid).tabs[1]!.id;
    await user.click(screen.getByRole('button', { name: 'Close Query 2' }));
    expect(mocked.closeTab).toHaveBeenCalledWith(sid, second);
    expect(screen.getAllByRole('tab', { name: /Query \d/ })).toHaveLength(1);
  });

  it('opens a query handed over from elsewhere', async () => {
    renderTab({ queryDraft: { sql: 'select * from "public"."orders"', nonce: 1 } });
    await waitFor(() => expect(getQueryWorkspace(sid).tabs[0]!.sql).toBe('select * from "public"."orders"'));
  });

  it('charts loaded rows with numeric columns preselected and saves the query with its chart', async () => {
    const user = userEvent.setup();
    const tabId = setSql('select day, web, ios from revenue');
    const meta = (name: string, typeName: string, typeCategory: string) => ({
      name,
      type: typeName,
      typeName,
      typeOid: 0,
      typeCategory,
    });
    mocked.startQuery.mockResolvedValue({
      qid: 'q',
      columns: [meta('day', 'date', 'D'), meta('web', 'numeric', 'N'), meta('ios', 'numeric', 'N')],
      rows: [
        ['2026-11-16', '24339.10', '12207.00'],
        ['2026-11-17', '25258.00', '14365.50'],
      ],
      hasMore: false,
      command: null,
      rowCount: 2,
      elapsedMs: 9,
    });
    mocked.createSavedQuery.mockImplementation(async (input) => ({
      ...input,
      id: 'saved-1',
      createdAt: '2026-11-18T10:00:00Z',
      updatedAt: '2026-11-18T10:00:00Z',
    }));
    renderTab();
    await user.click(screen.getByRole('button', { name: /^Run/ }));
    await screen.findByText('2 rows');
    await user.click(screen.getByRole('tab', { name: 'Chart' }));
    expect(screen.getByRole('button', { name: 'Remove web' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Remove ios' })).toBeInTheDocument();
    expect(screen.getByLabelText('Legend')).toHaveTextContent('webios');
    expect(screen.getByText(/From the 2 rows already loaded/)).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'View as table' }));
    expect(screen.getByRole('grid', { name: 'Chart data' })).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: /Save chart/ }));
    const name = await screen.findByLabelText('Name');
    await user.clear(name);
    await user.type(name, 'revenue by channel{Enter}');
    await waitFor(() =>
      expect(mocked.createSavedQuery).toHaveBeenCalledWith({
        connectionId: 'c1',
        name: 'revenue by channel',
        sql: 'select day, web, ios from revenue',
        chart: { type: 'line', x: 'day', y: ['web', 'ios'] },
      }),
    );
    await waitFor(() =>
      expect(getQueryWorkspace(sid).tabs.find((t) => t.id === tabId)!.title).toBe('revenue by channel'),
    );
  });

  it('shows the explain plan with the hottest node flagged', async () => {
    const user = userEvent.setup();
    setSql('select * from orders');
    mocked.explain.mockResolvedValue({
      plan: {
        'Node Type': 'Seq Scan',
        'Relation Name': 'orders',
        Alias: 'orders',
        'Actual Total Time': 12,
        'Actual Rows': 100,
        'Plan Rows': 90,
        'Actual Loops': 1,
      },
      planningMs: 0.4,
      executionMs: 12.5,
    });
    renderTab();
    await user.click(screen.getByRole('button', { name: /^Explain/ }));
    expect(await screen.findByText('Most self time')).toBeInTheDocument();
    expect(screen.getByText('EXPLAIN (ANALYZE, FORMAT JSON)')).toBeInTheDocument();
    expect(screen.getByRole('complementary', { name: 'Node details' })).toHaveTextContent('Seq Scan');
  });
});
