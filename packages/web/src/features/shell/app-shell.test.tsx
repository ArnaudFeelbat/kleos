import { defaultSettings } from '@kleos/shared';
import { idleUpdateState } from '@/test/bridge-defaults';
import { emptyWindowState, kleosErrorCodes } from '@kleos/shared';
import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Providers, savedConnection, sessionInfo } from '@/features/workspace/test-workspace';
import type * as ApiModule from '@/lib/api';
import { api, ApiError } from '@/lib/api';
import type { KleosBridge, ShellCommand } from '@/lib/bridge';
import { AppShell } from './app-shell';
import { HOME, restoreTabId, tabsStore } from './tabs-store';
import { resetWindowRestore } from './use-window-restore';
import { resetWindowState } from './window-state';

vi.mock('@/lib/api', async (importOriginal) => {
  const actual = await importOriginal<typeof ApiModule>();
  return {
    ...actual,
    api: {
      health: vi.fn(),
      listConnections: vi.fn(),
      closeSession: vi.fn(),
      openSession: vi.fn(),
      updateConnection: vi.fn(),
      getWindowState: vi.fn(),
      saveWindowState: vi.fn(),
    },
  };
});
vi.mock('@/features/connections/connections-screen', () => ({
  ConnectionsScreen: () => <p>connections stand-in</p>,
}));
vi.mock('@/features/workspace/workspace-screen', () => ({
  WorkspaceScreen: ({ sid, visible }: { sid: string; visible: boolean }) => (
    <p>
      workspace {sid} {visible ? 'front' : 'back'}
    </p>
  ),
}));

const mocked = vi.mocked(api);
let send: ((command: ShellCommand) => void) | null = null;
const bridge = {
  apiBase: '',
  token: '',
  platform: 'darwin',
  vibrancy: true,
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
  onCommand: vi.fn((listener: (command: ShellCommand) => void) => {
    send = listener;
    return () => {
      send = null;
    };
  }),
} satisfies KleosBridge;

function open(sid: string, id: string, nickname: string) {
  act(() => tabsStore.open({ ...sessionInfo, sid, connection: { ...savedConnection, id, nickname, color: 'green' } }));
}

beforeEach(() => {
  window.kleos = bridge;
  mocked.health.mockResolvedValue({ ok: true, version: '0.1.0' });
  mocked.listConnections.mockResolvedValue([]);
  mocked.closeSession.mockResolvedValue(undefined);
  mocked.getWindowState.mockResolvedValue(emptyWindowState);
  mocked.saveWindowState.mockResolvedValue(undefined);
});
afterEach(() => {
  vi.clearAllMocks();
  delete window.kleos;
  act(() => {
    tabsStore.reset();
    resetWindowState();
  });
  resetWindowRestore();
});

function renderShell() {
  return render(
    <Providers>
      <AppShell />
    </Providers>,
  );
}

describe('AppShell', { timeout: 15_000 }, () => {
  it('opens on Connections and reports the local server', async () => {
    renderShell();
    expect(screen.getByText('connections stand-in')).toBeVisible();
    await waitFor(() => expect(screen.getByTestId('health')).toHaveTextContent('Server ok · v0.1.0'));
    expect(screen.getByRole('button', { name: 'Connections' })).toHaveAttribute('aria-current', 'page');
  });

  it('shows one tab per server, keeps every workspace mounted and only the front one visible', async () => {
    renderShell();
    open('s1', 'c1', 'shop_dev');
    open('s2', 'c2', 'analytics_prod');
    const strip = screen.getByRole('navigation', { name: 'Open connections' });
    expect(within(strip).getByRole('button', { name: 'analytics_prod' })).toHaveAttribute('aria-current', 'page');
    expect(screen.getByText('workspace s2 front')).toBeVisible();
    expect(screen.getByText('workspace s1 back')).toBeInTheDocument();
    await waitFor(() => expect(bridge.setTitle).toHaveBeenLastCalledWith('analytics_prod — Kleos'));

    await userEvent.click(within(strip).getByRole('button', { name: 'shop_dev' }));
    expect(screen.getByText('workspace s1 front')).toBeInTheDocument();
  });

  it('closing a tab closes its session and fronts the neighbour', async () => {
    renderShell();
    open('s1', 'c1', 'shop_dev');
    open('s2', 'c2', 'analytics_prod');
    await userEvent.click(screen.getByRole('button', { name: 'Close analytics_prod' }));
    expect(mocked.closeSession).toHaveBeenCalledWith('s2');
    expect(tabsStore.get().active).toBe('s1');
    expect(screen.queryByText(/workspace s2/)).not.toBeInTheDocument();
  });

  it('follows menu commands: ⌘T, ⌘W, ⌘1…9 and next/previous', async () => {
    renderShell();
    open('s1', 'c1', 'one');
    open('s2', 'c2', 'two');
    act(() => send?.('select-tab-1'));
    expect(tabsStore.get().active).toBe('s1');
    act(() => send?.('next-tab'));
    expect(tabsStore.get().active).toBe('s2');
    act(() => send?.('new-tab'));
    expect(tabsStore.get().active).toBe(HOME);
    act(() => send?.('close-tab'));
    expect(bridge.closeWindow).toHaveBeenCalled();
    act(() => send?.('select-tab-9'));
    act(() => send?.('close-tab'));
    expect(mocked.closeSession).toHaveBeenCalledWith('s2');
  });
});

describe('AppShell — restoring the last window', { timeout: 15_000 }, () => {
  const shop = { ...savedConnection, id: 'c1', nickname: 'shop_dev' };
  const analytics = { ...savedConnection, id: 'c2', nickname: 'analytics_prod', hasPassword: false };

  beforeEach(() => {
    mocked.listConnections.mockResolvedValue([shop, analytics]);
    mocked.getWindowState.mockResolvedValue({
      activeConnectionId: 'c1',
      servers: [
        { connectionId: 'c1', queryTabs: [], activeQueryTab: 0, workspaceTab: 'schema' },
        { connectionId: 'c2', queryTabs: [], activeQueryTab: 0, workspaceTab: 'query' },
      ],
    });
    mocked.openSession.mockImplementation(async (req) => {
      if (req.connectionId === 'c1') return { ...sessionInfo, sid: 's-shop', connection: shop };
      if (!req.password) {
        throw new ApiError(401, { code: kleosErrorCodes.passwordRequired, message: 'needs a password' });
      }
      return { ...sessionInfo, sid: 's-analytics', connection: analytics };
    });
  });

  it('reconnects quietly, keeps the front tab in front, and leaves a server without a saved password waiting', async () => {
    const user = userEvent.setup();
    renderShell();
    const strip = screen.getByRole('navigation', { name: 'Open connections' });

    expect(await screen.findByText('workspace s-shop front')).toBeInTheDocument();
    expect(within(strip).getByRole('button', { name: 'shop_dev' })).toHaveAttribute('aria-current', 'page');
    expect(mocked.openSession).toHaveBeenCalledWith({ connectionId: 'c1' });
    expect(mocked.openSession).toHaveBeenCalledWith({ connectionId: 'c2' });
    await waitFor(() =>
      expect(tabsStore.findByConnection('c2')?.restore).toEqual({
        state: 'reconnect',
        reason: 'Its password isn’t saved in the Keychain.',
      }),
    );
    // No prompt pops up by itself at launch.
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();

    await user.click(within(strip).getByRole('button', { name: 'analytics_prod' }));
    const waiting = screen.getByRole('region', { name: 'Reconnect analytics_prod' });
    expect(waiting).toHaveTextContent('Its password isn’t saved in the Keychain.');

    await user.click(within(waiting).getByRole('button', { name: 'Connect' }));
    const dialog = await screen.findByRole('dialog');
    expect(dialog).toHaveTextContent('Password for analytics_prod');
    await user.type(within(dialog).getByLabelText('Password'), 'hunter2{Enter}');

    expect(await screen.findByText('workspace s-analytics front')).toBeInTheDocument();
    expect(mocked.openSession).toHaveBeenLastCalledWith({ connectionId: 'c2', password: 'hunter2' });
    // Replaced in place: still second, and no extra tab.
    expect(tabsStore.get().tabs.map((t) => t.sid)).toEqual(['s-shop', 's-analytics']);
  });

  it('saves the window once restored, never with a session id', async () => {
    renderShell();
    await screen.findByText('workspace s-shop front');
    await waitFor(() => expect(tabsStore.findByConnection('c2')?.restore?.state).toBe('reconnect'));
    act(() => tabsStore.activate(restoreTabId('c2')));
    await waitFor(() => expect(mocked.saveWindowState).toHaveBeenCalled(), { timeout: 3000 });
    const saved = mocked.saveWindowState.mock.calls.at(-1)![0];
    expect(saved.activeConnectionId).toBe('c2');
    expect(saved.servers.map((s) => s.connectionId)).toEqual(['c1', 'c2']);
    expect(saved.servers[1]!.workspaceTab).toBe('query');
    expect(JSON.stringify(saved)).not.toMatch(/s-shop/);
  });

  it('closing a waiting tab closes no session', async () => {
    const user = userEvent.setup();
    renderShell();
    await waitFor(() => expect(tabsStore.findByConnection('c2')?.restore?.state).toBe('reconnect'));
    await user.click(screen.getByRole('button', { name: 'Close analytics_prod' }));
    expect(tabsStore.findByConnection('c2')).toBeUndefined();
    expect(mocked.closeSession).not.toHaveBeenCalled();
  });
});
