import { EditorView } from '@codemirror/view';
import {
  emptyGridLayout,
  emptyWindowState,
  kleosErrorCodes,
  type ColumnMeta,
  type HistoryEntry,
  type SavedConnection,
  type SavedQuery,
  type SchemaModel,
  type SessionInfo,
  type Snippet,
  type StatsKind,
  type StatsResult,
} from '@kleos/shared';
import { useQuery, type QueryClient } from '@tanstack/react-query';
import { act, cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { useConnectActions } from '@/features/connections/connect-context';
import { resetTableViews } from '@/features/data/table-state';
import { resetHistorySearchRequests } from '@/features/history/search-request';
import { getQueryWorkspace, peekQueryWorkspace, resetQueryWorkspaces } from '@/features/query/store';
import { col, table } from '@/features/schema/test-fixtures';
import { useWorkspace } from '@/features/workspace/context';
import { newQueryClient, Providers, savedConnection, sessionInfo } from '@/features/workspace/test-workspace';
import type * as ApiModule from '@/lib/api';
import { api, ApiError, queryKeys } from '@/lib/api';
import type { ShellCommand } from '@/lib/bridge';
import { mockBridge } from '@/test/bridge-defaults';
import { AppShell } from './app-shell';
import { HOME, restoreTabId, tabsStore } from './tabs-store';
import { resetWindowRestore } from './use-window-restore';
import { resetWindowState } from './window-state';
import { resetWorkspaceIntents } from './workspace-intents';

/*
 * 0.7.2: three servers open in one window. The real shell, workspaces, Query, Data and Monitor
 * tabs run against a mocked API; every request is checked for the session id it carries. Only
 * the schema diagram (React Flow) and the Connections screen (its form is changing) are stand-ins.
 */

vi.mock('@/lib/api', async (importOriginal) => {
  const actual = await importOriginal<typeof ApiModule>();
  // Every route mocked, so a request nobody expected fails the test instead of reaching fetch.
  return { ...actual, api: Object.fromEntries(Object.keys(actual.api).map((name) => [name, vi.fn()])) };
});
vi.mock('@/features/schema/schema-tab', () => ({
  SchemaTab: () => <p>schema of {useWorkspace().sid}</p>,
}));
vi.mock('@/features/connections/connections-screen', () => ({
  // Goes through the window's real connect flow (ConnectProvider), as the Connections screen does.
  ConnectionsScreen: function ConnectionsStandIn() {
    const { connect } = useConnectActions();
    const favorites = useQuery({ queryKey: queryKeys.connections, queryFn: api.listConnections });
    return (
      <ul>
        {favorites.data?.map((f) => (
          <li key={f.id}>
            <button type="button" onClick={() => void connect(f)}>
              Connect {f.nickname}
            </button>
          </li>
        ))}
      </ul>
    );
  },
}));

const mocked = vi.mocked(api);

// jsdom has no layout: give grids a viewport so rows render, and CodeMirror the ranges it measures.
const sizes = { clientWidth: 1400, clientHeight: 800 };
const savedSizes: Partial<Record<keyof typeof sizes, PropertyDescriptor | undefined>> = {};
beforeAll(() => {
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

// ---- three servers (and a fourth favorite, not open) ---------------------------------------

type Server = { sid: string; id: string; nickname: string };
const alpha: Server = { sid: 's-a', id: 'c1', nickname: 'alpha' };
const beta: Server = { sid: 's-b', id: 'c2', nickname: 'beta' };
const gamma: Server = { sid: 's-c', id: 'c3', nickname: 'gamma' };
const delta: Server = { sid: 's-d', id: 'c4', nickname: 'delta' };
const servers = [alpha, beta, gamma, delta];

const favorite = (s: Server, patch: Partial<SavedConnection> = {}): SavedConnection => ({
  ...savedConnection,
  id: s.id,
  nickname: s.nickname,
  database: s.nickname,
  ...patch,
});
const session = (s: Server): SessionInfo => ({ ...sessionInfo, sid: s.sid, connection: favorite(s) });
const bySid = (sid: string) => servers.find((s) => s.sid === sid)!;
const byId = (id: string) => servers.find((s) => s.id === id)!;

/** Every server has a public.orders (same table key everywhere) and a table of its own. */
const modelOf = (s: Server): SchemaModel => ({
  schemas: ['public'],
  tables: [
    table('orders', [col('id', 'bigint'), col('total', 'numeric', { nullable: true })]),
    table(`${s.nickname}_only`, [col('id')]),
  ],
  views: [],
  foreignKeys: [],
  enums: [],
  introspectedAt: '2026-11-25T10:00:00Z',
});

const meta = (name: string, typeName: string): ColumnMeta => ({
  name,
  type: typeName,
  typeName,
  typeOid: 0,
  typeCategory: 'N',
});

const historyOf = (s: Server): HistoryEntry[] => [
  {
    id: `h-${s.id}`,
    connectionId: s.id,
    sql: `select '${s.nickname} history'`,
    kind: 'query',
    ranAt: new Date().toISOString(),
    elapsedMs: 3,
    rowCount: 1,
    error: null,
    cancelled: false,
  },
];

const revenue = (s: Server, sql: string): SavedQuery => ({
  id: `q-${s.id}`,
  connectionId: s.id,
  name: 'Revenue',
  sql,
  chart: null,
  createdAt: '2026-11-25T10:00:00Z',
  updatedAt: '2026-11-25T10:00:00Z',
});

function snapshot(kind: StatsKind): StatsResult {
  switch (kind) {
    case 'sessions':
      return { kind, maxConnections: 100, sessions: [] };
    case 'locks':
      return { kind, blocked: [], blockers: [] };
    case 'throughput':
      return { kind, samples: [], cacheHitRatioTotal: 0.99, numBackends: 3 };
    case 'tables':
      return { kind, tables: [] };
    case 'indexes':
      return { kind, indexes: [] };
    case 'statements':
      return { kind, available: false, installHint: null, statements: [] };
  }
}

// ---- window ---------------------------------------------------------------------------------

let send: ((command: ShellCommand) => void) | null = null;
let client: QueryClient;

beforeEach(() => {
  const { bridge } = mockBridge();
  bridge.onCommand.mockImplementation((listener) => {
    send = listener;
    return () => {
      send = null;
    };
  });
  window.kleos = bridge;
  client = newQueryClient();

  mocked.health.mockResolvedValue({ ok: true, version: '0.7.2' });
  mocked.listConnections.mockResolvedValue(servers.map((s) => favorite(s)));
  mocked.getWindowState.mockResolvedValue(emptyWindowState);
  mocked.saveWindowState.mockResolvedValue(undefined);
  mocked.openSession.mockImplementation(async (req) => session(byId(req.connectionId)));
  mocked.closeSession.mockResolvedValue(undefined);
  mocked.getSession.mockImplementation(async (sid) => session(bySid(sid)));
  mocked.schema.mockImplementation(async (sid) => modelOf(bySid(sid)));
  mocked.savedQueries.mockResolvedValue([]);
  mocked.snippets.mockResolvedValue([]);
  mocked.history.mockImplementation(async (connectionId) => historyOf(byId(connectionId)));
  mocked.searchHistory.mockResolvedValue([]);
  // A query answers with the session it ran on, so each grid shows whose result it holds.
  mocked.startQuery.mockImplementation(async (sid, req) => ({
    qid: req.qid,
    columns: [meta('ran_on', 'text')],
    rows: [[sid]],
    hasMore: false,
    command: null,
    rowCount: 1,
    elapsedMs: 2,
  }));
  mocked.closeTab.mockResolvedValue(undefined);
  mocked.closeQuery.mockResolvedValue(undefined);
  mocked.cancelQuery.mockResolvedValue(undefined);
  mocked.rows.mockResolvedValue({
    columns: [meta('id', 'int8'), meta('total', 'numeric')],
    rows: [
      ['1', '1249.00'],
      ['2', '80.00'],
    ],
    hasMore: false,
    elapsedMs: 1,
  });
  mocked.count.mockResolvedValue({ count: '2', exact: false });
  mocked.getGridLayout.mockResolvedValue(emptyGridLayout);
  mocked.saveGridLayout.mockResolvedValue(undefined);
  mocked.applyEdits.mockResolvedValue({ applied: 1, rows: [], columns: [] });
  mocked.stats.mockImplementation(async (_sid: string, kind: StatsKind) => snapshot(kind) as never);
});

afterEach(() => {
  // Unmount first: a mounted Query tab would recreate its session's "Query 1" as the stores reset.
  cleanup();
  vi.clearAllMocks();
  delete window.kleos;
  act(() => {
    tabsStore.reset();
    resetWindowState();
    resetQueryWorkspaces();
    resetTableViews();
  });
  resetWindowRestore();
  resetWorkspaceIntents();
  resetHistorySearchRequests();
});

function renderShell() {
  return render(
    <Providers client={client}>
      <AppShell />
    </Providers>,
  );
}

/**
 * The pane under the title bar that holds this tab's workspace: AppShell renders the header,
 * the Connections pane, then one pane per tab in tab order (all mounted, only the front one shown).
 */
function pane(sid: string): HTMLElement {
  const index = tabsStore.get().tabs.findIndex((t) => t.sid === sid);
  if (index === -1) throw new Error(`No tab ${sid}`);
  const root = document.querySelector('header')!.parentElement!;
  return root.children[2 + index] as HTMLElement;
}

/** Opens the servers' sessions the way a connect does, the last one ending in front. */
async function openServers(...list: Server[]) {
  for (const s of list) act(() => tabsStore.open(session(s)));
  for (const s of list) await within(pane(s.sid)).findByText(`schema of ${s.sid}`);
}

const front = () => tabsStore.get().active;
const order = () => tabsStore.get().tabs.map((t) => t.sid);
const sidsOf = (fn: { mock: { calls: unknown[][] } }) => fn.mock.calls.map((c) => c[0]);

async function showTab(sid: string, name: 'Data' | 'Query' | 'Monitor') {
  await userEvent.click(within(pane(sid)).getByRole('tab', { name }));
}

/** The query editor of a server's Query tab (each workspace has its own). */
function editorOf(sid: string): EditorView {
  return EditorView.findFromDOM(pane(sid).querySelector('.cm-editor')!)!;
}

function typeSql(sid: string, sql: string) {
  const view = editorOf(sid);
  act(() => view.dispatch({ changes: { from: view.state.doc.length, insert: sql } }));
}

const gridCells = (sid: string) =>
  within(pane(sid))
    .queryAllByRole('gridcell')
    .map((c) => c.textContent);

/** SQL of the active query tab of a session, or undefined when its Query tab never opened. */
function activeSql(sid: string): string | undefined {
  const ws = peekQueryWorkspace(sid);
  return ws?.tabs.find((t) => t.id === ws.activeId)?.sql;
}

async function openPaletteAndPick(search: string, option: RegExp) {
  act(() => send?.('palette'));
  await userEvent.type(await screen.findByRole('combobox', { name: 'Command palette' }), search);
  await userEvent.click(await screen.findByRole('option', { name: option }));
  await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
}

const nowSnippet: Snippet = {
  id: 'n1',
  name: 'Now',
  body: 'now()',
  createdAt: '2026-11-25T10:00:00Z',
  updatedAt: '2026-11-25T10:00:00Z',
};

describe('Three servers open — ⌘K acts on the right one', { timeout: 30_000 }, () => {
  beforeEach(() => {
    mocked.snippets.mockResolvedValue([nowSnippet]);
  });

  it('inserts a snippet into the front server only, and follows the front after ⌘2', async () => {
    renderShell();
    await openServers(alpha, beta, gamma);
    expect(front()).toBe(gamma.sid);

    await openPaletteAndPick('Now', /Insert snippet: Now/);
    await waitFor(() => expect(activeSql(gamma.sid)).toBe('now()'));
    expect(within(pane(gamma.sid)).getByRole('tab', { name: 'Query' })).toHaveAttribute('aria-selected', 'true');
    // The other servers never even opened their Query tab.
    expect(activeSql(alpha.sid)).toBeUndefined();
    expect(activeSql(beta.sid)).toBeUndefined();

    act(() => send?.('select-tab-2'));
    expect(front()).toBe(beta.sid);
    await openPaletteAndPick('Now', /Insert snippet: Now/);
    await waitFor(() => expect(activeSql(beta.sid)).toBe('now()'));
    expect(editorOf(beta.sid).state.doc.toString()).toBe('now()');
    // Inserted once, where it was asked: gamma keeps its single insert, alpha stays untouched.
    expect(activeSql(gamma.sid)).toBe('now()');
    expect(editorOf(gamma.sid).state.doc.toString()).toBe('now()');
    expect(activeSql(alpha.sid)).toBeUndefined();
  });

  it('runs a saved query on the server it belongs to, bringing that server to front', async () => {
    mocked.savedQueries.mockImplementation(async (connectionId) =>
      connectionId === alpha.id
        ? [revenue(alpha, 'select 1')]
        : connectionId === gamma.id
          ? [revenue(gamma, 'select 3')]
          : [],
    );
    renderShell();
    await openServers(alpha, beta, gamma);
    act(() => send?.('select-tab-2'));

    // Both alpha and gamma have a "Revenue"; the entry names its server.
    await openPaletteAndPick('Revenue', /Run saved query: Revenue.*gamma/);
    expect(front()).toBe(gamma.sid);
    await waitFor(() => expect(gridCells(gamma.sid)).toEqual([gamma.sid]));
    expect(mocked.startQuery).toHaveBeenCalledTimes(1);
    expect(mocked.startQuery).toHaveBeenCalledWith(gamma.sid, expect.objectContaining({ sql: 'select 3' }));
    expect(activeSql(alpha.sid)).toBeUndefined();
    expect(activeSql(beta.sid)).toBeUndefined();
  });

  it('opens a table of a background server in that server’s Data tab, fetching on its session', async () => {
    renderShell();
    await openServers(alpha, beta, gamma);

    await openPaletteAndPick('alpha_only', /^alpha_only/);
    expect(front()).toBe(alpha.sid);
    expect(within(pane(alpha.sid)).getByRole('tab', { name: 'Data' })).toHaveAttribute('aria-selected', 'true');
    await waitFor(() => expect(gridCells(alpha.sid)).toContain('1249.00'));
    expect(new Set(sidsOf(mocked.rows))).toEqual(new Set([alpha.sid]));
    expect(mocked.rows).toHaveBeenCalledWith(
      alpha.sid,
      expect.objectContaining({ table: { schema: 'public', name: 'alpha_only' } }),
    );
    for (const s of [beta, gamma]) {
      expect(within(pane(s.sid)).getByRole('tab', { name: 'Schema' })).toHaveAttribute('aria-selected', 'true');
    }
  });
});

describe('Three servers open — each workspace keeps its own work', { timeout: 30_000 }, () => {
  it('keeps each server’s query SQL and last result while another server is in front', async () => {
    renderShell();
    await openServers(alpha, beta, gamma);
    act(() => send?.('select-tab-1'));

    await showTab(alpha.sid, 'Query');
    typeSql(alpha.sid, 'select 1 as a');
    await userEvent.click(within(pane(alpha.sid)).getByRole('button', { name: /^Run(?! all)/ }));
    await waitFor(() => expect(gridCells(alpha.sid)).toEqual([alpha.sid]));

    act(() => send?.('select-tab-2'));
    await showTab(beta.sid, 'Query');
    expect(editorOf(beta.sid).state.doc.toString()).toBe('');
    expect(gridCells(beta.sid)).toEqual([]);
    typeSql(beta.sid, 'select 2 as b');

    act(() => send?.('select-tab-1'));
    // Alpha's workspace stayed mounted: same tab, same text, same result.
    expect(within(pane(alpha.sid)).getByRole('tab', { name: 'Query' })).toHaveAttribute('aria-selected', 'true');
    expect(editorOf(alpha.sid).state.doc.toString()).toBe('select 1 as a');
    expect(gridCells(alpha.sid)).toEqual([alpha.sid]);
    expect(editorOf(beta.sid).state.doc.toString()).toBe('select 2 as b');
    expect(activeSql(gamma.sid)).toBeUndefined();
  });

  it('⌘S saves the query of the server in front, under that favorite', async () => {
    const user = userEvent.setup();
    mocked.createSavedQuery.mockImplementation(async (input) => ({
      ...revenue(byId(input.connectionId), input.sql),
      name: input.name,
    }));
    renderShell();
    await openServers(alpha, beta);
    act(() => send?.('select-tab-1'));
    await showTab(alpha.sid, 'Query');
    typeSql(alpha.sid, 'select 1 -- alpha');
    act(() => send?.('select-tab-2'));
    await showTab(beta.sid, 'Query');
    typeSql(beta.sid, 'select 2 -- beta');

    await user.keyboard('{Meta>}s{/Meta}');
    // One Save dialog: alpha's Query tab is mounted too, but not in front.
    const name = await screen.findByLabelText('Name');
    expect(screen.getAllByRole('dialog')).toHaveLength(1);
    await user.clear(name);
    await user.type(name, 'beta query{Enter}');
    await waitFor(() =>
      expect(mocked.createSavedQuery).toHaveBeenCalledWith({
        connectionId: beta.id,
        name: 'beta query',
        sql: 'select 2 -- beta',
        chart: null,
      }),
    );
    expect(mocked.createSavedQuery).toHaveBeenCalledTimes(1);
  });

  it('sends every request on the session of the workspace that makes it', async () => {
    renderShell();
    await openServers(alpha, beta, gamma);

    // A query run in beta, after gamma was in front and alpha was opened first.
    act(() => send?.('select-tab-2'));
    await showTab(beta.sid, 'Query');
    typeSql(beta.sid, 'select 2');
    await userEvent.click(within(pane(beta.sid)).getByRole('button', { name: /^Run(?! all)/ }));
    await waitFor(() => expect(gridCells(beta.sid)).toEqual([beta.sid]));
    expect(sidsOf(mocked.startQuery)).toEqual([beta.sid]);
    // The query tab's server-side client lives in beta's session too.
    expect(mocked.startQuery.mock.calls[0]![1].tabId).toBe(getQueryWorkspace(beta.sid).activeId);

    // A table page and its count, opened from alpha's sidebar.
    act(() => send?.('select-tab-1'));
    await userEvent.dblClick(within(pane(alpha.sid)).getByRole('button', { name: /^orders/ }));
    await waitFor(() => expect(gridCells(alpha.sid)).toContain('1249.00'));
    expect(new Set(sidsOf(mocked.rows))).toEqual(new Set([alpha.sid]));
    expect(new Set(sidsOf(mocked.count))).toEqual(new Set([alpha.sid]));

    // The monitor polls gamma's session while gamma's Monitor is in front, and stops when it isn't.
    act(() => send?.('select-tab-3'));
    await showTab(gamma.sid, 'Monitor');
    await waitFor(() => expect(mocked.stats).toHaveBeenCalledTimes(6));
    expect(new Set(sidsOf(mocked.stats))).toEqual(new Set([gamma.sid]));
    const gammaStats = () => client.getQueryCache().findAll({ queryKey: ['stats', gamma.sid] });
    expect(gammaStats().every((q) => q.isActive())).toBe(true);

    act(() => send?.('select-tab-2'));
    await showTab(beta.sid, 'Monitor');
    await waitFor(() => expect(mocked.stats).toHaveBeenCalledTimes(12));
    expect(mocked.stats.mock.calls.slice(6).every(([sid]) => sid === beta.sid)).toBe(true);
    // Gamma's panels are still mounted (hidden), but no longer poll.
    expect(gammaStats()).toHaveLength(6);
    expect(gammaStats().some((q) => q.isActive())).toBe(false);
  });

  it('keeps staged edits with their server: ⌘S commits the front one, closing another leaves it alone', async () => {
    const user = userEvent.setup();
    renderShell();
    await openServers(alpha, beta, gamma);

    // Stage an edit on alpha's public.orders.
    act(() => send?.('select-tab-1'));
    await user.dblClick(within(pane(alpha.sid)).getByRole('button', { name: /^orders/ }));
    await user.dblClick(await within(pane(alpha.sid)).findByText('1249.00'));
    const input = within(pane(alpha.sid)).getByLabelText('total value');
    await user.clear(input);
    await user.type(input, '1194.00{Enter}');
    expect(within(pane(alpha.sid)).getByLabelText('Pending changes')).toHaveTextContent('1 updated');

    // Beta's public.orders (same table key) shows none of it.
    act(() => send?.('select-tab-2'));
    await user.dblClick(within(pane(beta.sid)).getByRole('button', { name: /^orders/ }));
    expect(await within(pane(beta.sid)).findByText('1249.00')).not.toHaveAttribute('title', 'Was 1249.00');
    expect(within(pane(beta.sid)).queryByLabelText('Pending changes')).not.toBeInTheDocument();
    expect(within(pane(beta.sid)).queryByText('1194.00')).not.toBeInTheDocument();

    // Stage one in beta too; ⌘S commits only the server in front.
    await user.dblClick(within(pane(beta.sid)).getByText('80.00'));
    const betaInput = within(pane(beta.sid)).getByLabelText('total value');
    await user.clear(betaInput);
    await user.type(betaInput, '81.00{Enter}');
    await user.keyboard('{Meta>}s{/Meta}');
    await waitFor(() => expect(within(pane(beta.sid)).queryByLabelText('Pending changes')).not.toBeInTheDocument());
    expect(mocked.applyEdits).toHaveBeenCalledTimes(1);
    expect(mocked.applyEdits).toHaveBeenCalledWith(beta.sid, [
      { kind: 'update', table: { schema: 'public', name: 'orders' }, key: { id: '2' }, set: { total: '81.00' } },
    ]);
    expect(within(pane(alpha.sid)).getByLabelText('Pending changes')).toHaveTextContent('1 updated');

    // Closing alpha with its edit still pending: Kleos doesn't ask (no prompt exists for this),
    // closes alpha's session only, and beta goes on as it was.
    await user.click(screen.getByRole('button', { name: 'Close alpha' }));
    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
    expect(mocked.closeSession).toHaveBeenCalledTimes(1);
    expect(mocked.closeSession).toHaveBeenCalledWith(alpha.sid);
    expect(mocked.applyEdits).toHaveBeenCalledTimes(1);
    expect(order()).toEqual([beta.sid, gamma.sid]);
    expect(front()).toBe(beta.sid);
    expect(within(pane(beta.sid)).getByRole('tab', { name: 'Data' })).toHaveAttribute('aria-selected', 'true');
    expect(gridCells(beta.sid)).toContain('1249.00');
  });

  it('shows each server its own history, and a run refreshes only its own', async () => {
    renderShell();
    await openServers(alpha, beta);
    act(() => send?.('select-tab-1'));
    await showTab(alpha.sid, 'Query');
    act(() => send?.('select-tab-2'));
    await showTab(beta.sid, 'Query');

    const latest = (s: Server) => within(pane(s.sid)).findByRole('list', { name: 'Latest runs' });
    expect(await latest(alpha)).toHaveTextContent("select 'alpha history'");
    expect(await latest(alpha)).not.toHaveTextContent('beta history');
    expect(await latest(beta)).toHaveTextContent("select 'beta history'");
    expect(await latest(beta)).not.toHaveTextContent('alpha history');

    const callsFor = (s: Server) => mocked.history.mock.calls.filter(([id]) => id === s.id).length;
    const alphaBefore = callsFor(alpha);
    const betaBefore = callsFor(beta);
    act(() => send?.('select-tab-1'));
    typeSql(alpha.sid, 'select 1');
    await userEvent.click(within(pane(alpha.sid)).getByRole('button', { name: /^Run(?! all)/ }));
    await waitFor(() => expect(callsFor(alpha)).toBeGreaterThan(alphaBefore));
    expect(callsFor(beta)).toBe(betaBefore);
  });
});

describe('Three servers open — tabs and sessions', { timeout: 30_000 }, () => {
  it('closing the middle tab closes only its session, fronts its right neighbour, and ⌘1–3 follow', async () => {
    renderShell();
    await openServers(alpha, beta, gamma);
    act(() => send?.('select-tab-2'));
    act(() => send?.('close-tab'));

    expect(mocked.closeSession).toHaveBeenCalledTimes(1);
    expect(mocked.closeSession).toHaveBeenCalledWith(beta.sid);
    expect(order()).toEqual([alpha.sid, gamma.sid]);
    expect(front()).toBe(gamma.sid);
    await waitFor(() => expect(window.kleos!.setTitle).toHaveBeenLastCalledWith('gamma — Kleos'));
    // Only beta's cached answers go with it.
    expect(client.getQueryData(queryKeys.schema(beta.sid))).toBeUndefined();
    expect(client.getQueryData(queryKeys.schema(alpha.sid))).toBeDefined();
    expect(client.getQueryData(queryKeys.schema(gamma.sid))).toBeDefined();

    act(() => send?.('select-tab-1'));
    expect(front()).toBe(alpha.sid);
    act(() => send?.('select-tab-2'));
    expect(front()).toBe(gamma.sid);
    act(() => send?.('select-tab-1'));
    act(() => send?.('select-tab-3'));
    // No third tab any more: ⌘3 changes nothing.
    expect(front()).toBe(alpha.sid);
    act(() => send?.('select-tab-9'));
    expect(front()).toBe(gamma.sid);
    expect(within(pane(alpha.sid)).getByText(`schema of ${alpha.sid}`)).toBeInTheDocument();
  });

  it('closing a background tab keeps the front one in front', async () => {
    renderShell();
    await openServers(alpha, beta, gamma);
    await userEvent.click(screen.getByRole('button', { name: 'Close beta' }));
    expect(mocked.closeSession).toHaveBeenCalledTimes(1);
    expect(mocked.closeSession).toHaveBeenCalledWith(beta.sid);
    expect(front()).toBe(gamma.sid);
    expect(order()).toEqual([alpha.sid, gamma.sid]);
  });

  it('Connect on a favorite already open brings its tab to front; a new one opens a fourth tab', async () => {
    const user = userEvent.setup();
    renderShell();
    await openServers(alpha, beta, gamma);
    act(() => send?.('new-tab'));
    expect(front()).toBe(HOME);

    await user.click(await screen.findByRole('button', { name: 'Connect beta' }));
    expect(front()).toBe(beta.sid);
    expect(mocked.openSession).not.toHaveBeenCalled();
    expect(order()).toEqual([alpha.sid, beta.sid, gamma.sid]);

    act(() => send?.('new-tab'));
    await user.click(screen.getByRole('button', { name: 'Connect delta' }));
    await waitFor(() => expect(front()).toBe(delta.sid));
    expect(mocked.openSession).toHaveBeenCalledTimes(1);
    expect(mocked.openSession).toHaveBeenCalledWith(expect.objectContaining({ connectionId: delta.id }));
    expect(order()).toEqual([alpha.sid, beta.sid, gamma.sid, delta.sid]);
    expect(await within(pane(delta.sid)).findByText(`schema of ${delta.sid}`)).toBeInTheDocument();
    expect(mocked.closeSession).not.toHaveBeenCalled();
  });
});

describe('Three servers restored from the last window', { timeout: 30_000 }, () => {
  beforeEach(() => {
    mocked.listConnections.mockResolvedValue([
      favorite(alpha),
      favorite(beta, { hasPassword: false }),
      favorite(gamma),
      favorite(delta),
    ]);
    const queryTab = (sql: string) => [{ title: 'Query 1', sql, chart: null, savedQueryId: null }];
    mocked.getWindowState.mockResolvedValue({
      activeConnectionId: gamma.id,
      servers: [alpha, beta, gamma].map((s) => ({
        connectionId: s.id,
        queryTabs: queryTab(`select '${s.nickname}'`),
        activeQueryTab: 0,
        workspaceTab: 'query' as const,
      })),
    });
    mocked.openSession.mockImplementation(async (req) => {
      if (req.connectionId === beta.id && !req.password) {
        throw new ApiError(401, { code: kleosErrorCodes.passwordRequired, message: 'needs a password' });
      }
      return session(byId(req.connectionId));
    });
  });

  it('reconnects the two with a saved password, leaves the middle one waiting, and keeps order and front', async () => {
    const user = userEvent.setup();
    renderShell();

    await waitFor(() => expect(order()).toEqual([alpha.sid, restoreTabId(beta.id), gamma.sid]));
    await waitFor(() => expect(tabsStore.findByConnection(beta.id)?.restore?.state).toBe('reconnect'));
    expect(front()).toBe(gamma.sid);
    // The front server first, then the others in tab order; nothing prompts by itself.
    expect(mocked.openSession.mock.calls.map(([req]) => req.connectionId)).toEqual([gamma.id, alpha.id, beta.id]);
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(within(pane(restoreTabId(beta.id))).getByRole('region', { name: 'Reconnect beta' })).toHaveTextContent(
      'Its password isn’t saved in the Keychain.',
    );
    // Each reconnected server got its own query tabs back.
    await waitFor(() => expect(activeSql(alpha.sid)).toBe("select 'alpha'"));
    await waitFor(() => expect(activeSql(gamma.sid)).toBe("select 'gamma'"));
    expect(editorOf(gamma.sid).state.doc.toString()).toBe("select 'gamma'");

    act(() => send?.('select-tab-2'));
    const waiting = within(pane(restoreTabId(beta.id))).getByRole('region', { name: 'Reconnect beta' });
    await user.click(within(waiting).getByRole('button', { name: 'Connect' }));
    const dialog = await screen.findByRole('dialog');
    expect(dialog).toHaveTextContent('Password for beta');
    await user.type(within(dialog).getByLabelText('Password'), 'hunter2{Enter}');

    // Replaced in place, in front, with its own tabs; the others are as they were.
    await waitFor(() => expect(order()).toEqual([alpha.sid, beta.sid, gamma.sid]));
    expect(front()).toBe(beta.sid);
    await waitFor(() => expect(activeSql(beta.sid)).toBe("select 'beta'"));
    expect(activeSql(alpha.sid)).toBe("select 'alpha'");
    expect(activeSql(gamma.sid)).toBe("select 'gamma'");
    expect(mocked.closeSession).not.toHaveBeenCalled();
  });

  it('a server connected by hand while its quiet reconnect is under way keeps one session and one tab', async () => {
    const user = userEvent.setup();
    let finishQuiet: (s: SessionInfo) => void = () => {};
    const quiet = new Promise<SessionInfo>((resolve) => {
      finishQuiet = resolve;
    });
    const reconnect = mocked.openSession.getMockImplementation()!;
    let gammaCalls = 0;
    mocked.openSession.mockImplementation(async (req) => {
      if (req.connectionId === gamma.id && ++gammaCalls === 1) return quiet;
      return reconnect(req);
    });
    renderShell();
    // Gamma (in front) reconnects first; the others wait behind it.
    await waitFor(() => expect(gammaCalls).toBe(1));
    expect(order()).toEqual([restoreTabId(alpha.id), restoreTabId(beta.id), restoreTabId(gamma.id)]);

    act(() => send?.('new-tab'));
    await user.click(await screen.findByRole('button', { name: 'Connect gamma' }));
    await waitFor(() => expect(order()).toEqual([restoreTabId(alpha.id), restoreTabId(beta.id), gamma.sid]));
    expect(front()).toBe(gamma.sid);

    // The quiet attempt lands late: its session is closed, the tab keeps the one opened by hand.
    await act(async () => finishQuiet({ ...session(gamma), sid: 's-c-quiet' }));
    await waitFor(() => expect(mocked.closeSession).toHaveBeenCalledWith('s-c-quiet'));
    await waitFor(() => expect(order()).toEqual([alpha.sid, restoreTabId(beta.id), gamma.sid]));
    expect(mocked.closeSession).toHaveBeenCalledTimes(1);
    expect(front()).toBe(gamma.sid);
  });

  it('offers ⌘K workspace actions only for a server that has a workspace, not one still waiting', async () => {
    const user = userEvent.setup();
    mocked.snippets.mockResolvedValue([nowSnippet]);
    renderShell();
    await waitFor(() => expect(tabsStore.findByConnection(beta.id)?.restore?.state).toBe('reconnect'));
    act(() => send?.('select-tab-2'));

    act(() => send?.('palette'));
    const input = await screen.findByRole('combobox', { name: 'Command palette' });
    await waitFor(() => expect(client.getQueryData(queryKeys.snippets)).toEqual([nowSnippet]));
    // Beta has no session yet: nothing to switch tab in, refresh, search or insert into…
    expect(await screen.findByRole('option', { name: /^Close beta/ })).toBeInTheDocument();
    expect(screen.queryByRole('option', { name: /^Go to Query/ })).not.toBeInTheDocument();
    expect(screen.queryByRole('option', { name: /^Refresh schema/ })).not.toBeInTheDocument();
    expect(screen.queryByRole('option', { name: /^Search history/ })).not.toBeInTheDocument();
    await user.type(input, 'Now');
    expect(screen.queryByRole('option', { name: /Insert snippet: Now/ })).not.toBeInTheDocument();
    await user.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());

    // …while gamma, connected, offers them all.
    act(() => send?.('select-tab-3'));
    await openPaletteAndPick('Now', /Insert snippet: Now/);
    // Inserted at gamma's cursor, which a restored editor leaves at the start.
    await waitFor(() => expect(activeSql(gamma.sid)).toBe("now()select 'gamma'"));
    expect(peekQueryWorkspace(restoreTabId(beta.id))).toBeUndefined();
  });
});
