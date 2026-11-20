import { EditorView } from '@codemirror/view';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { QueryStarted, SavedQuery } from '@kleos/shared';
import { TooltipProvider } from '@/components/ui/tooltip';
import { WorkspaceContext, type WorkspaceState } from '@/features/workspace/context';
import type * as apiModule from '@/lib/api';
import { api, ApiError } from '@/lib/api';
import { QueryTab } from './query-tab';
import { getQueryWorkspace, getTab, openSavedQuery, requestTabAction, resetQueryWorkspaces, updateTab } from './store';

/** Run all, parameters, the formatter and the ⌘K actions, in the Query tab. */

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
const toastMock = vi.hoisted(() => {
  const fn = vi.fn() as ReturnType<typeof vi.fn> & Record<'success' | 'error', ReturnType<typeof vi.fn>>;
  fn.success = vi.fn();
  fn.error = vi.fn();
  return fn;
});
vi.mock('sonner', () => ({ toast: toastMock }));
const mocked = vi.mocked(api);

const sizes = { clientWidth: 1400, clientHeight: 800 };
const savedSizes: Partial<Record<keyof typeof sizes, PropertyDescriptor | undefined>> = {};
beforeAll(() => {
  // CodeMirror measures text ranges; jsdom lacks these.
  const empty = () => ({ length: 0, item: () => null, [Symbol.iterator]: [][Symbol.iterator] });
  Range.prototype.getClientRects ??= empty as unknown as Range['getClientRects'];
  Range.prototype.getBoundingClientRect ??= () => new DOMRect();
  for (const [k, v] of Object.entries(sizes) as [keyof typeof sizes, number][]) {
    savedSizes[k] = Object.getOwnPropertyDescriptor(HTMLElement.prototype, k);
    Object.defineProperty(HTMLElement.prototype, k, { configurable: true, get: () => v });
  }
});
afterAll(() => {
  for (const k of Object.keys(sizes) as (keyof typeof sizes)[]) {
    if (savedSizes[k]) Object.defineProperty(HTMLElement.prototype, k, savedSizes[k]);
  }
});

const sid = 'sid-power';

function renderTab() {
  const state = {
    sid,
    session: {} as WorkspaceState['session'],
    connection: { id: 'c1', nickname: 'shop_dev' } as WorkspaceState['connection'],
    readOnly: false,
    visible: true,
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

const activeTab = () => {
  const ws = getQueryWorkspace(sid);
  return ws.tabs.find((t) => t.id === ws.activeId)!;
};
function setSql(sql: string) {
  const tab = activeTab();
  updateTab(sid, tab.id, (t) => ({ ...t, sql }));
  return tab.id;
}
const editorView = (container: HTMLElement) => EditorView.findFromDOM(container.querySelector('.cm-editor')!)!;

const col = { name: 'n', type: 'integer', typeName: 'int4', typeOid: 23, typeCategory: 'N' };
const started = (over: Partial<QueryStarted> = {}): QueryStarted => ({
  qid: 'x',
  columns: [],
  rows: [],
  hasMore: false,
  command: 'INSERT 0 1',
  rowCount: 1,
  elapsedMs: 2,
  ...over,
});
const sentSql = () => mocked.startQuery.mock.calls.map(([, req]) => req.sql);

beforeEach(() => {
  resetQueryWorkspaces();
  mocked.history.mockResolvedValue([]);
  mocked.savedQueries.mockResolvedValue([]);
  mocked.closeTab.mockResolvedValue(undefined);
  mocked.closeQuery.mockResolvedValue(undefined);
  mocked.cancelQuery.mockResolvedValue(undefined);
});
afterEach(() => vi.clearAllMocks());

describe('Run all', () => {
  const script = 'begin;\ninsert into t values (1);\nselect n from t;\ncommit;';

  it('runs every statement and lists them with their outcome; picking one shows its result', async () => {
    const user = userEvent.setup();
    setSql(script);
    mocked.startQuery
      .mockResolvedValueOnce(started({ command: 'BEGIN', rowCount: null }))
      .mockResolvedValueOnce(started())
      .mockResolvedValueOnce(started({ columns: [col], rows: [['7001']], command: null }))
      .mockResolvedValueOnce(started({ command: 'COMMIT', rowCount: null, elapsedMs: 1 }));
    renderTab();
    await user.click(screen.getByRole('button', { name: 'Run all' }));

    expect(await screen.findByText('4 statements')).toBeInTheDocument();
    expect(sentSql()).toEqual(['begin', 'insert into t values (1)', 'select n from t', 'commit']);
    const list = screen.getByRole('listbox', { name: 'Statements' });
    const options = within(list).getAllByRole('option');
    expect(options.map((o) => o.textContent)).toEqual([
      '1begin' + 'BEGIN' + '2.0 ms',
      '2insert into t values (1)' + 'INSERT 0 1' + '2.0 ms',
      '3select n from t' + '1 row' + '2.0 ms',
      '4commit' + 'COMMIT' + '1.0 ms',
    ]);
    // The last statement's result is shown; picking another shows its own.
    expect(options[3]).toHaveAttribute('aria-selected', 'true');
    await user.click(options[2]!);
    expect(await screen.findByText('7001')).toBeInTheDocument();
    expect(options[2]).toHaveAttribute('aria-selected', 'true');
    // ↑ moves to the statement before.
    list.focus();
    await user.keyboard('{ArrowUp}');
    expect(options[1]).toHaveAttribute('aria-selected', 'true');
    // Each statement was recorded in History by the server: the panel refreshes after each one.
    await waitFor(() => expect(mocked.history.mock.calls.length).toBeGreaterThanOrEqual(5));
  });

  it('stops at the first error, naming the statement and its line, and marks it in the editor', async () => {
    const user = userEvent.setup();
    setSql(script);
    mocked.startQuery
      .mockResolvedValueOnce(started({ command: 'BEGIN', rowCount: null }))
      .mockRejectedValueOnce(
        new ApiError(400, { code: '42P01', message: 'relation "t" does not exist', position: 13 }),
      );
    const { container } = renderTab();
    await user.click(screen.getByRole('button', { name: 'Run all' }));

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('42P01 relation "t" does not exist');
    expect(alert).toHaveTextContent('Statement 2 of 4 · line 2, column 13');
    expect(screen.getByText('Statement 2 of 4 failed')).toBeInTheDocument();
    expect(mocked.startQuery).toHaveBeenCalledTimes(2);
    const options = screen.getAllByRole('option');
    expect(options[1]).toHaveAttribute('aria-selected', 'true');
    expect(options[1]).toHaveTextContent('42P01');
    expect(options[2]).toHaveTextContent('Not run');
    await waitFor(() => expect(container.querySelector('.cm-lintRange-error')).toHaveTextContent(/^t$/));
  });

  it('marks the failing statement’s first line when the error has no position', async () => {
    const user = userEvent.setup();
    setSql('select 1;\n-- the insert\ninsert into t\n  values (1);');
    mocked.startQuery
      .mockResolvedValueOnce(started({ command: 'SELECT 1' }))
      .mockRejectedValueOnce(new ApiError(400, { code: '23505', message: 'duplicate key value' }));
    const { container } = renderTab();
    await user.click(screen.getByRole('button', { name: 'Run all' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Statement 2 of 2 · line 3');
    // Syntax colors split the underline into several elements.
    const underlined = () => [...container.querySelectorAll('.cm-lintRange-error')].map((e) => e.textContent).join('');
    await waitFor(() => expect(underlined()).toBe('insert into t'));
  });

  it('shows its progress and cancels the running statement, stopping there', async () => {
    const user = userEvent.setup();
    setSql(script);
    let reject!: (err: unknown) => void;
    mocked.startQuery
      .mockResolvedValueOnce(started({ command: 'BEGIN', rowCount: null }))
      .mockReturnValueOnce(new Promise((_, r) => (reject = r)));
    renderTab();
    await user.click(screen.getByRole('button', { name: 'Run all' }));
    expect(await screen.findByText('Statement 2 of 4…')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Run all' })).toBeDisabled();

    await user.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(mocked.cancelQuery).toHaveBeenCalledWith(sid, mocked.startQuery.mock.calls[1]![1].qid);
    await act(async () => reject(new ApiError(400, { code: '57014', message: 'canceling statement' })));
    expect(await screen.findByText(/Cancelled at statement 2 of 4/)).toBeInTheDocument();
    expect(mocked.startQuery).toHaveBeenCalledTimes(2);
  });

  it('runs with ⇧⌘↵ from the editor', async () => {
    setSql('select 1; select 2');
    mocked.startQuery.mockResolvedValue(started({ command: 'SELECT 1' }));
    const { container } = renderTab();
    const content = container.querySelector('.cm-content')!;
    fireEvent.keyDown(content, { key: 'Enter', code: 'Enter', keyCode: 13, shiftKey: true, ctrlKey: true });
    await waitFor(() => expect(sentSql()).toEqual(['select 1', 'select 2']));
  });
});

describe('parameters', () => {
  const sql = 'select * from orders where customer_id = :customer and total > $1';

  it('asks for the values, sends them as bind parameters and offers them again', async () => {
    const user = userEvent.setup();
    const tabId = setSql(sql);
    mocked.startQuery.mockResolvedValue(started({ columns: [col], rows: [['1']], command: null }));
    renderTab();
    await user.click(screen.getByRole('button', { name: /^Run(?! all)/ }));

    const dialog = await screen.findByRole('dialog', { name: 'Parameters' });
    expect(within(dialog).getByText(/2 parameters/)).toBeInTheDocument();
    const first = within(dialog).getByLabelText('$1');
    expect(first).toHaveFocus();
    await user.type(first, '100');
    await user.type(within(dialog).getByLabelText(':customer'), 'ignored');
    await user.click(within(dialog).getByRole('button', { name: 'NULL for :customer' }));
    expect(within(dialog).getByLabelText(':customer')).toBeDisabled();
    await user.click(first);
    await user.keyboard('{Enter}');

    await waitFor(() =>
      expect(mocked.startQuery).toHaveBeenCalledWith(
        sid,
        expect.objectContaining({
          sql: 'select * from orders where customer_id = $2 and total > $1',
          params: ['100', null],
        }),
      ),
    );
    expect(getTab(sid, tabId)!.paramValues).toEqual({ $1: '100', ':customer': null });

    // Next time, the dialog starts from the values used last.
    await screen.findByText('1 row');
    await user.click(screen.getByRole('button', { name: /^Run(?! all)/ }));
    const again = await screen.findByRole('dialog', { name: 'Parameters' });
    expect(within(again).getByLabelText('$1')).toHaveValue('100');
    expect(within(again).getByRole('button', { name: 'NULL for :customer' })).toHaveAttribute('aria-pressed', 'true');
    // Esc cancels: nothing runs.
    await user.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(mocked.startQuery).toHaveBeenCalledTimes(1);
  });

  it('prompts once for a whole script and passes each statement its own values', async () => {
    const user = userEvent.setup();
    setSql('delete from t where d < :day;\nselect 1;\ninsert into log values (:day, :who);');
    mocked.startQuery.mockResolvedValue(started());
    renderTab();
    await user.click(screen.getByRole('button', { name: 'Run all' }));
    const dialog = await screen.findByRole('dialog', { name: 'Parameters' });
    expect(within(dialog).getByText(/2 parameters across 3 statements/)).toBeInTheDocument();
    await user.type(within(dialog).getByLabelText(':day'), '2026-11-01');
    await user.type(within(dialog).getByLabelText(':who'), 'ada{Enter}');
    await waitFor(() => expect(mocked.startQuery).toHaveBeenCalledTimes(3));
    expect(mocked.startQuery.mock.calls.map(([, req]) => [req.sql, req.params])).toEqual([
      ['delete from t where d < $1', ['2026-11-01']],
      ['select 1', undefined],
      ['insert into log values ($1, $2)', ['2026-11-01', 'ada']],
    ]);
  });

  it('remembers the values on the saved query after a successful run', async () => {
    const user = userEvent.setup();
    const saved: SavedQuery = {
      id: 'q1',
      connectionId: 'c1',
      name: 'Big orders',
      sql,
      chart: null,
      paramValues: { $1: '50', ':customer': '42' },
      createdAt: '2026-11-18T10:00:00Z',
      updatedAt: '2026-11-18T10:00:00Z',
    };
    mocked.savedQueries.mockResolvedValue([saved]);
    mocked.updateSavedQuery.mockImplementation(async (_id, input) => ({ ...saved, ...input }));
    mocked.startQuery.mockResolvedValue(started({ columns: [col], rows: [], command: null }));
    openSavedQuery(sid, saved);
    // An unsaved edit in the tab must not reach the saved query.
    updateTab(sid, activeTab().id, (t) => ({ ...t, sql: `${sql} -- edited` }));
    renderTab();
    await user.click(screen.getByRole('button', { name: /^Run(?! all)/ }));
    const dialog = await screen.findByRole('dialog', { name: 'Parameters' });
    const first = within(dialog).getByLabelText('$1');
    expect(first).toHaveValue('50');
    expect(within(dialog).getByLabelText(':customer')).toHaveValue('42');
    await user.clear(first);
    await user.type(first, '75{Enter}');
    await waitFor(() =>
      expect(mocked.updateSavedQuery).toHaveBeenCalledWith('q1', {
        connectionId: 'c1',
        name: 'Big orders',
        sql,
        chart: null,
        paramValues: { $1: '75', ':customer': '42' },
      }),
    );
  });
});

describe('Format SQL', () => {
  it('formats the whole editor in one undo step', async () => {
    const user = userEvent.setup();
    const tabId = setSql('SELECT id FROM orders WHERE id = :id');
    const { container } = renderTab();
    await user.click(screen.getByRole('button', { name: 'Format SQL' }));
    expect(getTab(sid, tabId)!.sql).toBe('select\n  id\nfrom\n  orders\nwhere\n  id = :id');
    expect(container.querySelector('.cm-content')).toHaveFocus();
    await user.keyboard('{Control>}z{/Control}');
    expect(getTab(sid, tabId)!.sql).toBe('SELECT id FROM orders WHERE id = :id');
  });

  it('formats only the selection with ⇧⌥F', async () => {
    const tabId = setSql('select 1;\nSELECT a FROM t;');
    const { container } = renderTab();
    const view = editorView(container);
    act(() => view.dispatch({ selection: { anchor: 10, head: 25 } }));
    fireEvent.keyDown(container.querySelector('.cm-content')!, {
      key: 'Ï',
      code: 'KeyF',
      shiftKey: true,
      altKey: true,
    });
    expect(getTab(sid, tabId)!.sql).toBe('select 1;\nselect\n  a\nfrom\n  t;');
  });

  it('changes nothing and says so calmly when the SQL does not parse', async () => {
    const user = userEvent.setup();
    const tabId = setSql("select 'open");
    renderTab();
    await user.click(screen.getByRole('button', { name: 'Format SQL' }));
    expect(getTab(sid, tabId)!.sql).toBe("select 'open");
    expect(toastMock).toHaveBeenCalledWith(
      'Couldn’t format: the SQL doesn’t parse near line 1, column 8. Nothing changed.',
    );
  });
});

describe('actions from ⌘K', () => {
  it('reruns a saved query through the parameter prompt prefilled with its values: Enter runs it', async () => {
    const user = userEvent.setup();
    const saved: SavedQuery = {
      id: 'q2',
      connectionId: 'c1',
      name: 'By customer',
      sql: 'select * from orders where customer_id = :customer and day = :day',
      chart: null,
      paramValues: { ':customer': '42', ':day': '2026-11-20' },
      createdAt: '2026-11-18T10:00:00Z',
      updatedAt: '2026-11-18T10:00:00Z',
    };
    mocked.savedQueries.mockResolvedValue([saved]);
    mocked.startQuery.mockResolvedValue(started({ columns: [col], rows: [], command: null }));
    requestTabAction(sid, openSavedQuery(sid, saved), { kind: 'run' });
    renderTab();
    const dialog = await screen.findByRole('dialog', { name: 'Parameters' });
    expect(within(dialog).getByLabelText(':customer')).toHaveFocus();
    await user.keyboard('{Enter}');
    await waitFor(() =>
      expect(mocked.startQuery).toHaveBeenCalledWith(
        sid,
        expect.objectContaining({
          sql: 'select * from orders where customer_id = $1 and day = $2',
          params: ['42', '2026-11-20'],
        }),
      ),
    );
    // Unchanged values are not written back.
    expect(mocked.updateSavedQuery).not.toHaveBeenCalled();
    expect(activeTab().pending).toBeNull();
  });

  it('runs a saved query without parameters at once, all of its statements', async () => {
    mocked.startQuery.mockResolvedValue(started({ command: 'SELECT 1' }));
    const saved: SavedQuery = {
      id: 'q3',
      connectionId: 'c1',
      name: 'Two',
      sql: 'select 1;\nselect 2;',
      chart: null,
      createdAt: '2026-11-18T10:00:00Z',
      updatedAt: '2026-11-18T10:00:00Z',
    };
    requestTabAction(sid, openSavedQuery(sid, saved), { kind: 'run' });
    renderTab();
    await waitFor(() => expect(sentSql()).toEqual(['select 1', 'select 2']));
  });

  it('inserts SQL at the cursor of the active tab, selecting nothing, and focuses the editor', async () => {
    const tabId = setSql('select  from orders');
    const { container } = renderTab();
    const view = editorView(container);
    act(() => view.dispatch({ selection: { anchor: 7 } }));
    act(() => requestTabAction(sid, tabId, { kind: 'insert', text: 'id, total' }));
    await waitFor(() => expect(getTab(sid, tabId)!.sql).toBe('select id, total from orders'));
    expect(view.state.selection.main.empty).toBe(true);
    expect(view.state.selection.main.head).toBe(16);
    expect(container.querySelector('.cm-content')).toHaveFocus();
    expect(getTab(sid, tabId)!.pending).toBeNull();
  });
});
