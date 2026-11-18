import { CircleExclamationPoint, LoaderCircle } from 'lucide-react';
import { useCallback, useMemo, useState, type ReactNode } from 'react';
import type { ApiErrorBody } from '@kleos/shared';
import { Button } from '@/components/ui/button';
import { classifyType, typeLabel } from '@/features/cells/classify';
import { DataGrid } from '@/features/grid/data-grid';
import type { GridColumn, GridSelection } from '@/features/grid/types';
import { ValueInspector } from '@/features/grid/value-inspector';
import { formatInt, formatMs } from '@/lib/format';
import { cn } from '@/lib/utils';
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
  const columns = useMemo(() => (run ? resultColumns(run) : []), [run]);
  const rows = run?.rows;
  const getRowMeta = useCallback((i: number) => ({ key: String(i), label: String(i + 1), status: null }), []);
  const getCell = useCallback((i: number, c: number) => ({ value: rows?.[i]?.[c] ?? null }), [rows]);
  const loadMoreIfAny =
    run?.status === 'done' && run.hasMore && !run.loadingMore && !run.pageError ? onLoadMore : undefined;

  if (!run) {
    return (
      <EmptyResult>
        Run a statement with <kbd className="font-mono">{isMac ? '⌘↵' : 'Ctrl+↵'}</kbd>: the selection, or the statement
        under the cursor.
      </EmptyResult>
    );
  }
  if (run.status === 'running') {
    return (
      <EmptyResult>
        <LoaderCircle className="size-4 animate-spin" aria-hidden="true" /> Waiting for the first rows…
      </EmptyResult>
    );
  }
  if (run.status === 'error' && run.error) return <QueryErrorPanel error={run.error} location={errorLocation} />;
  if (run.status === 'cancelled') {
    return <EmptyResult>Cancelled after {formatMs(run.elapsedMs ?? 0)}. Nothing was returned.</EmptyResult>;
  }
  if (run.columns.length === 0) {
    return (
      <div className="flex flex-1 flex-col items-start gap-1 p-6">
        <span className="font-mono text-base font-semibold">{run.command ?? 'Done'}</span>
        <span className="text-muted-foreground text-xs">
          {run.rowCount !== null && run.command && !/\d$/.test(run.command) ? `${formatInt(run.rowCount)} rows · ` : ''}
          {formatMs(run.elapsedMs ?? 0)}
        </span>
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
        />
        {(run.hasMore || run.pageError) && (
          <div className="flex items-center gap-3 border-t px-3 py-1.5 text-xs">
            {run.pageError ? (
              <span className="text-destructive">Couldn’t load more rows: {run.pageError}</span>
            ) : (
              <span className="text-muted-foreground">More rows are available; they load as you scroll.</span>
            )}
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
          </div>
        )}
      </div>
      {inspect && focus && focusCol && focus.row < run.rows.length && (
        <ValueInspector
          key={`${focus.row}:${focus.col}`}
          columnName={focusCol.name}
          subtitle={`${focusCol.typeLabel} · row ${formatInt(focus.row + 1)}`}
          kind={focusCol.kind}
          value={run.rows[focus.row]?.[focus.col] ?? null}
          onClose={() => setInspect(false)}
        />
      )}
    </div>
  );
}

function EmptyResult({ children }: { children: ReactNode }) {
  return (
    <div className="text-muted-foreground flex flex-1 items-center justify-center gap-2 p-8 text-center text-xs">
      {children}
    </div>
  );
}

/** Error with its SQLSTATE, message, position and hint; read-only refusals get their own title. */
export function QueryErrorPanel({ error, location }: { error: ApiErrorBody; location: string | null }) {
  const readOnly = error.code === '25006' || error.code === 'KLEOS_READ_ONLY';
  const sqlstate = /^[0-9A-Z]{5}$/.test(error.code);
  return (
    <div className="p-4">
      <div
        role="alert"
        className={cn(
          'flex items-start gap-2.5 rounded-lg border px-3.5 py-3',
          readOnly ? 'bg-card' : 'bg-error-bg border-error-line',
        )}
      >
        <CircleExclamationPoint
          className={cn('mt-0.5 size-4 shrink-0', readOnly ? 'text-muted-foreground' : 'text-destructive')}
          aria-hidden="true"
        />
        <div className="flex min-w-0 flex-col gap-0.5">
          {readOnly ? (
            <>
              <b className="font-semibold">This connection is read-only</b>
              <span className="font-mono text-xs">
                ERROR {error.code}: {error.message}
              </span>
            </>
          ) : (
            <b className="font-semibold">
              {sqlstate && <span className="font-mono">{error.code}</span>} {error.message}
            </b>
          )}
          {(location || error.hint) && (
            <span className="text-xs">
              {location}
              {location && error.hint ? ' · ' : ''}
              {error.hint && <span className="text-muted-foreground">Hint: {error.hint}</span>}
            </span>
          )}
          {error.detail && <span className="text-muted-foreground text-xs whitespace-pre-wrap">{error.detail}</span>}
        </div>
      </div>
    </div>
  );
}
