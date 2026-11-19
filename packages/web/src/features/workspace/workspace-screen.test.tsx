import { defaultSettings } from '@kleos/shared';
import { idleUpdateState } from '@/test/bridge-defaults';
import { kleosErrorCodes } from '@kleos/shared';
import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getQueryWorkspace, isDirty, resetQueryWorkspaces } from '@/features/query/store';
import { shopModel } from '@/features/schema/test-fixtures';
import { tabsStore } from '@/features/shell/tabs-store';
import { placeRestoredTabs, resetWindowState, snapshotWindowState } from '@/features/shell/window-state';
import type * as ApiModule from '@/lib/api';
import { api, ApiError } from '@/lib/api';
import { useWorkspace } from './context';
import { Providers, savedConnection, sessionInfo } from './test-workspace';
import { WorkspaceScreen } from './workspace-screen';

vi.mock('@/lib/api', async (importOriginal) => {
  const actual = await importOriginal<typeof ApiModule>();
  return { ...actual, api: { getSession: vi.fn(), schema: vi.fn(), savedQueries: vi.fn() } };
});

// The tabs are other modules; stand-ins keep this test about the shell.
vi.mock('@/features/schema/schema-tab', () => ({
  SchemaTab: () => {
    const { openInQuery } = useWorkspace();
    return <button onClick={() => openInQuery('select 1;')}>schema stand-in</button>;
  },
}));
vi.mock('@/features/data/data-tab', () => ({
  DataTab: () => <p>data for {useWorkspace().selectedTable?.name ?? 'nothing'}</p>,
}));
vi.mock('@/features/query/query-tab', () => ({
  QueryTab: () => {
    const [text, setText] = useState('');
    const { queryDraft } = useWorkspace();
    return (
      <>
        <input aria-label="query stand-in" value={text} onChange={(e) => setText(e.target.value)} />
        <p>draft: {queryDraft?.sql ?? 'none'}</p>
      </>
    );
  },
}));
vi.mock('@/features/monitor/monitor-tab', () => ({ MonitorTab: () => <p>monitor stand-in</p> }));

const mocked = vi.mocked(api);

beforeEach(() => {
  window.kleos = {
    apiBase: '',
    token: '',
    platform: 'darwin',
    vibrancy: false,
    setTitle: vi.fn(),
    closeWindow: vi.fn(),
    getAppearance: vi.fn(async () => 'system' as const),
    setAppearance: vi.fn(),
    saveFileDialog: vi.fn(async () => null),
    openFileDialog: vi.fn(async () => null),
    revealInFinder: vi.fn(),
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
  };
  mocked.schema.mockResolvedValue(shopModel());
});
afterEach(() => {
  vi.clearAllMocks();
  delete window.kleos;
});

const onClose = vi.fn();

function renderWorkspace() {
  return render(
    <Providers>
      <WorkspaceScreen sid="s1" onClose={onClose} />
    </Providers>,
  );
}

describe('WorkspaceScreen', { timeout: 15_000 }, () => {
  it('says the session has ended when the server no longer knows it', async () => {
    mocked.getSession.mockRejectedValue(
      new ApiError(404, { code: kleosErrorCodes.sessionNotFound, message: 'Session not found or closed' }),
    );
    renderWorkspace();
    expect(await screen.findByRole('heading', { name: 'This session has ended' })).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Close tab' }));
    expect(onClose).toHaveBeenCalled();
  });

  it('tints the toolbar by connection color and shows the read-only and version badges', async () => {
    mocked.getSession.mockResolvedValue({
      ...sessionInfo,
      connection: { ...savedConnection, readOnly: true, color: 'red' },
    });
    renderWorkspace();
    const badge = await screen.findByText('Read-only');
    const toolbar = badge.closest('[data-tint]')!;
    expect(toolbar).toHaveAttribute('data-tint', 'red');
    expect(toolbar).toHaveTextContent('PG 16.4');
    // The sidebar shows the introspected schema.
    expect(await screen.findByRole('button', { name: /^orders/ })).toBeInTheDocument();
  });

  it('keeps a visited tab mounted, opens Data on double-click and hands SQL to Query', async () => {
    const user = userEvent.setup();
    mocked.getSession.mockResolvedValue(sessionInfo);
    renderWorkspace();

    await user.click(await screen.findByRole('tab', { name: 'Query' }));
    await user.type(screen.getByLabelText('query stand-in'), 'select now()');
    await user.click(screen.getByRole('tab', { name: 'Schema' }));
    expect(screen.getByRole('tab', { name: 'Schema' })).toHaveAttribute('aria-selected', 'true');
    await user.click(screen.getByRole('tab', { name: 'Query' }));
    expect(screen.getByLabelText('query stand-in')).toHaveValue('select now()');

    await user.dblClick(await screen.findByRole('button', { name: /^orders/ }));
    expect(screen.getByRole('tab', { name: 'Data' })).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByText('data for orders')).toBeInTheDocument();

    await user.click(screen.getByRole('tab', { name: 'Schema' }));
    await user.click(screen.getByRole('button', { name: 'schema stand-in' }));
    await waitFor(() => expect(screen.getByRole('tab', { name: 'Query' })).toHaveAttribute('aria-selected', 'true'));
    expect(screen.getByText('draft: select 1;')).toBeInTheDocument();
  });

  it('marks a read-only session where dblink can still write, with the server’s message', async () => {
    const user = userEvent.setup();
    const message = 'dblink is installed: dblink_exec writes through its own connection, which read-only can’t cover.';
    mocked.getSession.mockResolvedValue({
      ...sessionInfo,
      connection: { ...savedConnection, readOnly: true },
      notices: [{ code: 'READ_ONLY_DBLINK', message }],
    });
    renderWorkspace();
    const notice = await screen.findByLabelText(`Read-only caveat: ${message}`);
    await user.hover(notice);
    expect(await screen.findByRole('tooltip')).toHaveTextContent(message);
  });

  it('shows no dblink mark without the notice', async () => {
    mocked.getSession.mockResolvedValue({ ...sessionInfo, connection: { ...savedConnection, readOnly: true } });
    renderWorkspace();
    await screen.findByText('Read-only');
    expect(screen.queryByLabelText(/Read-only caveat/)).not.toBeInTheDocument();
  });
});

describe('WorkspaceScreen — a server restored from the last window', { timeout: 15_000 }, () => {
  afterEach(() => {
    act(() => {
      tabsStore.reset();
      resetWindowState();
      resetQueryWorkspaces();
    });
  });

  it('opens on the tab that was in front, with its query tabs and the active one back', async () => {
    placeRestoredTabs(
      {
        activeConnectionId: 'c1',
        servers: [
          {
            connectionId: 'c1',
            queryTabs: [
              { title: 'Query 1', sql: 'select 1', chart: null, savedQueryId: null },
              { title: 'Orders', sql: 'select * from orders where total > 10', chart: null, savedQueryId: 'q9' },
              { title: 'Gone', sql: 'select 3', chart: null, savedQueryId: 'q-deleted' },
            ],
            activeQueryTab: 1,
            workspaceTab: 'query',
          },
        ],
      },
      [savedConnection],
    );
    mocked.savedQueries.mockResolvedValue([
      {
        id: 'q9',
        connectionId: 'c1',
        name: 'Orders',
        sql: 'select * from orders',
        chart: null,
        createdAt: '2026-11-18T10:00:00Z',
        updatedAt: '2026-11-18T10:00:00Z',
      },
    ]);
    mocked.getSession.mockResolvedValue(sessionInfo);
    renderWorkspace();

    expect(await screen.findByRole('tab', { name: 'Query' })).toHaveAttribute('aria-selected', 'true');
    // The Schema tab was never in front, so it never mounted.
    expect(screen.queryByRole('button', { name: 'schema stand-in' })).not.toBeInTheDocument();

    const ws = getQueryWorkspace('s1');
    expect(ws.tabs.map((t) => t.title)).toEqual(['Query 1', 'Orders', 'Gone']);
    expect(ws.activeId).toBe(ws.tabs[1]!.id);
    expect(ws.counter).toBe(4);
    // Linked to the saved query as it is now: last session's edit shows as unsaved; a deleted one unlinks.
    await waitFor(() => expect(getQueryWorkspace('s1').tabs[1]!.saved?.sql).toBe('select * from orders'));
    expect(isDirty(getQueryWorkspace('s1').tabs[1]!)).toBe(true);
    expect(getQueryWorkspace('s1').tabs[2]!.saved).toBeNull();
    expect(mocked.savedQueries).toHaveBeenCalledWith('c1');

    // Once connected under its new sid, the window state keeps the same tabs.
    act(() => tabsStore.open(sessionInfo, { focus: false }));
    expect(snapshotWindowState().servers[0]).toMatchObject({
      connectionId: 'c1',
      activeQueryTab: 1,
      workspaceTab: 'query',
      queryTabs: [
        { title: 'Query 1', savedQueryId: null },
        { title: 'Orders', savedQueryId: 'q9' },
        { title: 'Gone', savedQueryId: null },
      ],
    });
  });
});
