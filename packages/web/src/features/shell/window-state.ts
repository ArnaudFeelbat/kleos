import {
  kleosErrorCodes,
  type RestoredServer,
  type SavedConnection,
  type SessionInfo,
  type WindowState,
} from '@kleos/shared';
import {
  peekQueryWorkspace,
  persistedQueryTabs,
  restoreQueryTabs,
  subscribeQueryWorkspaces,
} from '@/features/query/store';
import type { WorkspaceTab } from '@/features/workspace/context';
import { ApiError, errorText } from '@/lib/api';
import { HOME, tabsStore } from './tabs-store';

/*
 * The window as it was at the last quit: which servers were open, in which order, which one
 * was in front, and in each server its query tabs and workspace tab. Saved to the local server
 * (never a password or a session id) and put back on launch.
 */

/** Restored servers whose workspace has not mounted yet, by favorite id. */
const pending = new Map<string, RestoredServer>();
/** What each restored workspace was handed, by sid (a remount gets the same answer). */
const claimed = new Map<string, RestoredServer>();
/** Workspace tab in front in each session (owned by the workspace, reported here). */
const workspaceTabs = new Map<string, WorkspaceTab>();
const listeners = new Set<() => void>();

function emit() {
  for (const l of listeners) l();
}

/**
 * Called by a workspace as it first renders: hands it what the last window had for its
 * favorite, once, and puts the query tabs back into the query store right away so the Query
 * tab opens on them. Null when the server was not restored.
 */
export function claimRestore(sid: string, connectionId: string): RestoredServer | null {
  const done = claimed.get(sid);
  if (done) return done;
  const server = pending.get(connectionId);
  if (!server) return null;
  pending.delete(connectionId);
  claimed.set(sid, server);
  restoreQueryTabs(sid, server.queryTabs, server.activeQueryTab);
  return server;
}

/** A restored tab closed before it connected: forget its tabs. */
export function dropRestore(connectionId: string): void {
  if (pending.delete(connectionId)) emit();
}

export function reportWorkspaceTab(sid: string, tab: WorkspaceTab): void {
  if (workspaceTabs.get(sid) === tab) return;
  workspaceTabs.set(sid, tab);
  emit();
}

/** The window as it is now, in the shape saved by PUT /window-state. */
export function snapshotWindowState(): WindowState {
  const { tabs, active } = tabsStore.get();
  const servers = tabs.map((t): RestoredServer => {
    // Not connected yet, or connected but its workspace hasn't taken the restored tabs: keep them as they were.
    const waiting = pending.get(t.connectionId);
    if (waiting) return waiting;
    const ws = t.restore ? undefined : peekQueryWorkspace(t.sid);
    const query = ws ? persistedQueryTabs(ws) : { tabs: [], active: 0 };
    return {
      connectionId: t.connectionId,
      queryTabs: query.tabs,
      activeQueryTab: query.active,
      workspaceTab: workspaceTabs.get(t.sid) ?? claimed.get(t.sid)?.workspaceTab ?? 'schema',
    };
  });
  const front = active === HOME ? undefined : tabs.find((t) => t.sid === active);
  return { servers, activeConnectionId: front?.connectionId ?? null };
}

/**
 * Saves the window state whenever it changes, `delayMs` after the last change, and right away
 * when the window is about to close or goes hidden (best effort: the request may not finish).
 * Returns the stop function, which flushes a change still waiting.
 */
export function persistWindowState(save: (state: WindowState) => Promise<void>, delayMs = 800): () => void {
  let last = JSON.stringify(snapshotWindowState());
  let timer: ReturnType<typeof setTimeout> | null = null;

  const flush = () => {
    if (timer) clearTimeout(timer);
    timer = null;
    const state = snapshotWindowState();
    const json = JSON.stringify(state);
    if (json === last) return;
    last = json;
    // Called right away (an unloading page has no later turn); a throw counts as a failed save.
    let saving: Promise<void>;
    try {
      saving = save(state);
    } catch (err) {
      saving = Promise.reject(err);
    }
    saving.catch(() => {
      // Retry with the next change rather than believe it was saved.
      if (last === json) last = '';
    });
  };

  const onChange = () => {
    // Query results also notify the store; only what would be saved restarts the countdown.
    if (!timer && JSON.stringify(snapshotWindowState()) === last) return;
    if (timer) clearTimeout(timer);
    timer = setTimeout(flush, delayMs);
  };
  const onVisibility = () => {
    if (document.visibilityState === 'hidden') flush();
  };

  const unsubscribe = [tabsStore.subscribe(onChange), subscribeQueryWorkspaces(onChange), subscribe(onChange)];
  window.addEventListener('beforeunload', flush);
  document.addEventListener('visibilitychange', onVisibility);
  return () => {
    for (const u of unsubscribe) u();
    window.removeEventListener('beforeunload', flush);
    document.removeEventListener('visibilitychange', onVisibility);
    flush();
  };
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Why a restored server could not reconnect by itself, said calmly in its tab. */
export function reconnectReason(err: unknown): string {
  const code = err instanceof ApiError ? err.body.code : null;
  switch (code) {
    case kleosErrorCodes.passwordRequired:
      return 'Its password isn’t saved in the Keychain.';
    case kleosErrorCodes.sshPassphraseRequired:
      return 'The passphrase of its SSH key isn’t saved in the Keychain.';
    case kleosErrorCodes.sshHostUnknown:
      return 'The SSH server’s host key needs your approval.';
    case kleosErrorCodes.sshHostChanged:
      return 'The SSH server’s host key has changed since you trusted it.';
    default:
      return `Could not reconnect: ${errorText(err)}`;
  }
}

/**
 * Puts back the tabs of the last window (deleted favorites are already gone from `state`;
 * unknown ones are skipped), the one in front included, all waiting to connect. Returns the
 * servers placed, for `reconnectRestored`.
 */
export function placeRestoredTabs(state: WindowState, favorites: SavedConnection[]): RestoredServer[] {
  const servers = state.servers.filter((s) => favorites.some((f) => f.id === s.connectionId));
  if (servers.length === 0) return [];
  for (const s of servers) pending.set(s.connectionId, s);
  tabsStore.restore(
    servers.map((s) => favorites.find((f) => f.id === s.connectionId)!),
    state.activeConnectionId,
  );
  return servers;
}

/**
 * Connects the restored tabs one after the other, the one in front first, without prompting
 * and without taking the focus. A server that needs the user (password, passphrase, host key)
 * or fails waits in its tab with the reason and a Connect button.
 */
export async function reconnectRestored(
  servers: RestoredServer[],
  activeConnectionId: string | null,
  openSession: (connectionId: string) => Promise<SessionInfo>,
  closeSession: (sid: string) => void,
): Promise<void> {
  const order = [...servers].sort(
    (a, b) => Number(b.connectionId === activeConnectionId) - Number(a.connectionId === activeConnectionId),
  );
  const waiting = (connectionId: string) => tabsStore.findByConnection(connectionId)?.restore !== undefined;
  for (const { connectionId } of order) {
    // Closed, or connected by hand, meanwhile.
    if (!waiting(connectionId)) continue;
    try {
      const session = await openSession(connectionId);
      if (waiting(connectionId)) tabsStore.open(session, { focus: false });
      else closeSession(session.sid);
    } catch (err) {
      if (waiting(connectionId)) tabsStore.needsReconnect(connectionId, reconnectReason(err));
    }
  }
}

/** Tests only. */
export function resetWindowState(): void {
  pending.clear();
  claimed.clear();
  workspaceTabs.clear();
  emit();
}
