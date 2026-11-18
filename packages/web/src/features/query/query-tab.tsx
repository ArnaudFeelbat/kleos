import { useMutation, useQueryClient } from '@tanstack/react-query';
import type { EditorView } from '@codemirror/view';
import {
  Check,
  ChartLine,
  Code,
  Copy,
  ListTree,
  LoaderCircle,
  PanelRight,
  Play,
  Plus,
  Save,
  Square,
  Table2,
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
import { copyText, formatRows } from '@/features/grid/copy';
import { useWorkspace } from '@/features/workspace/context';
import { api, errorText, queryKeys } from '@/lib/api';
import { formatInt, formatMs } from '@/lib/format';
import { cn } from '@/lib/utils';
import { defaultChartSettings } from './chart-data';
import { ChartView } from './chart-view';
import { errorRange, lineColumn } from './error-position';
import { ExplainView } from './explain-view';
import { NameDialog } from './name-dialog';
import { ResultsView } from './results-view';
import { lineSpan, runTarget, type RunTarget } from './run-target';
import { buildSqlNamespace } from './schema-completion';
import { SidePanel } from './side-panel';
import { SqlEditor, type ErrorMark } from './sql-editor';
import {
  addTab,
  cancelRunning,
  closeTab,
  getTab,
  isDirty,
  loadMore,
  openDraft,
  runExplain,
  runQuery,
  setActiveTab,
  updateTab,
  useQueryWorkspace,
  type QueryTabState,
  type ResultView,
} from './store';

const isMac = typeof navigator !== 'undefined' && /Mac/.test(navigator.platform);
const keys = isMac ? { run: '⌘↵', explain: '⌘E', save: '⌘S' } : { run: 'Ctrl+↵', explain: 'Ctrl+E', save: 'Ctrl+S' };

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

/** Underline range for an error with a position, relative to the statement that ran. */
function errorMarkOf(error: ApiErrorBody | null | undefined, target: RunTarget | undefined): ErrorMark | null {
  if (!error || !target || error.position === undefined) return null;
  const r = errorRange(target.sql, 0, target.sql, error.position);
  return { from: target.from + r.from, to: target.from + r.to, message: `${error.code} ${error.message}` };
}

/** The tab's chart settings, or the ones derived from its result when the user has not picked any. */
function effectiveChart(tab: QueryTabState): ChartSettings | null {
  return tab.chart ?? (tab.run?.status === 'done' ? defaultChartSettings(tab.run.columns) : null);
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
  const run = () => {
    const target = currentTarget();
    if (!target) {
      toast('Nothing to run: write a statement first.');
      return;
    }
    void runQuery(sid, tab.id, target, refreshHistory);
  };
  const explain = () => {
    const target = currentTarget();
    if (!target) {
      toast('Nothing to explain: write a statement first.');
      return;
    }
    void runExplain(sid, tab.id, target, refreshHistory);
  };
  const cancel = () => {
    cancelRunning(sid, tab.id).catch((err: unknown) => toast.error(`Cancel failed: ${errorText(err)}`));
  };
  const onView = useCallback((view: EditorView | null) => {
    viewRef.current = view;
  }, []);

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
    updateTab(sid, tab.id, (t) => ({ ...t, sql: h.sql }));
    viewRef.current?.focus();
  };
  const onOpenSaved = (q: SavedQuery) => {
    const open = qws.tabs.find((t) => t.saved?.id === q.id);
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
  };
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
  const runState = tab.run;
  const explainState = tab.explain;
  const running = runState?.status === 'running' || explainState?.status === 'running';
  const now = useNow(running);
  const startedAt = runState?.status === 'running' ? runState.startedAt : (explainState?.startedAt ?? 0);
  const elapsed = running && now > 0 ? Math.max(0, now - startedAt) : 0;

  const showingExplain = tab.view === 'explain';
  const ranTarget = showingExplain ? explainState?.target : runState?.target;
  const markError = showingExplain ? explainState?.error : runState?.error;
  const errorMark = useMemo(() => errorMarkOf(markError, ranTarget), [markError, ranTarget]);
  const ranRange = useMemo(() => (ranTarget ? { from: ranTarget.from, to: ranTarget.to } : null), [ranTarget]);
  const errorLocation = errorMark
    ? (() => {
        const lc = lineColumn(tab.sql, errorMark.from);
        return `Line ${lc.line}, column ${lc.column}`;
      })()
    : null;

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
        <div className="bg-sidebar flex items-stretch overflow-x-auto border-b" role="tablist" aria-label="Query tabs">
          {qws.tabs.map((t) => {
            const on = t.id === tab.id;
            const dirty = isDirty(t);
            const Icon = t.chart || t.view === 'chart' ? ChartLine : Code;
            return (
              <div
                key={t.id}
                className={cn(
                  'group text-muted-foreground flex h-9 shrink-0 items-center gap-2 border-r pr-1.5 pl-3 text-xs',
                  on && 'bg-background text-foreground font-medium shadow-[inset_0_-2px_0_var(--primary)]',
                )}
              >
                {renamingId === t.id ? (
                  <input
                    autoFocus
                    aria-label="Tab name"
                    defaultValue={t.title}
                    className="bg-background h-6 w-32 rounded border px-1.5 text-xs outline-none"
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
                    className="flex items-center gap-2 outline-none focus-visible:underline"
                    title="Double-click to rename"
                    onClick={() => setActiveTab(sid, t.id)}
                    onDoubleClick={() => setRenamingId(t.id)}
                  >
                    <Icon className="size-[13px]" aria-hidden="true" />
                    <span className="max-w-44 truncate">{t.title}</span>
                    {(t.run?.status === 'running' || t.explain?.status === 'running') && (
                      <LoaderCircle className="size-3 animate-spin" role="img" aria-label="Running" />
                    )}
                    {dirty && <span className="bg-foreground size-1.5 rounded-full" role="img" aria-label="Unsaved" />}
                  </button>
                )}
                <button
                  type="button"
                  className={cn(
                    'hover:bg-accent inline-flex size-5 items-center justify-center rounded-sm opacity-0 group-hover:opacity-100 focus-visible:opacity-100',
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
                size="icon"
                className="h-9 rounded-none"
                aria-label="New query tab"
                onClick={() => addTab(sid)}
              >
                <Plus className="text-muted-foreground size-3.5" />
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
                <Play className="size-3.5 fill-current" aria-hidden="true" />
                Run
                <kbd className="rounded border border-current/40 px-1 font-mono text-[11px]">{keys.run}</kbd>
              </Button>
            </TooltipTrigger>
            <TooltipContent>Run the selection, or the statement under the cursor ({keys.run})</TooltipContent>
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
            onExplain={explain}
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
          className="hover:bg-ring/20 focus-visible:bg-ring/30 h-1.5 shrink-0 cursor-row-resize border-t outline-none"
          onPointerDown={onSplitDown}
          onPointerMove={onSplitMove}
          onPointerUp={() => (dragRef.current = null)}
          onKeyDown={(e) => {
            if (e.key === 'ArrowUp') setEditorHeight((h) => Math.max(96, h - 24));
            if (e.key === 'ArrowDown') setEditorHeight((h) => Math.min(720, h + 24));
          }}
        />

        {/* Result header */}
        <div className="flex flex-wrap items-center gap-3 border-b px-3 py-2">
          <div role="tablist" aria-label="Result view" className="bg-muted inline-flex gap-0.5 rounded-lg p-0.5">
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
                className={cn(
                  'text-muted-foreground inline-flex h-[26px] items-center gap-1.5 rounded-md px-3 text-xs font-medium',
                  tab.view === v && 'bg-background text-foreground shadow-sm',
                )}
              >
                <Icon className="size-[13px]" aria-hidden="true" />
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
        </div>

        {/* Result body */}
        <div className="flex min-h-0 flex-1 flex-col">
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
        <span className="bg-muted inline-flex h-5 items-center rounded-full px-2 font-mono text-[11px] font-medium">
          EXPLAIN (ANALYZE, FORMAT JSON)
        </span>
        <span className="text-xs">
          <span className="text-muted-foreground">Planning</span>{' '}
          <span className="font-mono">{formatMs(ex.result.planningMs)}</span>
          <span className="text-muted-foreground"> · Execution</span>{' '}
          <b className="font-mono font-semibold">{formatMs(ex.result.executionMs)}</b>
        </span>
        <span className="text-muted-foreground text-xs">ANALYZE executes the statement.</span>
      </>
    );
  }
  const run = tab.run;
  if (!run) return null;
  if (run.status === 'running') return <Running elapsed={elapsed} label="Running" />;
  if (run.status === 'cancelled') {
    return <span className="text-muted-foreground text-xs">Cancelled after {formatMs(run.elapsedMs ?? 0)}</span>;
  }
  if (run.status === 'error') {
    return (
      <span className="text-destructive inline-flex items-center gap-1.5 text-xs">
        <X className="size-3.5" aria-hidden="true" />
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
      <Check className="text-success size-3.5" aria-hidden="true" />
      <b className={cn('font-semibold', run.columns.length === 0 && 'font-mono')}>{headline}</b>
      <span className="text-muted-foreground">
        · {formatMs(run.elapsedMs ?? 0)} · {where}
      </span>
    </span>
  );
}

function Running({ elapsed, label }: { elapsed: number; label: string }) {
  return (
    <span className="inline-flex items-center gap-1.5 text-xs">
      <LoaderCircle className="size-3.5 animate-spin" aria-hidden="true" />
      <b className="font-semibold" aria-live="polite">
        {label}…
      </b>
      <span className="text-muted-foreground font-mono">{(elapsed / 1000).toFixed(1)} s</span>
    </span>
  );
}
