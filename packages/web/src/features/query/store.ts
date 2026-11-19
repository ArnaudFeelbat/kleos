import { useSyncExternalStore } from 'react';
import type {
  ApiErrorBody,
  CellValue,
  ChartSettings,
  ColumnMeta,
  ExplainResult,
  RestoredQueryTab,
  SavedQuery,
} from '@kleos/shared';
import { api, ApiError, errorText } from '@/lib/api';
import { sameChart } from './chart-data';
import type { RunTarget } from './run-target';

export const RESULT_PAGE_SIZE = 500;
/** SQLSTATE query_canceled: what a cancelled statement fails with. */
export const QUERY_CANCELED = '57014';

export type ResultView = 'results' | 'chart' | 'explain';

export type RunState = {
  status: 'running' | 'done' | 'error' | 'cancelled';
  qid: string;
  target: RunTarget;
  startedAt: number;
  columns: ColumnMeta[];
  rows: CellValue[][];
  hasMore: boolean;
  /** Command tag for statements without rows, e.g. "UPDATE 3". */
  command: string | null;
  rowCount: number | null;
  /** Server time of the first page; wall time for errors and cancels. */
  elapsedMs: number | null;
  loadingMore: boolean;
  pageError: string | null;
  error: ApiErrorBody | null;
};

export type ExplainState = {
  status: 'running' | 'done' | 'error' | 'cancelled';
  qid: string;
  target: RunTarget;
  startedAt: number;
  result: ExplainResult | null;
  error: ApiErrorBody | null;
  elapsedMs: number | null;
};

export type SavedRef = { id: string; name: string; sql: string; chart: ChartSettings | null };

export type QueryTabState = {
  /** Stable id, also the server-side tab id that owns a dedicated client. */
  id: string;
  title: string;
  sql: string;
  saved: SavedRef | null;
  /** Chart settings chosen by the user; null means "derive from the result". */
  chart: ChartSettings | null;
  view: ResultView;
  chartAsTable: boolean;
  run: RunState | null;
  explain: ExplainState | null;
};

export type QueryWorkspace = {
  tabs: QueryTabState[];
  activeId: string;
  /** Next "Query N" number. */
  counter: number;
  /** Last queryDraft nonce opened, so a remount does not open it twice. */
  draftNonce: number | null;
};

function newTab(counter: number, init: Partial<QueryTabState> = {}): QueryTabState {
  return {
    id: crypto.randomUUID(),
    title: `Query ${counter}`,
    sql: '',
    saved: null,
    chart: null,
    view: 'results',
    chartAsTable: false,
    run: null,
    explain: null,
    ...init,
  };
}

const workspaces = new Map<string, QueryWorkspace>();
const listeners = new Set<() => void>();

function emit() {
  for (const l of listeners) l();
}

export function getQueryWorkspace(sid: string): QueryWorkspace {
  let ws = workspaces.get(sid);
  if (!ws) {
    const first = newTab(1);
    ws = { tabs: [first], activeId: first.id, counter: 2, draftNonce: null };
    workspaces.set(sid, ws);
  }
  return ws;
}

function setWorkspace(sid: string, fn: (ws: QueryWorkspace) => QueryWorkspace) {
  const prev = getQueryWorkspace(sid);
  const next = fn(prev);
  if (next !== prev) {
    workspaces.set(sid, next);
    emit();
  }
}

/** Tests only: forget every session's tabs. */
export function resetQueryWorkspaces() {
  workspaces.clear();
  emit();
}

/** Notified on every change of any session's query tabs (the window state follows them). */
export function subscribeQueryWorkspaces(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** The session's query tabs if it has any yet, without creating the default "Query 1". */
export function peekQueryWorkspace(sid: string): QueryWorkspace | undefined {
  return workspaces.get(sid);
}

/** What the window remembers of one query tab: never results, only what the user wrote. */
export function persistedQueryTabs(ws: QueryWorkspace): { tabs: RestoredQueryTab[]; active: number } {
  return {
    tabs: ws.tabs.map((t) => ({ title: t.title, sql: t.sql, chart: t.chart, savedQueryId: t.saved?.id ?? null })),
    active: Math.max(
      0,
      ws.tabs.findIndex((t) => t.id === ws.activeId),
    ),
  };
}

/**
 * Puts back the query tabs of the last window for a freshly opened session. A tab from a saved
 * query is linked to it by id; its saved SQL is only known once `relinkSavedQueries` runs, so
 * until then it counts as unchanged. Does nothing without tabs.
 */
export function restoreQueryTabs(sid: string, restored: RestoredQueryTab[], activeIndex: number) {
  if (restored.length === 0) return;
  const numbers = restored.map((r) => /^Query (\d+)$/.exec(r.title)?.[1]).filter((n) => n !== undefined);
  const counter = Math.max(restored.length, ...numbers.map(Number)) + 1;
  const tabs = restored.map((r) =>
    newTab(0, {
      title: r.title,
      sql: r.sql,
      chart: r.chart,
      view: r.chart ? 'chart' : 'results',
      saved: r.savedQueryId ? { id: r.savedQueryId, name: r.title, sql: r.sql, chart: r.chart } : null,
    }),
  );
  const active = tabs[Math.min(Math.max(0, activeIndex), tabs.length - 1)]!;
  workspaces.set(sid, { tabs, activeId: active.id, counter, draftNonce: null });
  emit();
}

/**
 * Links restored tabs to their saved queries as they are now, so unsaved edits from the last
 * session show as such; a tab whose saved query is gone keeps its SQL as a plain tab.
 */
export function relinkSavedQueries(sid: string, saved: SavedQuery[]) {
  setWorkspace(sid, (ws) => {
    let changed = false;
    const tabs = ws.tabs.map((t) => {
      if (!t.saved) return t;
      const q = saved.find((s) => s.id === t.saved!.id);
      const ref: SavedRef | null = q ? { id: q.id, name: q.name, sql: q.sql, chart: q.chart } : null;
      changed = true;
      return { ...t, saved: ref };
    });
    return changed ? { ...ws, tabs } : ws;
  });
}

export function useQueryWorkspace(sid: string): QueryWorkspace {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => getQueryWorkspace(sid),
  );
}

export function getTab(sid: string, tabId: string): QueryTabState | undefined {
  return getQueryWorkspace(sid).tabs.find((t) => t.id === tabId);
}

export function updateTab(sid: string, tabId: string, fn: (t: QueryTabState) => QueryTabState) {
  setWorkspace(sid, (ws) => {
    let changed = false;
    const tabs = ws.tabs.map((t) => {
      if (t.id !== tabId) return t;
      const next = fn(t);
      changed = changed || next !== t;
      return next;
    });
    return changed ? { ...ws, tabs } : ws;
  });
}

export function isDirty(tab: QueryTabState): boolean {
  if (tab.saved) return tab.sql !== tab.saved.sql || !sameChart(tab.chart, tab.saved.chart);
  return tab.sql.trim() !== '';
}

/** A history entry loads without asking when the tab is empty or already holds that SQL. */
export function historyLoadsDirectly(currentSql: string, entrySql: string): boolean {
  return currentSql.trim() === '' || currentSql.trim() === entrySql.trim();
}

export function setActiveTab(sid: string, tabId: string) {
  setWorkspace(sid, (ws) => (ws.activeId === tabId ? ws : { ...ws, activeId: tabId }));
}

/** Opens a new query tab after the active one and switches to it. Returns its id. */
export function addTab(sid: string, init: Partial<QueryTabState> = {}): string {
  let id = '';
  setWorkspace(sid, (ws) => {
    const tab = newTab(ws.counter, init);
    id = tab.id;
    const at = ws.tabs.findIndex((t) => t.id === ws.activeId);
    const tabs = [...ws.tabs];
    tabs.splice(at + 1, 0, tab);
    return { ...ws, tabs, activeId: tab.id, counter: ws.counter + 1 };
  });
  return id;
}

/** Opens `sql` from elsewhere (queryDraft) once per nonce. */
/**
 * Opens a saved query (SQL and chart settings) in its own query tab, or brings back the tab
 * that already has it. Shared by the History/Saved panel and the ⌘K palette.
 */
export function openSavedQuery(sid: string, q: SavedQuery): void {
  const open = getQueryWorkspace(sid).tabs.find((t) => t.saved?.id === q.id);
  if (open) {
    setActiveTab(sid, open.id);
    return;
  }
  addTab(sid, {
    title: q.name,
    sql: q.sql,
    chart: q.chart,
    view: q.chart ? 'chart' : 'results',
    saved: { id: q.id, name: q.name, sql: q.sql, chart: q.chart },
  });
}

export function openDraft(sid: string, draft: { sql: string; nonce: number }) {
  if (getQueryWorkspace(sid).draftNonce === draft.nonce) return;
  setWorkspace(sid, (ws) => ({ ...ws, draftNonce: draft.nonce }));
  const active = getQueryWorkspace(sid).tabs.find((t) => t.id === getQueryWorkspace(sid).activeId);
  // Reuse an untouched empty tab rather than piling up blank ones.
  if (active && active.sql.trim() === '' && !active.run && !active.saved) {
    updateTab(sid, active.id, (t) => ({ ...t, sql: draft.sql }));
  } else {
    addTab(sid, { sql: draft.sql });
  }
}

/** Closes a tab: cancels its running statement, closes its cursor and releases its client. */
export function closeTab(sid: string, tabId: string) {
  const tab = getTab(sid, tabId);
  if (!tab) return;
  if (tab.run?.status === 'running' || tab.explain?.status === 'running') {
    const qid = tab.run?.status === 'running' ? tab.run.qid : tab.explain!.qid;
    void api.cancelQuery(sid, qid).catch(() => undefined);
  }
  if (tab.run?.hasMore) void api.closeQuery(sid, tab.run.qid).catch(() => undefined);
  void api.closeTab(sid, tabId).catch(() => undefined);
  setWorkspace(sid, (ws) => {
    const idx = ws.tabs.findIndex((t) => t.id === tabId);
    let tabs = ws.tabs.filter((t) => t.id !== tabId);
    let counter = ws.counter;
    if (tabs.length === 0) {
      tabs = [newTab(counter)];
      counter += 1;
    }
    const activeId = ws.activeId === tabId ? (tabs[Math.min(idx, tabs.length - 1)] ?? tabs[0]!).id : ws.activeId;
    return { ...ws, tabs, activeId, counter };
  });
}

function errorBody(err: unknown): ApiErrorBody {
  return err instanceof ApiError ? err.body : { code: 'KLEOS_HTTP', message: errorText(err) };
}

/**
 * Runs a statement in a tab. The qid is generated before the request so Cancel can reach
 * the statement while the first page is still on its way.
 */
export async function runQuery(sid: string, tabId: string, target: RunTarget, onSettled?: () => void) {
  const tab = getTab(sid, tabId);
  if (!tab || tab.run?.status === 'running') return;
  if (tab.run?.hasMore) void api.closeQuery(sid, tab.run.qid).catch(() => undefined);
  const qid = crypto.randomUUID();
  const startedAt = Date.now();
  updateTab(sid, tabId, (t) => ({
    ...t,
    view: t.view === 'explain' ? 'results' : t.view,
    run: {
      status: 'running',
      qid,
      target,
      startedAt,
      columns: [],
      rows: [],
      hasMore: false,
      command: null,
      rowCount: null,
      elapsedMs: null,
      loadingMore: false,
      pageError: null,
      error: null,
    },
  }));
  const isCurrent = () => getTab(sid, tabId)?.run?.qid === qid;
  try {
    const started = await api.startQuery(sid, { qid, sql: target.sql, tabId, pageSize: RESULT_PAGE_SIZE });
    if (!isCurrent()) {
      if (started.hasMore) void api.closeQuery(sid, qid).catch(() => undefined);
      return;
    }
    updateTab(sid, tabId, (t) => ({
      ...t,
      run: t.run && {
        ...t.run,
        status: 'done',
        columns: started.columns,
        rows: started.rows,
        hasMore: started.hasMore,
        command: started.command,
        rowCount: started.rowCount,
        elapsedMs: started.elapsedMs,
      },
    }));
  } catch (err) {
    if (!isCurrent()) return;
    const body = errorBody(err);
    updateTab(sid, tabId, (t) => ({
      ...t,
      run: t.run && {
        ...t.run,
        status: body.code === QUERY_CANCELED ? 'cancelled' : 'error',
        error: body,
        elapsedMs: Date.now() - startedAt,
      },
    }));
  } finally {
    onSettled?.();
  }
}

/** Fetches the next 500 rows of the tab's result, once at a time. */
export async function loadMore(sid: string, tabId: string) {
  const run = getTab(sid, tabId)?.run;
  if (!run || run.status !== 'done' || !run.hasMore || run.loadingMore) return;
  const qid = run.qid;
  updateTab(sid, tabId, (t) => (t.run ? { ...t, run: { ...t.run, loadingMore: true, pageError: null } } : t));
  try {
    const page = await api.nextPage(sid, qid, RESULT_PAGE_SIZE);
    updateTab(sid, tabId, (t) =>
      t.run?.qid === qid
        ? {
            ...t,
            run: {
              ...t.run,
              rows: t.run.rows.concat(page.rows),
              hasMore: page.hasMore,
              rowCount: t.run.rows.length + page.rows.length,
              loadingMore: false,
            },
          }
        : t,
    );
  } catch (err) {
    updateTab(sid, tabId, (t) =>
      t.run?.qid === qid ? { ...t, run: { ...t.run, loadingMore: false, pageError: errorText(err) } } : t,
    );
  }
}

/** Asks the server to cancel the tab's running statement or explain. */
export async function cancelRunning(sid: string, tabId: string) {
  const tab = getTab(sid, tabId);
  const qid =
    tab?.run?.status === 'running' ? tab.run.qid : tab?.explain?.status === 'running' ? tab.explain.qid : null;
  if (!qid) return;
  await api.cancelQuery(sid, qid);
}

export async function runExplain(sid: string, tabId: string, target: RunTarget, onSettled?: () => void) {
  const tab = getTab(sid, tabId);
  if (!tab || tab.explain?.status === 'running' || tab.run?.status === 'running') return;
  const qid = crypto.randomUUID();
  const startedAt = Date.now();
  updateTab(sid, tabId, (t) => ({
    ...t,
    view: 'explain',
    explain: { status: 'running', qid, target, startedAt, result: null, error: null, elapsedMs: null },
  }));
  const isCurrent = () => getTab(sid, tabId)?.explain?.qid === qid;
  try {
    const result = await api.explain(sid, { qid, sql: target.sql, tabId });
    if (!isCurrent()) return;
    updateTab(sid, tabId, (t) => ({
      ...t,
      explain: t.explain && { ...t.explain, status: 'done', result, elapsedMs: result.executionMs },
    }));
  } catch (err) {
    if (!isCurrent()) return;
    const body = errorBody(err);
    updateTab(sid, tabId, (t) => ({
      ...t,
      explain: t.explain && {
        ...t.explain,
        status: body.code === QUERY_CANCELED ? 'cancelled' : 'error',
        error: body,
        elapsedMs: Date.now() - startedAt,
      },
    }));
  } finally {
    onSettled?.();
  }
}
