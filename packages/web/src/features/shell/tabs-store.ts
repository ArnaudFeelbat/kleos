import { useSyncExternalStore } from 'react';
import type { ConnectionColor, SavedConnection, SessionInfo } from '@kleos/shared';

/**
 * A restored server that has no session yet: reconnecting quietly in the background, or
 * waiting for the user (a password not in the Keychain, an SSH host to trust, a failure).
 */
export type RestoreStatus = { state: 'connecting' } | { state: 'reconnect'; reason: string };

/** One open connection: a window tab backed by one database session. */
export type ConnectionTab = {
  /** Session id; `restore:<connectionId>` while a restored tab has no session yet. */
  sid: string;
  connectionId: string;
  nickname: string;
  color: ConnectionColor;
  readOnly: boolean;
  /** Set only on a restored tab without a session (see RestoreStatus). */
  restore?: RestoreStatus;
};

export const HOME = 'home';
/** `home` is the Connections tab; any other value is the sid of a connection tab. */
export type ActiveTab = typeof HOME | string;

type State = { tabs: ConnectionTab[]; active: ActiveTab };

let state: State = { tabs: [], active: HOME };
const listeners = new Set<() => void>();

function set(next: State) {
  state = next;
  for (const listener of listeners) listener();
}

/** Tab id of a restored server until its session opens. */
export function restoreTabId(connectionId: string): string {
  return `restore:${connectionId}`;
}

function tabOf(c: Pick<SavedConnection, 'id' | 'nickname' | 'color' | 'readOnly'>, sid: string): ConnectionTab {
  return { sid, connectionId: c.id, nickname: c.nickname, color: c.color, readOnly: c.readOnly };
}

/**
 * The window's tabs: the Connections home plus one tab per connected server. Opening a
 * favorite that already has a tab focuses it instead (one tab per server).
 */
export const tabsStore = {
  get: (): State => state,

  subscribe(listener: () => void): () => void {
    listeners.add(listener);
    return () => listeners.delete(listener);
  },

  /** The open tab for a favorite, if any (a restored tab without a session included). */
  findByConnection(connectionId: string): ConnectionTab | undefined {
    return state.tabs.find((t) => t.connectionId === connectionId);
  },

  /**
   * Adds a tab for a freshly opened session (or focuses the one already open for it). A
   * restored tab of the same favorite is replaced in place, keeping its position. With
   * `focus: false` (quiet restore) the tab in front stays in front, unless it was that very
   * restored tab, which then simply gains its session.
   */
  open(session: SessionInfo, { focus = true }: { focus?: boolean } = {}): void {
    const existing = state.tabs.find((t) => t.sid === session.sid);
    if (existing) {
      if (focus) set({ ...state, active: existing.sid });
      return;
    }
    const tab = tabOf(session.connection, session.sid);
    const placeholder = state.tabs.findIndex((t) => t.restore && t.connectionId === session.connection.id);
    if (placeholder !== -1) {
      const old = state.tabs[placeholder]!;
      const tabs = state.tabs.map((t, i) => (i === placeholder ? tab : t));
      set({ tabs, active: focus || state.active === old.sid ? tab.sid : state.active });
      return;
    }
    set({ tabs: [...state.tabs, tab], active: focus ? tab.sid : state.active });
  },

  /**
   * Puts back the tabs of the last window, in order, before any of them is connected; each
   * starts "connecting". `activeConnectionId` comes to front (Connections when null or gone).
   */
  restore(connections: SavedConnection[], activeConnectionId: string | null): void {
    const known = new Set(state.tabs.map((t) => t.connectionId));
    const added = connections
      .filter((c) => !known.has(c.id))
      .map((c): ConnectionTab => ({ ...tabOf(c, restoreTabId(c.id)), restore: { state: 'connecting' } }));
    const tabs = [...state.tabs, ...added];
    const front = tabs.find((t) => t.connectionId === activeConnectionId);
    set({ tabs, active: front ? front.sid : state.active });
  },

  /** A restored tab could not reconnect by itself: it now waits for the user. */
  needsReconnect(connectionId: string, reason: string): void {
    const tabs = state.tabs.map((t) =>
      t.restore && t.connectionId === connectionId ? { ...t, restore: { state: 'reconnect' as const, reason } } : t,
    );
    set({ ...state, tabs });
  },

  activate(id: ActiveTab): void {
    if (id !== HOME && !state.tabs.some((t) => t.sid === id)) return;
    if (state.active !== id) set({ ...state, active: id });
  },

  /** ⌘1…⌘9: the n-th connection tab (1-based); 9 always means the last one. */
  activateIndex(n: number): void {
    const tab = n >= 9 ? state.tabs.at(-1) : state.tabs[n - 1];
    if (tab) this.activate(tab.sid);
  },

  /** ⌘⇧] / ⌘⇧[: cycles through Connections and every connection tab. */
  activateRelative(delta: 1 | -1): void {
    const order: ActiveTab[] = [HOME, ...state.tabs.map((t) => t.sid)];
    const at = Math.max(0, order.indexOf(state.active));
    const next = order[(at + delta + order.length) % order.length] ?? HOME;
    this.activate(next);
  },

  /**
   * Removes a tab and returns its sid so the caller can close the session (a restored tab
   * still without one has none to close). The tab to its right comes to front, else the one
   * to its left, else Connections.
   */
  close(sid: string): string | null {
    const index = state.tabs.findIndex((t) => t.sid === sid);
    if (index === -1) return null;
    const tabs = state.tabs.filter((t) => t.sid !== sid);
    let active = state.active;
    if (active === sid) active = (tabs[index] ?? tabs[index - 1])?.sid ?? HOME;
    set({ tabs, active });
    return sid;
  },

  /** Keeps tab labels in step with renamed or recoloured favorites. */
  syncConnections(connections: { id: string; nickname: string; color: ConnectionColor; readOnly: boolean }[]): void {
    let changed = false;
    const tabs = state.tabs.map((t) => {
      const c = connections.find((x) => x.id === t.connectionId);
      if (!c || (c.nickname === t.nickname && c.color === t.color && c.readOnly === t.readOnly)) return t;
      changed = true;
      return { ...t, nickname: c.nickname, color: c.color, readOnly: c.readOnly };
    });
    if (changed) set({ ...state, tabs });
  },

  /** Tests only. */
  reset(): void {
    set({ tabs: [], active: HOME });
  },
};

export function useTabs(): State {
  return useSyncExternalStore(tabsStore.subscribe, tabsStore.get);
}
