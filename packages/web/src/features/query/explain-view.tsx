import { ChevronDown, CircleSlash, Copy, Flame, ListTree, LoaderCircle } from 'lucide-react';
import { useMemo, useState } from 'react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { EmptyState } from '@/features/common/empty-state';
import { kbdNeutral } from '@/features/common/styles';
import { copyText } from '@/features/grid/copy';
import { formatInt, formatMs } from '@/lib/format';
import { cn } from '@/lib/utils';
import { computePlanRows, nodeDetails, nodeSummary, nodeTarget, type PlanRow } from './explain-plan';
import { QueryErrorPanel } from './results-view';
import type { ExplainState } from './store';

const isMac = typeof navigator !== 'undefined' && /Mac/.test(navigator.platform);

/** EXPLAIN (ANALYZE, FORMAT JSON) as an indented tree with self time per node and a detail panel. */
export function ExplainView({
  explain,
  errorLocation,
}: {
  explain: ExplainState | null;
  errorLocation: string | null;
}) {
  const result = explain?.status === 'done' ? explain.result : null;
  const rows = useMemo(() => (result ? computePlanRows(result.plan, result.executionMs) : []), [result]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const selected = rows.find((r) => r.id === selectedId) ?? rows.find((r) => r.hottest) ?? rows[0];

  if (!explain) {
    return (
      <EmptyState
        icon={ListTree}
        title="No plan yet"
        hint={
          <>
            Explain (<kbd className={kbdNeutral}>{isMac ? '⌘E' : 'Ctrl+E'}</kbd>) runs EXPLAIN (ANALYZE, FORMAT JSON) on
            the selection or the statement under the cursor.
          </>
        }
      />
    );
  }
  if (explain.status === 'running') {
    return (
      <p className="text-muted-foreground flex flex-1 items-center justify-center gap-2 p-8 text-xs">
        <LoaderCircle className="text-brand-text size-4 animate-spin" aria-hidden="true" /> Running the statement under
        EXPLAIN ANALYZE…
      </p>
    );
  }
  if (explain.status === 'cancelled') {
    return <EmptyState icon={CircleSlash} title={`Explain cancelled after ${formatMs(explain.elapsedMs ?? 0)}.`} />;
  }
  if (explain.status === 'error' && explain.error)
    return <QueryErrorPanel error={explain.error} location={errorLocation} />;
  if (!result) return null;

  const copyPlan = async () => {
    if (await copyText(JSON.stringify(result.plan, null, 2))) toast.success('Copied the JSON plan');
    else toast.error('The clipboard refused the copy.');
  };

  return (
    <div className="flex min-h-0 flex-1">
      <div className="min-h-0 min-w-0 flex-1 overflow-auto">
        <table className="w-full border-separate border-spacing-0 text-[12.5px]">
          <thead>
            <tr className="text-muted-foreground text-[11.5px] [&>th]:bg-sidebar [&>th]:sticky [&>th]:top-0 [&>th]:z-[1] [&>th]:h-9 [&>th]:border-b [&>th]:px-3 [&>th]:font-medium [&>th]:whitespace-nowrap">
              <th className="text-left">Node</th>
              <th className="text-right">Rows · actual / est.</th>
              <th className="text-right">Loops</th>
              <th className="w-[220px] text-left">Self time</th>
              <th className="text-right">Total</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <PlanTableRow key={r.id} row={r} selected={r.id === selected?.id} onSelect={() => setSelectedId(r.id)} />
            ))}
          </tbody>
        </table>
        <p className="text-muted-foreground m-0 p-3 text-xs">
          Self time = node total minus its children. Bars are a share of the {formatMs(result.executionMs)} execution.
        </p>
      </div>
      {selected && (
        <aside
          aria-label="Node details"
          className="bg-background flex w-[300px] shrink-0 flex-col gap-0 overflow-auto border-l p-4"
        >
          <h2 className="m-0 text-[15px] font-semibold tracking-[-0.012em]">{selected.node['Node Type']}</h2>
          {nodeTarget(selected.node) && (
            <span className="text-muted-foreground mt-0.5 font-mono text-xs">{nodeTarget(selected.node)}</span>
          )}
          <div className="mt-3 mb-2 flex flex-col gap-1.5">
            <div className="flex items-baseline justify-between text-xs">
              <span className="text-muted-foreground">Share of execution</span>
              <span className="font-mono font-semibold">{(selected.share * 100).toFixed(1)}%</span>
            </div>
            <div className="bg-chart-track h-1.5 overflow-hidden rounded-full" aria-hidden="true">
              <span
                className="bg-chart-1 block h-full rounded-full"
                style={{ width: `${Math.max(selected.share * 100, 1)}%` }}
              />
            </div>
          </div>
          <KeyValue label="Self / total time" value={`${formatMs(selected.selfMs)} / ${formatMs(selected.totalMs)}`} />
          <KeyValue
            label="Rows · actual / est."
            value={`${selected.actualRows === null ? '—' : formatInt(selected.actualRows)} / ${selected.planRows === null ? '—' : formatInt(selected.planRows)}`}
          />
          {nodeDetails(selected.node).map((d) => (
            <KeyValue key={d.key} label={d.key} value={d.value} />
          ))}
          <div className="mt-3.5 flex gap-2">
            <Button type="button" variant="outline" size="sm" className="h-7 text-xs" onClick={() => void copyPlan()}>
              <Copy className="size-3.5" aria-hidden="true" />
              Copy JSON plan
            </Button>
          </div>
        </aside>
      )}
    </div>
  );
}

function KeyValue({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex justify-between gap-3 border-b py-[7px] text-xs last:border-b-0">
      <span className="text-muted-foreground shrink-0">{label}</span>
      <span className="selectable min-w-0 text-right font-mono break-words">{value}</span>
    </div>
  );
}

function PlanTableRow({ row, selected, onSelect }: { row: PlanRow; selected: boolean; onSelect(): void }) {
  const target = nodeTarget(row.node);
  const summary = nodeSummary(row.node);
  const indent = row.depth * 20;
  const hasChildren = (row.node.Plans?.length ?? 0) > 0;
  return (
    <tr
      aria-selected={selected}
      tabIndex={0}
      onClick={onSelect}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          onSelect();
        }
      }}
      className={cn(
        'cursor-default outline-none focus-visible:bg-accent',
        selected
          ? 'bg-brand-soft shadow-[inset_2px_0_0_var(--brand)]'
          : 'hover:bg-foreground/[0.025] dark:hover:bg-white/[0.03]',
      )}
    >
      <td className="border-b px-3 py-2.5 align-top">
        <div className="flex flex-wrap items-center gap-1.5" style={{ paddingLeft: indent }}>
          {row.depth > 0 && (
            <span className="text-muted-foreground font-mono" aria-hidden="true">
              └
            </span>
          )}
          {hasChildren ? (
            <ChevronDown className="text-muted-foreground size-[13px]" aria-hidden="true" />
          ) : (
            <span className="w-[13px]" aria-hidden="true" />
          )}
          <b className="font-semibold">{row.node['Node Type']}</b>
          {target && <span className="text-muted-foreground">{target.split(' ')[0]}</span>}
          {target && <span className="font-mono">{target.split(' ').slice(1).join(' ')}</span>}
          {row.hottest && (
            <span className="border-warning-line bg-warning-bg text-warning inline-flex h-[18px] items-center gap-1 rounded-full border px-1.5 text-[10.5px] font-semibold">
              <Flame className="size-2.5" aria-hidden="true" />
              Most self time
            </span>
          )}
        </div>
        {summary && (
          <div
            className="text-muted-foreground font-mono text-[11px]"
            style={{ paddingLeft: indent + (row.depth > 0 ? 27 : 19) }}
          >
            {summary}
          </div>
        )}
      </td>
      <td className="border-b px-3 py-2.5 text-right align-top font-mono whitespace-nowrap">
        {row.actualRows === null ? '—' : formatInt(row.actualRows)} /{' '}
        {row.planRows === null ? '—' : formatInt(row.planRows)}
      </td>
      <td className="border-b px-3 py-2.5 text-right align-top font-mono whitespace-nowrap">
        {row.loops === null ? '—' : formatInt(row.loops)}
      </td>
      <td className="border-b px-3 py-2.5 align-top">
        <div className="flex justify-between font-mono">
          {row.hottest ? <b className="font-semibold">{formatMs(row.selfMs)}</b> : <span>{formatMs(row.selfMs)}</span>}
          <span className="text-muted-foreground">{(row.share * 100).toFixed(1)}%</span>
        </div>
        <div
          className="bg-chart-track mt-1.5 h-1.5 overflow-hidden rounded-full"
          role="img"
          aria-label={`${(row.share * 100).toFixed(1)}% of execution time`}
        >
          <span
            className="bg-chart-1 block h-full rounded-full"
            style={{ width: `${row.share > 0 ? Math.max(row.share * 100, 1.5) : 0}%` }}
          />
        </div>
      </td>
      <td className="border-b px-3 py-2.5 text-right align-top font-mono whitespace-nowrap">{formatMs(row.totalMs)}</td>
    </tr>
  );
}
