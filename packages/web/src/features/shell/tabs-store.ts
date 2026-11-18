import { useSyncExternalStore } from 'react';
import type { ConnectionColor, SessionInfo } from '@kleos/shared';

/** One open connection: a window tab backed by one database session. */
export type ConnectionTab = {
  sid: string;
  connectionId: string;
  nickname: string;
  color: ConnectionColor;
  readOnly: boolean;
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

  /** The open tab for a favorite, if any. */
  findByConnection(connectionId: string): ConnectionTab | undefined {
    return state.tabs.find((t) => t.connectionId === connectionId);
  },

  /** Adds a tab for a freshly opened session (or focuses the one already open for it) and brings it to front. */
  open(session: SessionInfo): void {
    const existing = state.tabs.find((t) => t.sid === session.sid);
    if (existing) {
      set({ ...state, active: existing.sid });
      return;
    }
    const tab: ConnectionTab = {
      sid: session.sid,
      connectionId: session.connection.id,
      nickname: session.connection.nickname,
      color: session.connection.color,
      readOnly: session.connection.readOnly,
    };
    set({ tabs: [...state.tabs, tab], active: tab.sid });
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
   * Removes a tab and returns its sid so the caller can close the session. The tab to its
   * right comes to front, else the one to its left, else Connections.
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
