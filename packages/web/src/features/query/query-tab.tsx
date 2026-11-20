import { useMutation, useQueryClient } from '@tanstack/react-query';
import type { EditorView } from '@codemirror/view';
import {
  ChartLine,
  CircleCheck,
  CircleSlash,
  CircleX,
  Code,
  Copy,
  Info,
  ListTree,
  ListVideo,
  LoaderCircle,
  PanelRight,
  Play,
  Plus,
  Save,
  Square,
  Table2,
  WandSparkles,
  X,
} from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState, type PointerEvent } from 'react';
import { toast } from 'sonner';
import type { ApiErrorBody, ChartSettings, HistoryEntry, SavedQuery } from '@kleos/shared';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { Button } from '@/components/ui/button';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { kbdOnPrimary, segmentedItem, segmentedList } from '@/features/common/styles';
import { copyText, formatRows } from '@/features/grid/copy';
import { useWorkspace } from '@/features/workspace/context';
import { api, errorText, queryKeys } from '@/lib/api';
import { formatInt, formatMs } from '@/lib/format';
import { cn } from '@/lib/utils';
import { defaultChartSettings } from './chart-data';
import { ChartView } from './chart-view';
import { errorRange, lineColumn } from './error-position';
import { ExplainView } from './explain-view';
import { formatInEditor } from './format-sql';
import { NameDialog } from './name-dialog';
import { ParamDialog } from './param-dialog';
import { placeholderKeys, type ParamValues } from './params';
import { ResultsExportMenu, ResultsView } from './results-view';
import { lineSpan, runTarget, type RunTarget } from './run-target';
import { buildSqlNamespace } from './schema-completion';
import { ScriptList } from './script-results';
import { SidePanel } from './side-panel';
import { SqlEditor, type ErrorMark } from './sql-editor';
import { splitScript, type ScriptStatement } from './sql-script';
import {
  addTab,
  cancelRunning,
  closeTab,
  getTab,
  historyLoadsDirectly,
  isBusy,
  isDirty,
  loadMore,
  openDraft,
  openSavedQuery,
  runExplain,
  runQuery,
  runScript,
  selectScriptStep,
  setActiveTab,
  shownRun,
  shownStep,
  takeTabAction,
  updateTab,
  useQueryWorkspace,
  type QueryTabState,
  type ResultView,
  type ScriptState,
  type ScriptStep,
} from './store';

const isMac = typeof navigator !== 'undefined' && /Mac/.test(navigator.platform);
const keys = isMac
  ? { run: '⌘↵', runAll: '⇧⌘↵', explain: '⌘E', save: '⌘S', format: '⇧⌥F' }
  : { run: 'Ctrl+↵', runAll: 'Shift+Ctrl+↵', explain: 'Ctrl+E', save: 'Ctrl+S', format: 'Shift+Alt+F' };

/** What Run, Run all and Explain hand to the parameter prompt, then execute. */
type Launch =
  | { kind: 'run'; target: RunTarget }
  | { kind: 'explain'; target: RunTarget }
  | { kind: 'script'; statements: ScriptStatement[] };

type ParamPrompt = { launch: Launch; keys: string[]; tabId: string };

function launchKeys(launch: Launch): string[] {
  return placeholderKeys(launch.kind === 'script' ? launch.statements.map((s) => s.text) : launch.target.sql);
}

function sameValues(a: ParamValues, b: ParamValues): boolean {
  const ka = Object.keys(a);
  return ka.length === Object.keys(b).length && ka.every((k) => k in b && a[k] === b[k]);
}

/** Ticks while `active`, so elapsed times count up during a run. */
function useNow(active: boolean): number {
  const [now, setNow] = useState(0);
  useEffect(() => {
    if (!active) return;
    const tick = () => setNow(Date.now());
    const first = setTimeout(tick, 0);
    const id = setInterval(tick, 100);
    return () => {
      clearTimeout(first);
      clearInterval(id);
    };
  }, [active]);
  return now;
}

/**
 * Underline range for an error with a position, relative to the statement that ran. A Run all
 * error without one marks its statement's first line, so the failing statement of a long
 * script is easy to find.
 */
function errorMarkOf(
  error: ApiErrorBody | null | undefined,
  target: RunTarget | undefined,
  step?: ScriptStep,
): ErrorMark | null {
  if (!error || !target) return null;
  const message = `${error.code} ${error.message}`;
  if (error.position === undefined) {
    if (!step) return null;
    const lineEnd = step.target.sql.indexOf('\n', step.codeFrom - step.target.from);
    const to = lineEnd === -1 ? step.target.to : step.target.from + lineEnd;
    return { from: step.codeFrom, to: Math.max(to, step.codeFrom + 1), message };
  }
  const r = errorRange(target.sql, 0, target.sql, error.position);
  return { from: target.from + r.from, to: target.from + r.to, message };
}

/** The tab's chart settings, or the ones derived from its result when the user has not picked any. */
function effectiveChart(tab: QueryTabState): ChartSettings | null {
  const run = shownRun(tab);
  return tab.chart ?? (run?.status === 'done' ? defaultChartSettings(run.columns) : null);
}

/**
 * Query tab: query tabs with a CodeMirror editor, results grid, chart view, explain
 * plan, history and saved queries.
 */
export function QueryTab() {
  const ws = useWorkspace();
  const { sid } = ws;
  const qws = useQueryWorkspace(sid);
  const queryClient = useQueryClient();
  const tab = qws.tabs.find((t) => t.id === qws.activeId) ?? qws.tabs[0]!;
  const viewRef = useRef<EditorView | null>(null);
  const [panelOpen, setPanelOpen] = useState(true);
  const [editorHeight, setEditorHeight] = useState(280);
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [confirmClose, setConfirmClose] = useState<QueryTabState | null>(null);
  const [saveDialogFor, setSaveDialogFor] = useState<string | null>(null);
  const [confirmHistory, setConfirmHistory] = useState<{ entry: HistoryEntry; tabId: string } | null>(null);
  const openInNewTabRef = useRef<HTMLButtonElement>(null);
  const dragRef = useRef<{ startY: number; start: number } | null>(null);

  const draft = ws.queryDraft;
  useEffect(() => {
    if (draft) openDraft(sid, draft);
  }, [sid, draft]);

  const namespace = useMemo(() => buildSqlNamespace(ws.schemaModel), [ws.schemaModel]);
  const connectionId = ws.connection.id;
  const refreshHistory = useCallback(
    () => void queryClient.invalidateQueries({ queryKey: queryKeys.history(connectionId) }),
    [queryClient, connectionId],
  );

  const currentTarget = (): RunTarget | null => {
    const view = viewRef.current;
    const doc = view ? view.state.doc.toString() : tab.sql;
    const sel = view ? view.state.selection.main : { from: doc.length, to: doc.length };
    return runTarget(doc, sel);
  };

  // ---- running, through the parameter prompt when the SQL has placeholders ----------
  const [paramPrompt, setParamPrompt] = useState<ParamPrompt | null>(null);

  /** Stores the values a successful run used on the saved query the tab came from. */
  const rememberValues = async (tabId: string, values: ParamValues) => {
    const savedId = getTab(sid, tabId)?.saved?.id;
    if (!savedId) return;
    try {
      // Fresh from the server, so only the values change (never with SQL still being edited here).
      const all = await queryClient.fetchQuery({
        queryKey: queryKeys.savedQueries(connectionId),
        queryFn: () => api.savedQueries(connectionId),
      });
      const q = all.find((x) => x.id === savedId);
      if (!q) return;
      const paramValues = { ...q.paramValues, ...values };
      if (sameValues(paramValues, q.paramValues ?? {})) return;
      await api.updateSavedQuery(q.id, {
        connectionId: q.connectionId,
        name: q.name,
        sql: q.sql,
        chart: q.chart,
        paramValues,
      });
      void queryClient.invalidateQueries({ queryKey: queryKeys.savedQueries(connectionId) });
    } catch (err) {
      toast.error(`Couldn’t remember the parameter values: ${errorText(err)}`);
    }
  };

  const execute = async (l: Launch, tabId: string, values: ParamValues, used: string[]) => {
    if (l.kind === 'explain') {
      await runExplain(sid, tabId, l.target, refreshHistory, values);
      return;
    }
    const outcome =
      l.kind === 'run'
        ? (await runQuery(sid, tabId, l.target, refreshHistory, values))?.status
        : (await runScript(sid, tabId, l.statements, values, refreshHistory))?.status;
    if (outcome === 'done' && used.length > 0) await rememberValues(tabId, values);
  };

  /** Runs now, or asks for the placeholders' values first. */
  const launch = (l: Launch, tabId = tab.id) => {
    const t = getTab(sid, tabId);
    if (!t || isBusy(t)) return;
    const keys = launchKeys(l);
    if (keys.length === 0) void execute(l, tabId, {}, []);
    else setParamPrompt({ launch: l, keys, tabId });
  };
  const submitParams = (values: ParamValues) => {
    const p = paramPrompt;
    if (!p) return;
    setParamPrompt(null);
    updateTab(sid, p.tabId, (t) => ({ ...t, paramValues: { ...t.paramValues, ...values } }));
    void execute(p.launch, p.tabId, values, p.keys);
  };

  const run = () => {
    const target = currentTarget();
    if (!target) {
      toast('Nothing to run: write a statement first.');
      return;
    }
    launch({ kind: 'run', target });
  };
  const runAll = () => {
    const statements = splitScript(viewRef.current ? viewRef.current.state.doc.toString() : tab.sql);
    if (statements.length === 0) {
      toast('Nothing to run: write a statement first.');
      return;
    }
    launch({ kind: 'script', statements });
  };
  const explain = () => {
    const target = currentTarget();
    if (!target) {
      toast('Nothing to explain: write a statement first.');
      return;
    }
    launch({ kind: 'explain', target });
  };
  const cancel = () => {
    cancelRunning(sid, tab.id).catch((err: unknown) => toast.error(`Cancel failed: ${errorText(err)}`));
  };
  const format = () => {
    const view = viewRef.current;
    if (!view) return;
    const failure = formatInEditor(view);
    if (failure) toast(failure);
    view.focus();
  };
  const [viewTick, setViewTick] = useState(0);
  const onView = useCallback((view: EditorView | null) => {
    viewRef.current = view;
    setViewTick((n) => n + 1);
  }, []);

  // ---- actions from the ⌘K palette (rerun a saved query, insert a snippet) -----------
  const doPending = useRef<(t: QueryTabState) => void>(() => {});
  useEffect(() => {
    doPending.current = (t) => {
      // Inserting needs the editor: on a first visit, wait for it.
      if (t.pending?.kind === 'insert' && !viewRef.current) return;
      const action = takeTabAction(sid, t.id);
      if (action?.kind === 'insert') {
        const view = viewRef.current!;
        const at = view.state.selection.main.head;
        view.dispatch({
          changes: { from: at, insert: action.text },
          selection: { anchor: at + action.text.length },
          userEvent: 'input.paste',
          scrollIntoView: true,
        });
        view.focus();
      } else if (action?.kind === 'run') {
        // A saved query reruns whole: one statement as Run, several as Run all.
        const statements = splitScript(t.sql);
        const only = statements.length === 1 ? statements[0]! : null;
        if (statements.length === 0) toast(`Nothing to run: “${t.title}” is empty.`);
        else if (only) launch({ kind: 'run', target: { sql: only.text, from: only.from, to: only.to } }, t.id);
        else launch({ kind: 'script', statements }, t.id);
      }
    };
  });
  useEffect(() => {
    if (tab.pending) doPending.current(tab);
  }, [tab, viewTick]);

  // ---- saving ------------------------------------------------------------------------
  const save = useMutation({
    mutationFn: async ({ tabId, name }: { tabId: string; name: string }) => {
      const t = getTab(sid, tabId);
      if (!t) throw new Error('The tab was closed.');
      const input = { connectionId, name, sql: t.sql, chart: t.view === 'chart' ? effectiveChart(t) : t.chart };
      return t.saved ? api.updateSavedQuery(t.saved.id, input) : api.createSavedQuery(input);
    },
    onSuccess: (q, { tabId }) => {
      updateTab(sid, tabId, (t) => ({
        ...t,
        title: q.name,
        chart: q.chart ?? t.chart,
        saved: { id: q.id, name: q.name, sql: q.sql, chart: q.chart },
      }));
      setSaveDialogFor(null);
      void queryClient.invalidateQueries({ queryKey: queryKeys.savedQueries(connectionId) });
      toast.success(`Saved “${q.name}”`);
    },
    onError: (err) => toast.error(`Couldn’t save: ${errorText(err)}`),
  });
  const saveTab = (t: QueryTabState) => {
    if (t.saved) save.mutate({ tabId: t.id, name: t.saved.name });
    else setSaveDialogFor(t.id);
  };
  const saveCurrent = useRef(() => {});
  useEffect(() => {
    saveCurrent.current = () => saveTab(tab);
  });
  const active = ws.visible && ws.activeTab === 'query';
  useEffect(() => {
    if (!active) return;
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 's') {
        e.preventDefault();
        saveCurrent.current();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [active]);

  // ---- side panel callbacks ----------------------------------------------------------
  const onLoadHistory = (h: HistoryEntry) => {
    const current = viewRef.current ? viewRef.current.state.doc.toString() : tab.sql;
    if (historyLoadsDirectly(current, h.sql)) {
      updateTab(sid, tab.id, (t) => ({ ...t, sql: h.sql }));
      viewRef.current?.focus();
    } else {
      setConfirmHistory({ entry: h, tabId: tab.id });
    }
  };
  /** Set when the history dialog closes on Replace or Open in new tab: focus goes to the editor. */
  const focusEditorOnClose = useRef(false);
  const onOpenSaved = (q: SavedQuery) => openSavedQuery(sid, q);
  const onSavedChanged = (q: SavedQuery | { id: string; deleted: true }) => {
    for (const t of qws.tabs) {
      if (t.saved?.id !== q.id) continue;
      updateTab(sid, t.id, (x) =>
        'deleted' in q
          ? { ...x, saved: null }
          : { ...x, title: q.name, saved: x.saved && { ...x.saved, name: q.name } },
      );
    }
  };

  const requestClose = (t: QueryTabState) => {
    if (isDirty(t) && t.sql.trim() !== '') setConfirmClose(t);
    else closeTab(sid, t.id);
  };

  // ---- result header numbers --------------------------------------------------------
  const script = tab.script;
  const runState = shownRun(tab);
  const explainState = tab.explain;
  const running = isBusy(tab);
  const now = useNow(running);
  const startedAt =
    script?.status === 'running'
      ? script.startedAt
      : runState?.status === 'running'
        ? runState.startedAt
        : (explainState?.startedAt ?? 0);
  const elapsed = running && now > 0 ? Math.max(0, now - startedAt) : 0;

  const showingExplain = tab.view === 'explain';
  const stepIndex = script ? shownStep(script) : -1;
  const step = showingExplain ? undefined : script?.steps[stepIndex];
  const ranTarget = showingExplain ? explainState?.target : runState?.target;
  const markError = showingExplain ? explainState?.error : runState?.error;
  const errorMark = useMemo(() => errorMarkOf(markError, ranTarget, step), [markError, ranTarget, step]);
  const ranRange = useMemo(() => (ranTarget ? { from: ranTarget.from, to: ranTarget.to } : null), [ranTarget]);
  const errorLocation = (() => {
    if (!errorMark) return null;
    const lc = lineColumn(tab.sql, errorMark.from);
    if (!step || !script) return `Line ${lc.line}, column ${lc.column}`;
    const where = markError?.position !== undefined ? `line ${lc.line}, column ${lc.column}` : `line ${step.line}`;
    return `Statement ${stepIndex + 1} of ${script.steps.length} · ${where}`;
  })();

  const copyCsv = async () => {
    if (runState?.status !== 'done') return;
    const text = formatRows(
      runState.rows,
      'csv',
      runState.columns.map((c) => c.name),
    );
    if (await copyText(text)) toast.success(`Copied ${formatInt(runState.rows.length)} rows as CSV`);
    else toast.error('The clipboard refused the copy.');
  };

  const setView = (view: ResultView) => updateTab(sid, tab.id, (t) => ({ ...t, view }));
  const chartSettings = effectiveChart(tab);

  const onSplitDown = (e: PointerEvent<HTMLDivElement>) => {
    e.currentTarget.setPointerCapture(e.pointerId);
    dragRef.current = { startY: e.clientY, start: editorHeight };
  };
  const onSplitMove = (e: PointerEvent<HTMLDivElement>) => {
    const d = dragRef.current;
    if (d) setEditorHeight(Math.max(96, Math.min(720, d.start + e.clientY - d.startY)));
  };

  return (
    <div className="flex min-h-0 min-w-0 flex-1">
      <div className="flex min-h-0 min-w-0 flex-1 flex-col">
        {/* Query tabs */}
        <div
          className="bg-sidebar flex items-stretch overflow-x-auto border-b [scrollbar-width:none]"
          role="tablist"
          aria-label="Query tabs"
        >
          {qws.tabs.map((t) => {
            const on = t.id === tab.id;
            const dirty = isDirty(t);
            const Icon = t.chart || t.view === 'chart' ? ChartLine : Code;
            return (
              <div
                key={t.id}
                className={cn(
                  'group relative flex h-9 shrink-0 items-center gap-2 border-r pr-1.5 pl-3 text-xs',
                  on
                    ? 'bg-background text-foreground font-medium after:bg-brand after:absolute after:inset-x-0 after:bottom-0 after:h-0.5 [&_[data-tab-icon]]:text-brand-text'
                    : 'text-muted-foreground hover:text-foreground hover:bg-foreground/[0.03] dark:hover:bg-white/[0.03]',
                )}
              >
                {renamingId === t.id ? (
                  <input
                    autoFocus
                    aria-label="Tab name"
                    defaultValue={t.title}
                    className="bg-background border-brand ring-ring/25 h-6 w-32 rounded-[5px] border px-1.5 text-xs ring-[3px] outline-none"
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') e.currentTarget.blur();
                      if (e.key === 'Escape') setRenamingId(null);
                    }}
                    onBlur={(e) => {
                      const title = e.currentTarget.value.trim();
                      if (title && renamingId === t.id) updateTab(sid, t.id, (x) => ({ ...x, title }));
                      setRenamingId(null);
                    }}
                  />
                ) : (
                  <button
                    type="button"
                    role="tab"
                    aria-selected={on}
                    className="flex items-center gap-2 rounded-sm outline-none focus-visible:underline focus-visible:underline-offset-4"
                    title="Double-click to rename"
                    onClick={() => setActiveTab(sid, t.id)}
                    onDoubleClick={() => setRenamingId(t.id)}
                  >
                    <Icon data-tab-icon="" className="size-[13px]" aria-hidden="true" />
                    <span className="max-w-44 truncate">{t.title}</span>
                    {isBusy(t) && (
                      <LoaderCircle className="text-brand-text size-3 animate-spin" role="img" aria-label="Running" />
                    )}
                    {dirty && (
                      <span className="bg-foreground/55 size-1.5 rounded-full" role="img" aria-label="Unsaved" />
                    )}
                  </button>
                )}
                <button
                  type="button"
                  className={cn(
                    'text-muted-foreground hover:text-foreground inline-flex size-5 items-center justify-center rounded-[4px] opacity-0 group-hover:opacity-100 hover:bg-black/[0.06] focus-visible:opacity-100 dark:hover:bg-white/[0.08]',
                    on && 'opacity-100',
                  )}
                  aria-label={`Close ${t.title}`}
                  onClick={() => requestClose(t)}
                >
                  <X className="size-3" aria-hidden="true" />
                </button>
              </div>
            );
          })}
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                type="button"
                variant="ghost"
                size="icon-sm"
                className="text-muted-foreground hover:text-foreground mx-1 self-center"
                aria-label="New query tab"
                onClick={() => addTab(sid)}
              >
                <Plus className="size-3.5" />
              </Button>
            </TooltipTrigger>
            <TooltipContent>New query tab</TooltipContent>
          </Tooltip>
        </div>

        {/* Toolbar */}
        <div className="flex flex-wrap items-center gap-2 border-b px-3 py-2">
          <Tooltip>
            <TooltipTrigger asChild>
              <Button type="button" size="sm" onClick={run} disabled={running}>
                <Play className="size-3 fill-current" aria-hidden="true" />
                Run
                <kbd className={kbdOnPrimary}>{keys.run}</kbd>
              </Button>
            </TooltipTrigger>
            <TooltipContent>Run the selection, or the statement under the cursor ({keys.run})</TooltipContent>
          </Tooltip>
          <Tooltip>
            <TooltipTrigger asChild>
              <Button type="button" variant="outline" size="sm" onClick={runAll} disabled={running}>
                <ListVideo className="size-3.5" aria-hidden="true" />
                Run all
              </Button>
            </TooltipTrigger>
            <TooltipContent>Run every statement in order, stopping at the first error ({keys.runAll})</TooltipContent>
          </Tooltip>
          <Button type="button" variant="outline" size="sm" onClick={cancel} disabled={!running}>
            <Square className="size-3.5" aria-hidden="true" />
            Cancel
          </Button>
          <Tooltip>
            <TooltipTrigger asChild>
              <Button type="button" variant="outline" size="sm" onClick={explain} disabled={running}>
                <ListTree className="size-3.5" aria-hidden="true" />
                Explain
              </Button>
            </TooltipTrigger>
            <TooltipContent>EXPLAIN (ANALYZE, FORMAT JSON) — executes the statement ({keys.explain})</TooltipContent>
          </Tooltip>
          <span className="flex-1" />
          <Tooltip>
            <TooltipTrigger asChild>
              <Button type="button" variant="outline" size="icon-sm" aria-label="Format SQL" onClick={format}>
                <WandSparkles aria-hidden="true" />
              </Button>
            </TooltipTrigger>
            <TooltipContent>Format SQL: the selection, or the whole editor ({keys.format})</TooltipContent>
          </Tooltip>
          <Tooltip>
            <TooltipTrigger asChild>
              <Button type="button" variant="outline" size="sm" onClick={() => saveTab(tab)} disabled={save.isPending}>
                <Save className="size-3.5" aria-hidden="true" />
                {tab.saved ? 'Save' : 'Save…'}
              </Button>
            </TooltipTrigger>
            <TooltipContent>
              {tab.saved ? `Save “${tab.saved.name}”` : 'Save this query and its chart by name'} ({keys.save})
            </TooltipContent>
          </Tooltip>
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                type="button"
                variant="outline"
                size="icon-sm"
                aria-label={panelOpen ? 'Hide history and saved queries' : 'Show history and saved queries'}
                aria-pressed={panelOpen}
                onClick={() => setPanelOpen((o) => !o)}
              >
                <PanelRight aria-hidden="true" />
              </Button>
            </TooltipTrigger>
            <TooltipContent>History and saved queries</TooltipContent>
          </Tooltip>
        </div>

        {/* Editor */}
        <div className="min-h-0 shrink-0 overflow-hidden" style={{ height: editorHeight }}>
          <SqlEditor
            key={tab.id}
            value={tab.sql}
            onChange={(sql) => updateTab(sid, tab.id, (t) => (t.sql === sql ? t : { ...t, sql }))}
            schema={namespace}
            defaultSchema={ws.currentSchema}
            onRun={run}
            onRunAll={runAll}
            onExplain={explain}
            onFormat={format}
            ranRange={ranRange}
            errorMark={errorMark}
            onView={onView}
          />
        </div>
        <div
          role="separator"
          aria-orientation="horizontal"
          aria-label="Resize editor"
          aria-valuenow={editorHeight}
          aria-valuemin={96}
          aria-valuemax={720}
          tabIndex={0}
          className="hover:bg-brand/25 focus-visible:bg-brand/30 bg-sidebar h-1.5 shrink-0 cursor-row-resize border-t transition-colors outline-none"
          onPointerDown={onSplitDown}
          onPointerMove={onSplitMove}
          onPointerUp={() => (dragRef.current = null)}
          onKeyDown={(e) => {
            if (e.key === 'ArrowUp') setEditorHeight((h) => Math.max(96, h - 24));
            if (e.key === 'ArrowDown') setEditorHeight((h) => Math.min(720, h + 24));
          }}
        />

        {/* Result header */}
        <div className="flex min-h-11 flex-wrap items-center gap-3 border-b px-3 py-1.5">
          <div role="tablist" aria-label="Result view" className={segmentedList}>
            {(
              [
                ['results', 'Results', Table2],
                ['chart', 'Chart', ChartLine],
                ['explain', 'Explain', ListTree],
              ] as const
            ).map(([v, label, Icon]) => (
              <button
                key={v}
                type="button"
                role="tab"
                aria-selected={tab.view === v}
                onClick={() => setView(v)}
                className={cn(segmentedItem, 'px-3')}
              >
                <Icon aria-hidden="true" />
                {label}
              </button>
            ))}
          </div>
          <ResultStatus tab={tab} elapsed={elapsed} />
          <span className="flex-1" />
          {tab.view === 'results' && runState?.status === 'done' && runState.columns.length > 0 && (
            <Button type="button" variant="ghost" size="sm" className="h-7 text-xs" onClick={() => void copyCsv()}>
              <Copy className="size-3.5" aria-hidden="true" />
              Copy as CSV
            </Button>
          )}
          {tab.view === 'results' &&
            runState?.status === 'done' &&
            runState.columns.length > 0 &&
            // The export reruns the SQL on its own, without bind values: not for statements with placeholders.
            placeholderKeys(runState.target.sql).length === 0 && <ResultsExportMenu sql={runState.target.sql} />}
        </div>

        {/* Result body */}
        <div className="flex min-h-0 flex-1 flex-col">
          {script && tab.view !== 'explain' && (
            <ScriptList script={script} onSelect={(i) => selectScriptStep(sid, tab.id, i)} />
          )}
          {tab.view === 'results' && (
            <ResultsView
              key={runState?.qid ?? 'none'}
              run={runState}
              errorLocation={errorLocation}
              onLoadMore={() => void loadMore(sid, tab.id)}
            />
          )}
          {tab.view === 'chart' && (
            <ChartView
              columns={runState?.status === 'done' ? runState.columns : []}
              rows={runState?.status === 'done' ? runState.rows : []}
              settings={chartSettings}
              onChange={(chart) => updateTab(sid, tab.id, (t) => ({ ...t, chart }))}
              asTable={tab.chartAsTable}
              onAsTableChange={(chartAsTable) => updateTab(sid, tab.id, (t) => ({ ...t, chartAsTable }))}
              hasMore={runState?.status === 'done' && runState.hasMore}
              onSave={() => {
                if (chartSettings) updateTab(sid, tab.id, (t) => ({ ...t, chart: chartSettings }));
                saveTab(getTab(sid, tab.id) ?? tab);
              }}
              saveLabel={tab.saved ? 'Save chart' : 'Save chart…'}
            />
          )}
          {tab.view === 'explain' && <ExplainView explain={explainState} errorLocation={errorLocation} />}
        </div>
      </div>

      {panelOpen && (
        <SidePanel
          connectionId={connectionId}
          connectionName={ws.connection.nickname}
          activeSavedId={tab.saved?.id ?? null}
          onLoadHistory={onLoadHistory}
          onOpenSaved={onOpenSaved}
          onSavedChanged={onSavedChanged}
        />
      )}

      <ParamDialog
        open={paramPrompt !== null}
        keys={paramPrompt?.keys ?? []}
        initial={(paramPrompt && getTab(sid, paramPrompt.tabId)?.paramValues) ?? {}}
        action={
          paramPrompt?.launch.kind === 'script' ? 'Run all' : paramPrompt?.launch.kind === 'explain' ? 'Explain' : 'Run'
        }
        description={paramPromptDescription(paramPrompt)}
        onSubmit={submitParams}
        onCancel={() => setParamPrompt(null)}
      />
      <NameDialog
        open={saveDialogFor !== null}
        onOpenChange={(o) => !o && setSaveDialogFor(null)}
        title="Save query"
        description="Saved with its chart settings for this connection."
        initialName={qws.tabs.find((t) => t.id === saveDialogFor)?.title ?? ''}
        submitLabel="Save"
        pending={save.isPending}
        onSubmit={(name) => saveDialogFor && save.mutate({ tabId: saveDialogFor, name })}
      />
      <AlertDialog open={confirmClose !== null} onOpenChange={(o) => !o && setConfirmClose(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Close “{confirmClose?.title}” without saving?</AlertDialogTitle>
            <AlertDialogDescription>Its SQL is not saved. Runs stay in History.</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Keep open</AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              onClick={() => {
                if (confirmClose) closeTab(sid, confirmClose.id);
                setConfirmClose(null);
              }}
            >
              Close tab
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
      <AlertDialog open={confirmHistory !== null} onOpenChange={(o) => !o && setConfirmHistory(null)}>
        <AlertDialogContent
          onOpenAutoFocus={(e) => {
            // The safe choice keeps both: focus "Open in new tab" rather than Cancel.
            e.preventDefault();
            openInNewTabRef.current?.focus();
          }}
          onCloseAutoFocus={(e) => {
            if (!focusEditorOnClose.current) return;
            focusEditorOnClose.current = false;
            e.preventDefault();
            viewRef.current?.focus();
          }}
        >
          <AlertDialogHeader>
            <AlertDialogTitle>Replace the SQL in this tab?</AlertDialogTitle>
            <AlertDialogDescription>
              “{qws.tabs.find((t) => t.id === confirmHistory?.tabId)?.title ?? 'This tab'}” already holds other SQL.
              Open the history entry in a new tab to keep it, or replace it.
            </AlertDialogDescription>
          </AlertDialogHeader>
          {confirmHistory && (
            <pre className="bg-muted/60 text-foreground/85 max-h-32 overflow-auto rounded-md px-3 py-2 font-mono text-xs whitespace-pre-wrap shadow-[inset_0_0_0_1px_var(--edge)]">
              {confirmHistory.entry.sql}
            </pre>
          )}
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              variant="outline"
              onClick={() => {
                if (!confirmHistory) return;
                const { sql } = confirmHistory.entry;
                updateTab(sid, confirmHistory.tabId, (t) => ({ ...t, sql }));
                focusEditorOnClose.current = true;
              }}
            >
              Replace
            </AlertDialogAction>
            <AlertDialogAction
              ref={openInNewTabRef}
              onClick={() => {
                if (!confirmHistory) return;
                addTab(sid, { sql: confirmHistory.entry.sql });
                focusEditorOnClose.current = true;
              }}
            >
              Open in new tab
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

function ResultStatus({ tab, elapsed }: { tab: QueryTabState; elapsed: number }) {
  if (tab.view === 'explain') {
    const ex = tab.explain;
    if (ex?.status === 'running') return <Running elapsed={elapsed} label="Explaining" />;
    if (ex?.status !== 'done' || !ex.result) return null;
    return (
      <>
        <span className="bg-muted text-foreground/80 inline-flex h-5 items-center rounded-[5px] px-1.5 font-mono text-[10.5px] font-medium shadow-[inset_0_0_0_1px_var(--edge)]">
          EXPLAIN (ANALYZE, FORMAT JSON)
        </span>
        <span className="text-xs">
          <span className="text-muted-foreground">Planning</span>{' '}
          <span className="font-mono">{formatMs(ex.result.planningMs)}</span>
          <span className="text-muted-foreground"> · Execution</span>{' '}
          <b className="font-mono font-semibold">{formatMs(ex.result.executionMs)}</b>
        </span>
        <span className="text-muted-foreground inline-flex items-center gap-1 text-xs">
          <Info className="size-3" aria-hidden="true" />
          ANALYZE executes the statement.
        </span>
      </>
    );
  }
  if (tab.script) return <ScriptStatus script={tab.script} elapsed={elapsed} />;
  const run = tab.run;
  if (!run) return null;
  if (run.status === 'running') return <Running elapsed={elapsed} label="Running" />;
  if (run.status === 'cancelled') {
    return (
      <span className="text-muted-foreground inline-flex items-center gap-1.5 text-xs">
        <CircleSlash className="size-3.5" aria-hidden="true" />
        Cancelled after <span className="font-mono">{formatMs(run.elapsedMs ?? 0)}</span>
      </span>
    );
  }
  if (run.status === 'error') {
    return (
      <span className="text-destructive inline-flex items-center gap-1.5 text-xs">
        <CircleX className="size-3.5" aria-hidden="true" />
        <b className="font-semibold">Failed</b>
        <span className="text-muted-foreground">· {formatMs(run.elapsedMs ?? 0)}</span>
      </span>
    );
  }
  const lines = lineSpan(tab.sql, run.target.from, run.target.to);
  const where =
    lines.first === lines.last ? `statement on line ${lines.first}` : `statement on lines ${lines.first}–${lines.last}`;
  if (tab.view === 'chart') {
    return (
      <span className="text-muted-foreground text-xs">
        {formatInt(run.rows.length)} rows · {formatMs(run.elapsedMs ?? 0)}
      </span>
    );
  }
  const headline =
    run.columns.length === 0
      ? (run.command ?? 'Done')
      : `${formatInt(run.rows.length)}${run.hasMore ? '+' : ''} row${run.rows.length === 1 && !run.hasMore ? '' : 's'}`;
  return (
    <span className="inline-flex items-center gap-1.5 text-xs">
      <CircleCheck className="text-success size-3.5" aria-hidden="true" />
      <b className={cn('tabular font-semibold', run.columns.length === 0 && 'font-mono')}>{headline}</b>
      <span className="text-muted-foreground">
        · {formatMs(run.elapsedMs ?? 0)} · {where}
      </span>
    </span>
  );
}

function Running({ elapsed, label }: { elapsed: number; label: string }) {
  return (
    <span className="inline-flex items-center gap-1.5 text-xs">
      <LoaderCircle className="text-brand-text size-3.5 animate-spin" aria-hidden="true" />
      <b className="font-semibold" aria-live="polite">
        {label}…
      </b>
      <span className="text-muted-foreground font-mono">{(elapsed / 1000).toFixed(1)} s</span>
    </span>
  );
}

function paramPromptDescription(p: ParamPrompt | null): string {
  if (!p) return '';
  const n = p.keys.length;
  const params = `${n} parameter${n === 1 ? '' : 's'}`;
  if (p.launch.kind !== 'script') return params;
  const count = p.launch.statements.length;
  return `${params} across ${count} statement${count === 1 ? '' : 's'}`;
}

/** Header of a Run all: progress while it runs, then how it ended. */
function ScriptStatus({ script, elapsed }: { script: ScriptState; elapsed: number }) {
  const total = script.steps.length;
  const at = script.current + 1;
  if (script.status === 'running') return <Running elapsed={elapsed} label={`Statement ${at} of ${total}`} />;
  const time = <span className="text-muted-foreground">· {formatMs(script.elapsedMs ?? 0)}</span>;
  if (script.status === 'error') {
    return (
      <span className="text-destructive inline-flex items-center gap-1.5 text-xs">
        <CircleX className="size-3.5" aria-hidden="true" />
        <b className="font-semibold">
          Statement {at} of {total} failed
        </b>
        <span className="text-muted-foreground">· line {script.steps[script.current]!.line}</span>
        {time}
      </span>
    );
  }
  if (script.status === 'cancelled') {
    return (
      <span className="text-muted-foreground inline-flex items-center gap-1.5 text-xs">
        <CircleSlash className="size-3.5" aria-hidden="true" />
        Cancelled at statement {at} of {total}
        {time}
      </span>
    );
  }
  return (
    <span className="inline-flex items-center gap-1.5 text-xs">
      <CircleCheck className="text-success size-3.5" aria-hidden="true" />
      <b className="tabular font-semibold">
        {total} statement{total === 1 ? '' : 's'}
      </b>
      {time}
    </span>
  );
}
