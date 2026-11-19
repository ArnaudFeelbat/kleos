import { CircleCheck, CircleExclamationPoint, CircleSlash, CircleX, LoaderCircle, Lock, Play } from 'lucide-react';
import { useCallback, useContext, useMemo, useState } from 'react';
import { emptyGridLayout, type ApiErrorBody, type GridLayout } from '@kleos/shared';
import { Button } from '@/components/ui/button';
import { classifyType, typeLabel } from '@/features/cells/classify';
import { Callout } from '@/features/common/callout';
import { EmptyState } from '@/features/common/empty-state';
import { GridSkeleton } from '@/features/common/skeletons';
import { kbdNeutral } from '@/features/common/styles';
import { displayOrder, isEmptyLayout, moveInLayout, resizeInLayout } from '@/features/grid/column-layout';
import { DataGrid } from '@/features/grid/data-grid';
import type { GridColumn, GridSelection } from '@/features/grid/types';
import { ValueInspector } from '@/features/grid/value-inspector';
import { ExportMenu } from '@/features/jobs/export-menu';
import { WorkspaceContext } from '@/features/workspace/context';
import { formatInt, formatMs } from '@/lib/format';
import type { RunState } from './store';

const isMac = typeof navigator !== 'undefined' && /Mac/.test(navigator.platform);

/** Grid columns for a result; keys are positional because a result may repeat a name. */
export function resultColumns(run: RunState): GridColumn[] {
  return run.columns.map((c, i) => ({
    key: `${i}:${c.name}`,
    name: c.name,
    kind: classifyType(c),
    typeLabel: typeLabel(c),
  }));
}

type ResultsViewProps = {
  run: RunState | null;
  /** "Line 1, column 8", when the error has a position. */
  errorLocation: string | null;
  onLoadMore(): void;
};

/** Query results in the shared grid, paged as the user scrolls, or the run's outcome. */
export function ResultsView({ run, errorLocation, onLoadMore }: ResultsViewProps) {
  const [selection, setSelection] = useState<GridSelection | null>(null);
  const [inspect, setInspect] = useState(false);
  // Reordered and resized for this result only (the view is keyed by run): nothing is remembered.
  const [layout, setLayout] = useState<GridLayout>(emptyGridLayout);
  const natural = useMemo(() => (run ? resultColumns(run) : []), [run]);
  const keys = useMemo(() => natural.map((c) => c.key), [natural]);
  /** Display position -> index in the result's rows. */
  const order = useMemo(() => displayOrder(keys, layout.order), [keys, layout.order]);
  const columns = useMemo(() => order.map((i) => natural[i]!), [order, natural]);
  const rows = run?.rows;
  const getRowMeta = useCallback((i: number) => ({ key: String(i), label: String(i + 1), status: null }), []);
  const getCell = useCallback((i: number, c: number) => ({ value: rows?.[i]?.[order[c]!] ?? null }), [rows, order]);
  const loadMoreIfAny =
    run?.status === 'done' && run.hasMore && !run.loadingMore && !run.pageError ? onLoadMore : undefined;

  if (!run) {
    return (
      <EmptyState
        icon={Play}
        title="No results yet"
        hint={
          <>
            Run a statement with <kbd className={kbdNeutral}>{isMac ? '⌘↵' : 'Ctrl+↵'}</kbd>: the selection, or the
            statement under the cursor.
          </>
        }
      />
    );
  }
  if (run.status === 'running') {
    return (
      <div className="flex min-h-0 flex-1 flex-col">
        <p className="text-muted-foreground flex items-center gap-2 px-4 py-2 text-xs" aria-live="polite">
          <LoaderCircle className="text-brand-text size-3.5 animate-spin" aria-hidden="true" /> Waiting for the first
          rows…
        </p>
        <GridSkeleton rows={6} columns={4} />
      </div>
    );
  }
  if (run.status === 'error' && run.error) return <QueryErrorPanel error={run.error} location={errorLocation} />;
  if (run.status === 'cancelled') {
    return (
      <EmptyState
        icon={CircleSlash}
        title={`Cancelled after ${formatMs(run.elapsedMs ?? 0)}.`}
        hint="Nothing was returned."
      />
    );
  }
  if (run.columns.length === 0) {
    return (
      <div className="flex flex-1 items-start p-4">
        <div className="surface-raised animate-in fade-in-0 flex items-center gap-3 rounded-xl px-4 py-3 duration-200">
          <span className="bg-success-bg text-success flex size-8 items-center justify-center rounded-lg">
            <CircleCheck className="size-4" aria-hidden="true" />
          </span>
          <div className="flex flex-col gap-0.5">
            <span className="font-mono text-[14px] font-semibold">{run.command ?? 'Done'}</span>
            <span className="text-muted-foreground text-xs">
              {run.rowCount !== null && run.command && !/\d$/.test(run.command)
                ? `${formatInt(run.rowCount)} rows · `
                : ''}
              {formatMs(run.elapsedMs ?? 0)}
            </span>
          </div>
        </div>
      </div>
    );
  }

  const focus = selection?.focus;
  const focusCol = focus ? columns[focus.col] : undefined;
  return (
    <div className="flex min-h-0 flex-1">
      <div className="flex min-h-0 min-w-0 flex-1 flex-col">
        <DataGrid
          columns={columns}
          rowCount={run.rows.length}
          getRowMeta={getRowMeta}
          getCell={getCell}
          selection={selection}
          onSelectionChange={setSelection}
          ariaLabel="Query results"
          onEndReached={loadMoreIfAny}
          onEditRequest={(pos) => {
            setSelection({ anchor: pos, focus: pos });
            setInspect(true);
          }}
          emptyState="The statement returned no rows."
          columnWidths={layout.widths}
          onColumnResize={(key, width) => setLayout((l) => resizeInLayout(l, key, width))}
          onColumnMove={(from, to) => setLayout((l) => moveInLayout(l, keys, from, to))}
          onResetColumns={() => setLayout(emptyGridLayout)}
          columnsCustomized={!isEmptyLayout(layout)}
        />
        {(run.hasMore || run.pageError) && (
          <div className="bg-sidebar/60 flex items-center gap-3 border-t px-3 py-1.5 text-xs">
            {run.pageError ? (
              <span className="text-destructive inline-flex items-center gap-1.5">
                <CircleX className="size-3.5" aria-hidden="true" />
                Couldn’t load more rows: {run.pageError}
              </span>
            ) : run.hasMore ? (
              <span className="text-muted-foreground">More rows are available; they load as you scroll.</span>
            ) : null}
            {(run.hasMore || run.pageError) && (
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="h-7 text-xs"
                disabled={run.loadingMore}
                onClick={onLoadMore}
              >
                {run.loadingMore && <LoaderCircle className="animate-spin" aria-hidden="true" />}
                Load more
              </Button>
            )}
          </div>
        )}
      </div>
      {inspect && focus && focusCol && focus.row < run.rows.length && (
        <ValueInspector
          key={`${focus.row}:${focus.col}`}
          columnName={focusCol.name}
          subtitle={`${focusCol.typeLabel} · row ${formatInt(focus.row + 1)}`}
          kind={focusCol.kind}
          value={run.rows[focus.row]?.[order[focus.col]!] ?? null}
          onClose={() => setInspect(false)}
        />
      )}
    </div>
  );
}

/**
 * Export of a result: the statement that produced it runs again on its own cursor (inside a
 * read-only transaction on read-only connections), so every row is written, not only the
 * loaded ones. Needs the workspace (for the session); renders nothing outside one.
 */
export function ResultsExportMenu({ sql }: { sql: string }) {
  const ws = useContext(WorkspaceContext);
  if (!ws) return null;
  return (
    <ExportMenu
      sid={ws.sid}
      source={{ kind: 'query', sql }}
      defaultName="query-results"
      subject="query results"
      sourceKey={`${ws.sid}:export:query:${sql}`}
      scopeNote="Runs the statement again and exports every row it returns, not just the loaded ones."
      className="h-7"
    />
  );
}

/** Error with its SQLSTATE, message, position and hint; read-only refusals get their own title. */
export function QueryErrorPanel({ error, location }: { error: ApiErrorBody; location: string | null }) {
  const readOnly = error.code === '25006' || error.code === 'KLEOS_READ_ONLY';
  const sqlstate = /^[0-9A-Z]{5}$/.test(error.code);
  return (
    <div className="p-4">
      <Callout
        role="alert"
        tone={readOnly ? 'info' : 'error'}
        icon={readOnly ? Lock : CircleExclamationPoint}
        title={
          readOnly ? (
            'This connection is read-only'
          ) : (
            <>
              {sqlstate && (
                <>
                  <span className="bg-background/70 rounded-[4px] px-1 py-px font-mono text-[12px] shadow-[inset_0_0_0_1px_var(--error-line)]">
                    {error.code}
                  </span>{' '}
                </>
              )}
              {error.message}
            </>
          )
        }
      >
        {readOnly && (
          <span className="font-mono text-xs">
            ERROR {error.code}: {error.message}
          </span>
        )}
        {(location || error.hint) && (
          <span className="text-xs">
            {location && <span className="font-mono">{location}</span>}
            {location && error.hint ? ' · ' : ''}
            {error.hint && <span className="text-muted-foreground">Hint: {error.hint}</span>}
          </span>
        )}
        {error.detail && <span className="text-muted-foreground text-xs whitespace-pre-wrap">{error.detail}</span>}
      </Callout>
    </div>
  );
}
