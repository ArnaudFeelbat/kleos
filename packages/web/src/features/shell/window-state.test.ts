import { kleosErrorCodes, type WindowState } from '@kleos/shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { addTab, getQueryWorkspace, resetQueryWorkspaces, setActiveTab, updateTab } from '@/features/query/store';
import { savedConnection, sessionInfo } from '@/features/workspace/test-workspace';
import { ApiError } from '@/lib/api';
import { HOME, restoreTabId, tabsStore } from './tabs-store';
import {
  claimRestore,
  dropRestore,
  persistWindowState,
  placeRestoredTabs,
  reconnectRestored,
  reportWorkspaceTab,
  resetWindowState,
  snapshotWindowState,
} from './window-state';

const shop = { ...savedConnection, id: 'c1', nickname: 'shop_dev' };
const analytics = { ...savedConnection, id: 'c2', nickname: 'analytics_prod', hasPassword: false };

function openSession(sid: string, connection = shop) {
  tabsStore.open({ ...sessionInfo, sid, connection });
}

beforeEach(() => {
  tabsStore.reset();
  resetQueryWorkspaces();
  resetWindowState();
});
afterEach(() => {
  vi.useRealTimers();
});

describe('snapshotWindowState', () => {
  it('keeps the servers in tab order, the one in front, and each one’s query tabs — never a session id', () => {
    openSession('sid-secret-1', shop);
    openSession('sid-secret-2', analytics);
    const first = getQueryWorkspace('sid-secret-1').tabs[0]!;
    updateTab('sid-secret-1', first.id, (t) => ({ ...t, sql: 'select 1' }));
    addTab('sid-secret-1', {
      title: 'Orders',
      sql: 'select * from orders',
      chart: { type: 'bar', x: 'day', y: ['n'] },
      saved: { id: 'q9', name: 'Orders', sql: 'select * from orders', chart: null },
    });
    reportWorkspaceTab('sid-secret-1', 'query');
    tabsStore.activate('sid-secret-1');

    const state = snapshotWindowState();
    expect(state).toEqual<WindowState>({
      activeConnectionId: 'c1',
      servers: [
        {
          connectionId: 'c1',
          queryTabs: [
            { title: 'Query 1', sql: 'select 1', chart: null, savedQueryId: null },
            {
              title: 'Orders',
              sql: 'select * from orders',
              chart: { type: 'bar', x: 'day', y: ['n'] },
              savedQueryId: 'q9',
            },
          ],
          activeQueryTab: 1,
          workspaceTab: 'query',
        },
        // Never opened its Query tab: nothing to keep but the server itself.
        { connectionId: 'c2', queryTabs: [], activeQueryTab: 0, workspaceTab: 'schema' },
      ],
    });
    expect(JSON.stringify(state)).not.toMatch(/sid-secret/);
  });

  it('says Connections was in front with a null favorite', () => {
    openSession('s1');
    tabsStore.activate(HOME);
    expect(snapshotWindowState().activeConnectionId).toBeNull();
  });
});

describe('persistWindowState', () => {
  it('saves ~800 ms after the last change, once, and not for changes it would not save', () => {
    vi.useFakeTimers();
    const save = vi.fn(async (_state: WindowState) => {});
    const stop = persistWindowState(save);

    openSession('s1');
    vi.advanceTimersByTime(500);
    const tab = getQueryWorkspace('s1').tabs[0]!;
    updateTab('s1', tab.id, (t) => ({ ...t, sql: 'select now()' }));
    vi.advanceTimersByTime(799);
    expect(save).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(save).toHaveBeenCalledTimes(1);
    expect(save.mock.calls[0]![0].servers[0]!.queryTabs[0]!.sql).toBe('select now()');

    // A result arriving touches the store but not what is saved.
    updateTab('s1', tab.id, (t) => ({ ...t, view: 'chart' }));
    vi.advanceTimersByTime(2000);
    expect(save).toHaveBeenCalledTimes(1);

    setActiveTab('s1', addTab('s1'));
    vi.advanceTimersByTime(800);
    expect(save).toHaveBeenCalledTimes(2);
    stop();
  });

  it('flushes right away when the window goes hidden or unloads', () => {
    vi.useFakeTimers();
    const save = vi.fn(async (_state: WindowState) => {});
    const stop = persistWindowState(save);
    openSession('s1');
    const visibility = vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden');
    document.dispatchEvent(new Event('visibilitychange'));
    expect(save).toHaveBeenCalledTimes(1);
    visibility.mockRestore();

    reportWorkspaceTab('s1', 'data');
    window.dispatchEvent(new Event('beforeunload'));
    expect(save).toHaveBeenCalledTimes(2);
    expect(save.mock.calls[1]![0].servers[0]!.workspaceTab).toBe('data');
    stop();
  });

  it('retries after a failed save instead of believing it was saved', async () => {
    vi.useFakeTimers();
    const save = vi.fn(async (_state: WindowState) => {});
    save.mockRejectedValueOnce(new Error('server busy'));
    const stop = persistWindowState(save);
    openSession('s1');
    await vi.advanceTimersByTimeAsync(800);
    expect(save).toHaveBeenCalledTimes(1);
    tabsStore.activate(HOME);
    tabsStore.activate('s1');
    await vi.advanceTimersByTimeAsync(800);
    expect(save).toHaveBeenCalledTimes(2);
    stop();
  });

  it('flushes a waiting change when stopped', () => {
    vi.useFakeTimers();
    const save = vi.fn(async (_state: WindowState) => {});
    const stop = persistWindowState(save);
    openSession('s1');
    stop();
    expect(save).toHaveBeenCalledTimes(1);
  });
});

describe('restoring the window', () => {
  const state: WindowState = {
    activeConnectionId: 'c2',
    servers: [
      {
        connectionId: 'c1',
        queryTabs: [{ title: 'Query 3', sql: 'select 3', chart: null, savedQueryId: null }],
        activeQueryTab: 0,
        workspaceTab: 'query',
      },
      { connectionId: 'c2', queryTabs: [], activeQueryTab: 0, workspaceTab: 'monitor' },
      { connectionId: 'gone', queryTabs: [], activeQueryTab: 0, workspaceTab: 'schema' },
    ],
  };

  it('puts the tabs back in order with the front one in front, and saves them unchanged meanwhile', () => {
    const servers = placeRestoredTabs(state, [shop, analytics]);
    expect(servers.map((s) => s.connectionId)).toEqual(['c1', 'c2']);
    expect(tabsStore.get().tabs.map((t) => [t.sid, t.restore])).toEqual([
      [restoreTabId('c1'), { state: 'connecting' }],
      [restoreTabId('c2'), { state: 'connecting' }],
    ]);
    expect(tabsStore.get().active).toBe(restoreTabId('c2'));
    expect(snapshotWindowState()).toEqual({ ...state, servers: state.servers.slice(0, 2) });
  });

  it('connects the front server first, quietly, and leaves one needing a password waiting in its tab', async () => {
    const servers = placeRestoredTabs(state, [shop, analytics]);
    const calls: string[] = [];
    const open = vi.fn(async (connectionId: string) => {
      calls.push(connectionId);
      if (connectionId === 'c2') {
        throw new ApiError(401, { code: kleosErrorCodes.passwordRequired, message: 'needs a password' });
      }
      return { ...sessionInfo, sid: 's-shop', connection: shop };
    });
    await reconnectRestored(servers, 'c2', open, vi.fn());

    expect(calls).toEqual(['c2', 'c1']);
    const [first, second] = tabsStore.get().tabs;
    expect(first).toEqual(expect.objectContaining({ sid: 's-shop', connectionId: 'c1' }));
    expect(first!.restore).toBeUndefined();
    expect(second!.restore).toEqual({ state: 'reconnect', reason: 'Its password isn’t saved in the Keychain.' });
    // The front tab stayed in front.
    expect(tabsStore.get().active).toBe(restoreTabId('c2'));
  });

  it('hands a workspace its query tabs once, and forgets a closed restored tab', () => {
    placeRestoredTabs(state, [shop, analytics]);
    expect(claimRestore('s-shop', 'c1')?.workspaceTab).toBe('query');
    expect(claimRestore('s-shop', 'c1')?.workspaceTab).toBe('query');
    expect(getQueryWorkspace('s-shop').tabs.map((t) => t.sql)).toEqual(['select 3']);

    dropRestore('c2');
    expect(claimRestore('s-analytics', 'c2')).toBeNull();
  });

  it('closes a session that came back after its tab was closed', async () => {
    const servers = placeRestoredTabs(state, [shop]);
    const close = vi.fn();
    const open = vi.fn(async () => {
      tabsStore.close(restoreTabId('c1'));
      return { ...sessionInfo, sid: 's-late', connection: shop };
    });
    await reconnectRestored(servers, null, open, close);
    expect(close).toHaveBeenCalledWith('s-late');
    expect(tabsStore.get().tabs).toEqual([]);
  });
});
