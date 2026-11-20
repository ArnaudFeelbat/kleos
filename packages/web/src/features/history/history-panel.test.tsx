import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { HistoryEntry, SavedConnection } from '@kleos/shared';
import { tabsStore } from '@/features/shell/tabs-store';
import {
  newQueryClient,
  Providers,
  savedConnection,
  sessionInfo,
  workspaceState,
} from '@/features/workspace/test-workspace';
import type * as ApiModule from '@/lib/api';
import { api, queryKeys } from '@/lib/api';
import { HistoryPanel, type HistoryPanelProps } from './history-panel';

vi.mock('@/lib/api', async (importOriginal) => {
  const actual = await importOriginal<typeof ApiModule>();
  return { ...actual, api: { history: vi.fn(), searchHistory: vi.fn(), listConnections: vi.fn() } };
});
const mocked = vi.mocked(api);

beforeAll(() => {
  // Radix Select captures the pointer; jsdom has no pointer capture.
  Element.prototype.hasPointerCapture ??= () => false;
  Element.prototype.releasePointerCapture ??= () => {};
});

const entry = (patch: Partial<HistoryEntry>): HistoryEntry => ({
  id: 'h1',
  connectionId: 'c1',
  sql: 'select 1',
  kind: 'query',
  ranAt: '2026-11-18T10:00:00Z',
  elapsedMs: 4,
  rowCount: 1,
  error: null,
  cancelled: false,
  ...patch,
});
const staging: SavedConnection = { ...savedConnection, id: 'c2', nickname: 'staging', color: 'orange' };
const analytics: SavedConnection = { ...savedConnection, id: 'c3', nickname: 'analytics', color: 'green' };

function renderPanel(props: Partial<HistoryPanelProps> = {}, state = workspaceState({ activeTab: 'query' })) {
  const client = newQueryClient();
  const onLoadHistory = vi.fn();
  const all: HistoryPanelProps = { connectionId: 'c1', connectionName: 'shop_dev', onLoadHistory, ...props };
  const view = render(
    <Providers client={client} state={state}>
      <HistoryPanel {...all} />
    </Providers>,
  );
  const rerender = (next: Partial<HistoryPanelProps>, nextState = state) =>
    view.rerender(
      <Providers client={client} state={nextState}>
        <HistoryPanel {...all} {...next} />
      </Providers>,
    );
  return { client, onLoadHistory, rerender, container: view.container };
}

const field = () => screen.getByRole('searchbox', { name: 'Search history' });
const marks = (container: HTMLElement) => [...container.querySelectorAll('mark')].map((m) => m.textContent);

beforeEach(() => {
  mocked.history.mockResolvedValue([entry({ sql: 'select * from orders' })]);
  mocked.searchHistory.mockResolvedValue([]);
  mocked.listConnections.mockResolvedValue([savedConnection, staging, analytics]);
  act(() => {
    tabsStore.open({ ...sessionInfo, sid: 's1', connection: savedConnection });
    tabsStore.open({ ...sessionInfo, sid: 's2', connection: staging });
  });
});
afterEach(() => {
  vi.clearAllMocks();
  act(() => tabsStore.reset());
});

describe('HistoryPanel', () => {
  it('lists the latest runs of this server until a search or a filter is set', async () => {
    renderPanel();
    expect(await screen.findByText('select * from orders')).toBeInTheDocument();
    expect(screen.getByRole('list', { name: 'Latest runs' })).toBeInTheDocument();
    expect(screen.getByText('Keeps the latest 1,000 runs for shop_dev.')).toBeInTheDocument();
    expect(mocked.searchHistory).not.toHaveBeenCalled();
  });

  it('searches once typing pauses and highlights the matched words in the SQL and the error', async () => {
    const user = userEvent.setup();
    mocked.searchHistory.mockResolvedValue([
      entry({
        id: 'h2',
        sql: 'select * from orders o where o.stauts = 1',
        error: '42703 column o.stauts does not exist',
      }),
    ]);
    const { container } = renderPanel();
    await user.type(field(), 'stauts');
    await screen.findByRole('list', { name: 'Matching runs' });
    expect(mocked.searchHistory).toHaveBeenCalledTimes(1);
    expect(mocked.searchHistory).toHaveBeenCalledWith({
      q: 'stauts',
      connectionId: 'c1',
      outcome: undefined,
      limit: 200,
    });
    expect(marks(container)).toEqual(['stauts', 'stauts']);
    expect(screen.getByText('42703')).toBeInTheDocument();
    expect(screen.getByText('1 matching run, newest first.')).toBeInTheDocument();
  });

  it('filters by server (open servers and favorites, with their dot) and by outcome', async () => {
    const user = userEvent.setup();
    mocked.searchHistory.mockResolvedValue([entry({ id: 'h3', connectionId: 'c2', sql: 'select 2' })]);
    renderPanel();
    await screen.findByText('select * from orders');

    await user.click(screen.getByRole('combobox', { name: 'Server' }));
    expect((await screen.findAllByRole('option')).map((o) => o.textContent)).toEqual([
      'This server',
      'All servers',
      'staging',
      'analytics',
    ]);
    expect(screen.getByRole('group', { name: 'Open' })).toHaveTextContent('staging');
    expect(screen.getByRole('group', { name: 'Favorites' })).toHaveTextContent('analytics');
    await user.click(screen.getByRole('option', { name: 'All servers' }));
    await waitFor(() =>
      expect(mocked.searchHistory).toHaveBeenLastCalledWith({
        connectionId: undefined,
        outcome: undefined,
        limit: 200,
      }),
    );
    // Rows name their server when the list spans servers.
    const row = within(await screen.findByRole('list', { name: 'Matching runs' })).getByRole('button');
    expect(row).toHaveTextContent('staging');

    await user.click(screen.getByRole('combobox', { name: 'Outcome' }));
    await user.click(await screen.findByRole('option', { name: 'Failed' }));
    await waitFor(() =>
      expect(mocked.searchHistory).toHaveBeenLastCalledWith({ connectionId: undefined, outcome: 'error', limit: 200 }),
    );

    await user.click(screen.getByRole('combobox', { name: 'Server' }));
    await user.click(await screen.findByRole('option', { name: 'analytics' }));
    await waitFor(() =>
      expect(mocked.searchHistory).toHaveBeenLastCalledWith({ connectionId: 'c3', outcome: 'error', limit: 200 }),
    );
    expect(screen.getByRole('combobox', { name: 'Server' })).toHaveTextContent('analytics');
  });

  it('says what was searched when nothing matches', async () => {
    const user = userEvent.setup();
    renderPanel();
    await user.type(field(), 'refunds');
    expect(await screen.findByText('No runs match “refunds”')).toBeInTheDocument();
    expect(screen.getByText(/Searched all runs on shop_dev\./)).toBeInTheDocument();

    await user.clear(field());
    await user.click(screen.getByRole('combobox', { name: 'Outcome' }));
    await user.click(await screen.findByRole('option', { name: 'Cancelled' }));
    await user.click(screen.getByRole('combobox', { name: 'Server' }));
    await user.click(await screen.findByRole('option', { name: 'All servers' }));
    expect(await screen.findByText('No cancelled runs')).toBeInTheDocument();
    expect(screen.getByText('Searched cancelled runs on every server.')).toBeInTheDocument();
  });

  it('walks the results with ↓/↑ from the field and loads one with Enter', async () => {
    const user = userEvent.setup();
    const first = entry({ id: 'a', sql: 'select 1' });
    const second = entry({ id: 'b', sql: 'select 2' });
    mocked.history.mockResolvedValue([first, second]);
    const { onLoadHistory } = renderPanel();
    const rows = within(await screen.findByRole('list', { name: 'Latest runs' })).getAllByRole('button');

    await user.click(field());
    await user.keyboard('{ArrowDown}');
    expect(rows[0]).toHaveFocus();
    await user.keyboard('{ArrowDown}{ArrowDown}');
    expect(rows[1]).toHaveFocus();
    await user.keyboard('{ArrowUp}{ArrowUp}');
    expect(field()).toHaveFocus();
    await user.keyboard('{ArrowDown}{ArrowDown}{Enter}');
    expect(onLoadHistory).toHaveBeenCalledWith(second);
  });

  it('focuses the search field on a ⌘K request once the Query tab is in front', async () => {
    const hidden = workspaceState({ activeTab: 'schema' });
    const { rerender } = renderPanel({}, hidden);
    await screen.findByText('select * from orders');
    rerender({ focusRequest: 1 }, hidden);
    expect(field()).not.toHaveFocus();
    rerender({ focusRequest: 1 }, workspaceState({ activeTab: 'query' }));
    expect(field()).toHaveFocus();
  });

  it('refreshes an active search when a new run lands in the latest runs', async () => {
    const user = userEvent.setup();
    const { client } = renderPanel();
    await user.type(field(), 'orders');
    await waitFor(() => expect(mocked.searchHistory).toHaveBeenCalledTimes(1));
    await act(() => client.invalidateQueries({ queryKey: queryKeys.history('c1') }));
    await waitFor(() => expect(mocked.searchHistory).toHaveBeenCalledTimes(2));
  });
});
