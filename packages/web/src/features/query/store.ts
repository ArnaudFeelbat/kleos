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
import { bindPlaceholders, type ParamValues } from './params';
import type { RunTarget } from './run-target';
import type { ScriptStatement } from './sql-script';

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
  /**
   * Run all only: the next statement of the script closed this result's cursor (a tab has one
   * client), so the rows loaded so far are all there is.
   */
  truncated?: boolean;
};

/** One statement of a Run all, and its run once it started. */
export type ScriptStep = {
  target: RunTarget;
  /** 1-based editor line of the statement's first code, and that line, for the statements list. */
  line: number;
  preview: string;
  /** Offset of the statement's first code (past leading comments). */
  codeFrom: number;
  run: RunState | null;
};

/** A Run all: every statement in order on the tab's client, stopping at the first error. */
export type ScriptState = {
  id: string;
  status: 'running' | 'done' | 'error' | 'cancelled';
  steps: ScriptStep[];
  /** The statement running, or the last one that ran. */
  current: number;
  /** The statement whose result is shown; null follows `current`. */
  selected: number | null;
  startedAt: number;
  elapsedMs: number | null;
  cancelRequested: boolean;
};

/** Something asked of a query tab from outside it (the ⌘K palette), done once the tab is on screen. */
export type PendingAction = { kind: 'run' } | { kind: 'insert'; text: string };

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
export type { ParamValues };

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
  /** The last Run all; while set, it is what the results show (`run` is then null). */
  script: ScriptState | null;
  /** Parameter values last used in this tab (seeded from the saved query's paramValues). */
  paramValues: ParamValues;
  pending: PendingAction | null;
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
    script: null,
    paramValues: {},
    pending: null,
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
      return { ...t, saved: ref, paramValues: { ...q?.paramValues, ...t.paramValues } };
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

/**
 * Opens a saved query (SQL and chart settings) in its own query tab, or brings back the tab
 * that already has it. Shared by the History/Saved panel and the ⌘K palette.
 */
export function openSavedQuery(sid: string, q: SavedQuery): string {
  const open = getQueryWorkspace(sid).tabs.find((t) => t.saved?.id === q.id);
  if (open) {
    // Values typed in this tab win over the ones the saved query remembers.
    if (q.paramValues) updateTab(sid, open.id, (t) => ({ ...t, paramValues: { ...q.paramValues, ...t.paramValues } }));
    setActiveTab(sid, open.id);
    return open.id;
  }
  return addTab(sid, {
    title: q.name,
    sql: q.sql,
    chart: q.chart,
    view: q.chart ? 'chart' : 'results',
    saved: { id: q.id, name: q.name, sql: q.sql, chart: q.chart },
    paramValues: { ...q.paramValues },
  });
}

/** Queues an action for a query tab; the Query tab does it when that tab is in front. */
export function requestTabAction(sid: string, tabId: string, action: PendingAction) {
  updateTab(sid, tabId, (t) => ({ ...t, pending: action }));
}

/** Takes (and clears) the tab's pending action. */
export function takeTabAction(sid: string, tabId: string): PendingAction | null {
  const action = getTab(sid, tabId)?.pending ?? null;
  if (action) updateTab(sid, tabId, (t) => ({ ...t, pending: null }));
  return action;
}

/** Opens `sql` from elsewhere (queryDraft) once per nonce. */
export function openDraft(sid: string, draft: { sql: string; nonce: number }) {
  if (getQueryWorkspace(sid).draftNonce === draft.nonce) return;
  setWorkspace(sid, (ws) => ({ ...ws, draftNonce: draft.nonce }));
  const active = getQueryWorkspace(sid).tabs.find((t) => t.id === getQueryWorkspace(sid).activeId);
  // Reuse an untouched empty tab rather than piling up blank ones.
  if (active && active.sql.trim() === '' && !active.run && !active.script && !active.saved) {
    updateTab(sid, active.id, (t) => ({ ...t, sql: draft.sql }));
  } else {
    addTab(sid, { sql: draft.sql });
  }
}

/** The statement of a Run all whose result is shown: the one picked, else the current one. */
export function shownStep(script: ScriptState): number {
  return script.selected ?? script.current;
}

/** The run whose result the tab shows: the shown statement of its Run all, else its last Run. */
export function shownRun(tab: QueryTabState): RunState | null {
  if (!tab.script) return tab.run;
  return tab.script.steps[shownStep(tab.script)]?.run ?? null;
}

/** True while a Run, a Run all or an Explain is in flight in the tab. */
export function isBusy(tab: QueryTabState): boolean {
  return tab.run?.status === 'running' || tab.explain?.status === 'running' || tab.script?.status === 'running';
}

/** Every run the tab holds: its single run and each statement of its Run all. */
function runsOf(tab: QueryTabState): RunState[] {
  const runs = tab.script ? tab.script.steps.map((s) => s.run) : [];
  return [tab.run, ...runs].filter((r): r is RunState => r !== null);
}

function runningQid(tab: QueryTabState): string | null {
  if (tab.explain?.status === 'running') return tab.explain.qid;
  return runsOf(tab).find((r) => r.status === 'running')?.qid ?? null;
}

/** Closes the server cursors the tab still holds (at most one: a tab has one client). */
function closeCursors(sid: string, tab: QueryTabState) {
  for (const r of runsOf(tab)) if (r.hasMore) void api.closeQuery(sid, r.qid).catch(() => undefined);
}

/** Applies `fn` to the tab's run with this qid, wherever it is (single run or a Run all statement). */
function updateRun(t: QueryTabState, qid: string, fn: (r: RunState) => RunState): QueryTabState {
  if (t.run?.qid === qid) return { ...t, run: fn(t.run) };
  const i = t.script?.steps.findIndex((s) => s.run?.qid === qid) ?? -1;
  if (!t.script || i === -1) return t;
  const steps = t.script.steps.map((s, j) => (j === i && s.run ? { ...s, run: fn(s.run) } : s));
  return { ...t, script: { ...t.script, steps } };
}

/** Closes a tab: cancels its running statement, closes its cursor and releases its client. */
export function closeTab(sid: string, tabId: string) {
  const tab = getTab(sid, tabId);
  if (!tab) return;
  const qid = runningQid(tab);
  if (qid) void api.cancelQuery(sid, qid).catch(() => undefined);
  closeCursors(sid, tab);
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

/**
 * The error as the editor needs it: a Postgres position in the SQL that was sent maps back to
 * the statement as written (`:name` placeholders were rewritten to `$n`).
 */
function errorBody(err: unknown, sourcePosition?: (position: number) => number): ApiErrorBody {
  const body = err instanceof ApiError ? err.body : { code: 'KLEOS_HTTP', message: errorText(err) };
  return sourcePosition && body.position !== undefined ? { ...body, position: sourcePosition(body.position) } : body;
}

function startRun(qid: string, target: RunTarget): RunState {
  return {
    status: 'running',
    qid,
    target,
    startedAt: Date.now(),
    columns: [],
    rows: [],
    hasMore: false,
    command: null,
    rowCount: null,
    elapsedMs: null,
    loadingMore: false,
    pageError: null,
    error: null,
  };
}

/** Sends one statement, its placeholders bound to `values`, and returns how it ended. */
async function execute(sid: string, tabId: string, run: RunState, values: ParamValues): Promise<RunState> {
  const bound = bindPlaceholders(run.target.sql, values);
  try {
    const started = await api.startQuery(sid, {
      qid: run.qid,
      sql: bound.sql,
      tabId,
      pageSize: RESULT_PAGE_SIZE,
      ...(bound.params.length > 0 ? { params: bound.params } : {}),
    });
    return {
      ...run,
      status: 'done',
      columns: started.columns,
      rows: started.rows,
      hasMore: started.hasMore,
      command: started.command,
      rowCount: started.rowCount,
      elapsedMs: started.elapsedMs,
    };
  } catch (err) {
    const body = errorBody(err, bound.sourcePosition);
    return {
      ...run,
      status: body.code === QUERY_CANCELED ? 'cancelled' : 'error',
      error: body,
      elapsedMs: Date.now() - run.startedAt,
    };
  }
}

/**
 * Runs a statement in a tab, its placeholders bound to `values`. The qid is generated before
 * the request so Cancel can reach the statement while the first page is still on its way.
 * Resolves with the finished run, or undefined when nothing ran or another run replaced it.
 */
export async function runQuery(
  sid: string,
  tabId: string,
  target: RunTarget,
  onSettled?: () => void,
  values: ParamValues = {},
): Promise<RunState | undefined> {
  const tab = getTab(sid, tabId);
  if (!tab || isBusy(tab)) return;
  closeCursors(sid, tab);
  const run = startRun(crypto.randomUUID(), target);
  updateTab(sid, tabId, (t) => ({ ...t, view: t.view === 'explain' ? 'results' : t.view, run, script: null }));
  try {
    const done = await execute(sid, tabId, run, values);
    if (getTab(sid, tabId)?.run?.qid !== run.qid) {
      if (done.hasMore) void api.closeQuery(sid, run.qid).catch(() => undefined);
      return;
    }
    updateTab(sid, tabId, (t) => ({ ...t, run: done }));
    return done;
  } finally {
    onSettled?.();
  }
}

/**
 * Run all: runs the statements one after the other on the tab's client, as if run one by one
 * (a BEGIN spans the statements after it), and stops at the first error or at Cancel. Each
 * statement gets only its own placeholders' values. `onStep` follows every statement (each is
 * recorded in History by the server).
 */
export async function runScript(
  sid: string,
  tabId: string,
  statements: ScriptStatement[],
  values: ParamValues = {},
  onStep?: () => void,
): Promise<ScriptState | undefined> {
  const tab = getTab(sid, tabId);
  if (!tab || isBusy(tab) || statements.length === 0) return;
  closeCursors(sid, tab);
  const id = crypto.randomUUID();
  const startedAt = Date.now();
  const steps: ScriptStep[] = statements.map((s) => ({
    target: { sql: s.text, from: s.from, to: s.to },
    line: s.line,
    preview: s.preview,
    codeFrom: s.codeFrom,
    run: null,
  }));
  updateTab(sid, tabId, (t) => ({
    ...t,
    view: t.view === 'explain' ? 'results' : t.view,
    run: null,
    script: {
      id,
      status: 'running',
      steps,
      current: 0,
      selected: null,
      startedAt,
      elapsedMs: null,
      cancelRequested: false,
    },
  }));
  const current = () => {
    const s = getTab(sid, tabId)?.script;
    return s?.id === id ? s : null;
  };
  const patch = (fn: (s: ScriptState) => ScriptState) =>
    updateTab(sid, tabId, (t) => (t.script?.id === id ? { ...t, script: fn(t.script) } : t));
  const setStep = (i: number, run: RunState) =>
    patch((s) => ({
      ...s,
      current: i,
      steps: s.steps.map((step, j) => {
        if (j === i) return { ...step, run };
        // Starting the next statement closes this one's cursor on the server: keep what loaded.
        if (j === i - 1 && step.run?.hasMore) return { ...step, run: { ...step.run, hasMore: false, truncated: true } };
        return step;
      }),
    }));

  let status: ScriptState['status'] = 'done';
  for (let i = 0; i < steps.length; i += 1) {
    if (!current()) return;
    if (current()!.cancelRequested) {
      status = 'cancelled';
      break;
    }
    const run = startRun(crypto.randomUUID(), steps[i]!.target);
    setStep(i, run);
    const done = await execute(sid, tabId, run, values);
    onStep?.();
    if (!current()) {
      if (done.hasMore) void api.closeQuery(sid, run.qid).catch(() => undefined);
      return;
    }
    setStep(i, done);
    if (done.status !== 'done') {
      status = done.status === 'cancelled' ? 'cancelled' : 'error';
      break;
    }
  }
  patch((s) => ({ ...s, status, elapsedMs: Date.now() - startedAt, cancelRequested: false }));
  return current() ?? undefined;
}

/** Shows the result of one statement of the tab's Run all. */
export function selectScriptStep(sid: string, tabId: string, index: number) {
  updateTab(sid, tabId, (t) =>
    t.script && index >= 0 && index < t.script.steps.length && t.script.steps[index]!.run
      ? { ...t, script: { ...t.script, selected: index } }
      : t,
  );
}

/** Fetches the next 500 rows of the result the tab shows, once at a time. */
export async function loadMore(sid: string, tabId: string) {
  const tab = getTab(sid, tabId);
  const run = tab ? shownRun(tab) : null;
  if (!run || run.status !== 'done' || !run.hasMore || run.loadingMore) return;
  const qid = run.qid;
  updateTab(sid, tabId, (t) => updateRun(t, qid, (r) => ({ ...r, loadingMore: true, pageError: null })));
  try {
    const page = await api.nextPage(sid, qid, RESULT_PAGE_SIZE);
    updateTab(sid, tabId, (t) =>
      updateRun(t, qid, (r) => ({
        ...r,
        rows: r.rows.concat(page.rows),
        hasMore: page.hasMore,
        rowCount: r.rows.length + page.rows.length,
        loadingMore: false,
      })),
    );
  } catch (err) {
    updateTab(sid, tabId, (t) => updateRun(t, qid, (r) => ({ ...r, loadingMore: false, pageError: errorText(err) })));
  }
}

/** Asks the server to cancel the tab's running statement or explain; a Run all also stops there. */
export async function cancelRunning(sid: string, tabId: string) {
  const tab = getTab(sid, tabId);
  if (!tab) return;
  if (tab.script?.status === 'running') {
    updateTab(sid, tabId, (t) => (t.script ? { ...t, script: { ...t.script, cancelRequested: true } } : t));
  }
  const qid = runningQid(tab);
  if (!qid) return;
  await api.cancelQuery(sid, qid);
}

export async function runExplain(
  sid: string,
  tabId: string,
  target: RunTarget,
  onSettled?: () => void,
  values: ParamValues = {},
) {
  const tab = getTab(sid, tabId);
  if (!tab || isBusy(tab)) return;
  const qid = crypto.randomUUID();
  const startedAt = Date.now();
  updateTab(sid, tabId, (t) => ({
    ...t,
    view: 'explain',
    explain: { status: 'running', qid, target, startedAt, result: null, error: null, elapsedMs: null },
  }));
  const isCurrent = () => getTab(sid, tabId)?.explain?.qid === qid;
  const bound = bindPlaceholders(target.sql, values);
  try {
    const result = await api.explain(sid, {
      qid,
      sql: bound.sql,
      tabId,
      ...(bound.params.length > 0 ? { params: bound.params } : {}),
    });
    if (!isCurrent()) return;
    updateTab(sid, tabId, (t) => ({
      ...t,
      explain: t.explain && { ...t.explain, status: 'done', result, elapsedMs: result.executionMs },
    }));
  } catch (err) {
    if (!isCurrent()) return;
    const body = errorBody(err, bound.sourcePosition);
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
