import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Providers, savedConnection, sessionInfo } from '@/features/workspace/test-workspace';
import type * as ApiModule from '@/lib/api';
import { api } from '@/lib/api';
import type { KleosBridge, ShellCommand } from '@/lib/bridge';
import { AppShell } from './app-shell';
import { HOME, tabsStore } from './tabs-store';

vi.mock('@/lib/api', async (importOriginal) => {
  const actual = await importOriginal<typeof ApiModule>();
  return {
    ...actual,
    api: {
      health: vi.fn(),
      listConnections: vi.fn(),
      closeSession: vi.fn(),
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
});
afterEach(() => {
  vi.clearAllMocks();
  delete window.kleos;
  act(() => tabsStore.reset());
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
