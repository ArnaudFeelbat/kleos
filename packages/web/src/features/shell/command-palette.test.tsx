import { defaultSettings } from '@kleos/shared';
import { idleUpdateState } from '@/test/bridge-defaults';
import { QueryClient } from '@tanstack/react-query';
import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SavedQuery, SchemaModel, Snippet } from '@kleos/shared';
import { ConnectProvider } from '@/features/connections/connect-context';
import { resetHistorySearchRequests, useHistorySearchRequest } from '@/features/history/search-request';
import { Providers, savedConnection, sessionInfo } from '@/features/workspace/test-workspace';
import type * as ApiModule from '@/lib/api';
import { api, queryKeys } from '@/lib/api';
import type { KleosBridge } from '@/lib/bridge';
import { CommandPalette } from './command-palette';
import { HOME, tabsStore } from './tabs-store';
import { resetWorkspaceIntents, useWorkspaceIntent } from './workspace-intents';

vi.mock('@/lib/api', async (importOriginal) => {
  const actual = await importOriginal<typeof ApiModule>();
  return {
    ...actual,
    api: { listConnections: vi.fn(), schema: vi.fn(), openSession: vi.fn(), savedQueries: vi.fn(), snippets: vi.fn() },
  };
});

const mocked = vi.mocked(api);
const bridge = {
  apiBase: '',
  token: '',
  platform: 'darwin',
  vibrancy: false,
  setTitle: vi.fn(),
  closeWindow: vi.fn(),
  getAppearance: vi.fn(async () => 'light' as const),
  setAppearance: vi.fn(),
  saveFileDialog: vi.fn(async () => null),
  openFileDialog: vi.fn(async () => null),
  revealInFinder: vi.fn(),
  writeFile: vi.fn(async () => {}),
  appVersion: '0.5.0',
  windowKind: 'main' as const,
  getSettings: vi.fn(async () => defaultSettings),
  updateSettings: vi.fn(async () => defaultSettings),
  onSettingsChanged: vi.fn(() => () => {}),
  openSettings: vi.fn(),
  getUpdateState: vi.fn(async () => idleUpdateState),
  checkForUpdates: vi.fn(async () => idleUpdateState),
  onUpdateState: vi.fn(() => () => {}),
  openReleasePage: vi.fn(),
  onCommand: vi.fn(() => () => {}),
} satisfies KleosBridge;

const model = {
  schemas: ['shop'],
  tables: [{ schema: 'shop', name: 'orders' }],
  views: [{ schema: 'shop', name: 'order_totals' }],
  foreignKeys: [],
  enums: [],
  introspectedAt: '',
} as unknown as SchemaModel;

function IntentProbe() {
  const intent = useWorkspaceIntent('s1');
  const historySearch = useHistorySearchRequest('s1');
  return (
    <>
      <p data-testid="intent">{intent ? JSON.stringify(intent.intent) : 'none'}</p>
      <p data-testid="history-search">{historySearch === undefined ? 'none' : 'pending'}</p>
    </>
  );
}

const monthly: SavedQuery = {
  id: 'q1',
  connectionId: 'c1',
  name: 'monthly revenue',
  sql: 'select * from revenue where month = $1 and region = :region',
  chart: null,
  paramValues: { $1: '2026-10', ':region': 'EU' },
  createdAt: '',
  updatedAt: '',
};
const locks: Snippet = { id: 'n1', name: 'Locks', body: 'select * from pg_locks', createdAt: '', updatedAt: '' };

function renderPalette(onCloseTab = vi.fn()) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  client.setQueryData(queryKeys.schema('s1'), model);
  const onOpenChange = vi.fn();
  render(
    <Providers client={client}>
      <ConnectProvider>
        <CommandPalette open onOpenChange={onOpenChange} onCloseTab={onCloseTab} />
        <IntentProbe />
      </ConnectProvider>
    </Providers>,
  );
  return { onOpenChange, onCloseTab };
}

beforeEach(() => {
  mocked.savedQueries.mockResolvedValue([]);
  mocked.snippets.mockResolvedValue([]);
  window.kleos = bridge;
  mocked.listConnections.mockResolvedValue([
    savedConnection,
    { ...savedConnection, id: 'c2', nickname: 'staging', color: 'orange' },
  ]);
  act(() => tabsStore.open({ ...sessionInfo, sid: 's1', connection: savedConnection }));
  act(() => tabsStore.activate(HOME));
});
afterEach(() => {
  vi.clearAllMocks();
  delete window.kleos;
  act(() => tabsStore.reset());
  resetWorkspaceIntents();
  resetHistorySearchRequests();
});

describe('CommandPalette', { timeout: 15_000 }, () => {
  it('lists open servers and favorites to connect, but no tables until you type', async () => {
    renderPalette();
    expect(await screen.findByRole('option', { name: /staging/ })).toBeInTheDocument();
    expect(screen.getByRole('option', { name: /^shop_dev/ })).toBeInTheDocument();
    expect(screen.queryByRole('option', { name: /orders/ })).not.toBeInTheDocument();
  });

  it('opens a table of an open server from a search', async () => {
    const { onOpenChange } = renderPalette();
    const input = screen.getByRole('combobox', { name: 'Command palette' });
    await userEvent.type(input, 'orders');
    expect(await screen.findByRole('option', { name: /^orders/ })).toBeInTheDocument();
    await userEvent.keyboard('{Enter}');
    expect(onOpenChange).toHaveBeenCalledWith(false);
    expect(tabsStore.get().active).toBe('s1');
    expect(screen.getByTestId('intent')).toHaveTextContent(
      JSON.stringify({ kind: 'open-table', ref: { schema: 'shop', name: 'orders' }, tab: 'data' }),
    );
  });

  it('runs a saved query from its name: ⌘K, the name, Enter', async () => {
    mocked.savedQueries.mockResolvedValue([monthly]);
    const { onOpenChange } = renderPalette();
    // The empty palette lists saved queries to open, not to run.
    expect(await screen.findByRole('option', { name: /^monthly revenue/ })).toBeInTheDocument();
    expect(screen.queryByRole('option', { name: /Run saved query/ })).not.toBeInTheDocument();
    await userEvent.type(screen.getByRole('combobox', { name: 'Command palette' }), 'monthly revenue');
    const run = await screen.findByRole('option', { name: /^Run saved query: monthly revenue/ });
    await waitFor(() => expect(run).toHaveAttribute('aria-selected', 'true'));
    const options = screen.getAllByRole('option').map((o) => o.textContent);
    expect(options.slice(0, 2)).toEqual(['Run saved query: monthly revenue', 'monthly revenue']);
    await userEvent.keyboard('{Enter}');
    expect(onOpenChange).toHaveBeenCalledWith(false);
    expect(tabsStore.get().active).toBe('s1');
    expect(screen.getByTestId('intent')).toHaveTextContent(JSON.stringify({ kind: 'run-saved', query: monthly }));
  });

  it('still opens a saved query without running it, one ↓ away', async () => {
    mocked.savedQueries.mockResolvedValue([monthly]);
    renderPalette();
    await userEvent.type(screen.getByRole('combobox', { name: 'Command palette' }), 'monthly');
    await screen.findByRole('option', { name: /^Run saved query: monthly revenue/ });
    await userEvent.keyboard('{ArrowDown}{Enter}');
    expect(screen.getByTestId('intent')).toHaveTextContent(JSON.stringify({ kind: 'open-saved', query: monthly }));
  });

  it('inserts a snippet into the server in front', async () => {
    mocked.snippets.mockResolvedValue([locks]);
    act(() => tabsStore.activate('s1'));
    renderPalette();
    await screen.findByRole('option', { name: /^shop_dev/ });
    expect(screen.queryByRole('option', { name: /Insert snippet/ })).not.toBeInTheDocument();
    await userEvent.type(screen.getByRole('combobox', { name: 'Command palette' }), 'locks');
    const insert = await screen.findByRole('option', { name: /^Insert snippet: Locks/ });
    expect(insert).toHaveTextContent('select * from pg_locks');
    await waitFor(() => expect(insert).toHaveAttribute('aria-selected', 'true'));
    await userEvent.keyboard('{Enter}');
    expect(screen.getByTestId('intent')).toHaveTextContent(
      JSON.stringify({ kind: 'insert-sql', text: 'select * from pg_locks' }),
    );
  });

  it('Search history… shows the Query tab and asks its side panel for the search field', async () => {
    act(() => tabsStore.activate('s1'));
    renderPalette();
    await userEvent.type(screen.getByRole('combobox', { name: 'Command palette' }), 'search history');
    const action = await screen.findByRole('option', { name: /^Search history…/ });
    await waitFor(() => expect(action).toHaveAttribute('aria-selected', 'true'));
    await userEvent.keyboard('{Enter}');
    expect(screen.getByTestId('intent')).toHaveTextContent(JSON.stringify({ kind: 'tab', tab: 'query' }));
    expect(screen.getByTestId('history-search')).toHaveTextContent('pending');
  });

  it('switches appearance and marks the current one', async () => {
    renderPalette();
    await userEvent.type(screen.getByRole('combobox', { name: 'Command palette' }), 'appearance');
    const light = await screen.findByRole('option', { name: /Appearance: Light/ });
    await waitFor(() => expect(within(light).getByLabelText('Current')).toBeInTheDocument());
    await userEvent.click(screen.getByRole('option', { name: /Appearance: Dark/ }));
    expect(bridge.setAppearance).toHaveBeenCalledWith('dark');
  });
});
