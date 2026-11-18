import type { StatsResultOf } from '@kleos/shared';
import { TriangleExclamationPoint } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { formatAgo, formatBytes, formatCompact } from '@/lib/format';
import { cn } from '@/lib/utils';
import { DEAD_TUPLE_WARN_PCT, deadTuplePercent, lastVacuumed } from './monitor-format';
import { Panel, PanelEmpty, PanelLoading, tbl } from './panel';

const MAX_ROWS = 50;

type Common = { error: string | null; poll: string; now: number };

/** Size, dead tuples (bar + %, warning above 20 %), and last (auto)vacuum per table. */
export function TableHealthPanel({ stats, error, poll, now }: Common & { stats: StatsResultOf<'tables'> | undefined }) {
  const rows = stats ? [...stats.tables].sort((a, b) => b.totalBytes - a.totalBytes).slice(0, MAX_ROWS) : [];
  const pcts = rows.map((t) => deadTuplePercent(t) ?? 0);
  // Bars are relative to the worst table so small differences stay visible.
  const scale = Math.max(...pcts, 1);
  return (
    <Panel title="Table health" poll={poll} error={error}>
      {!stats ? (
        <PanelLoading />
      ) : rows.length === 0 ? (
        <PanelEmpty>No user tables.</PanelEmpty>
      ) : (
        <div className="max-h-[360px] overflow-auto">
          <table className={tbl.table}>
            <thead>
              <tr>
                <th className={tbl.th}>table</th>
                <th className={cn(tbl.th, 'text-right')}>size</th>
                <th className={tbl.th}>dead tuples</th>
                <th className={cn(tbl.th, 'text-right')}>vacuumed</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((t, i) => {
                const pct = deadTuplePercent(t);
                const warn = pct !== null && pct > DEAD_TUPLE_WARN_PCT;
                const vacuumed = lastVacuumed(t);
                return (
                  <tr key={`${t.schema}.${t.name}`} className={tbl.tr}>
                    <td className={cn(tbl.td, 'max-w-[160px] truncate font-mono')} title={`${t.schema}.${t.name}`}>
                      {t.name}
                    </td>
                    <td className={cn(tbl.td, tbl.num)}>{formatBytes(t.totalBytes)}</td>
                    <td className={tbl.td}>
                      <span className="inline-flex items-center gap-2">
                        <span
                          className="bg-chart-track inline-block h-1.5 w-16 overflow-hidden rounded-full"
                          aria-hidden="true"
                        >
                          <span
                            className={cn('block h-full rounded-full', warn ? 'bg-warning' : 'bg-chart-1')}
                            style={{ width: `${((pcts[i] ?? 0) / scale) * 100}%` }}
                          />
                        </span>
                        {pct === null ? (
                          <span className="text-muted-foreground font-mono">—</span>
                        ) : warn ? (
                          <span
                            className="text-warning inline-flex items-center gap-1 font-mono"
                            title={`${formatCompact(t.deadTuples)} dead tuples`}
                          >
                            <TriangleExclamationPoint className="size-[11px]" role="img" aria-label="Warning" />
                            {pct.toFixed(1)}%
                          </span>
                        ) : (
                          <span
                            className="text-muted-foreground font-mono"
                            title={`${formatCompact(t.deadTuples)} dead tuples`}
                          >
                            {pct.toFixed(1)}%
                          </span>
                        )}
                      </span>
                    </td>
                    <td
                      className={cn(tbl.td, 'text-muted-foreground text-right')}
                      title={vacuumed ? new Date(vacuumed).toLocaleString() : undefined}
                    >
                      {formatAgo(vacuumed, now)}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </Panel>
  );
}

/**
 * Scans and size per index, largest first. Indexes with 0 scans get an "unused" warning, except
 * unique ones: they enforce a constraint even when no query reads them.
 */
export function IndexUsagePanel({
  stats,
  error,
  poll,
}: Omit<Common, 'now'> & { stats: StatsResultOf<'indexes'> | undefined }) {
  const rows = stats ? [...stats.indexes].sort((a, b) => b.bytes - a.bytes).slice(0, MAX_ROWS) : [];
  return (
    <Panel title="Index usage" poll={poll} error={error}>
      {!stats ? (
        <PanelLoading />
      ) : rows.length === 0 ? (
        <PanelEmpty>No user indexes.</PanelEmpty>
      ) : (
        <div className="max-h-[360px] overflow-auto">
          <table className={tbl.table}>
            <thead>
              <tr>
                <th className={tbl.th}>index</th>
                <th className={cn(tbl.th, 'text-right')}>scans</th>
                <th className={cn(tbl.th, 'text-right')}>size</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((ix) => (
                <tr key={`${ix.schema}.${ix.name}`} className={tbl.tr}>
                  <td
                    className={cn(tbl.td, 'max-w-[180px] truncate font-mono')}
                    title={`${ix.schema}.${ix.name} on ${ix.table}`}
                  >
                    {ix.name}
                  </td>
                  <td className={cn(tbl.td, tbl.num)}>
                    {ix.scans === 0 && !ix.unique ? (
                      <Badge className="bg-warning-bg text-warning border-warning-line h-5 font-sans text-[11px]">
                        <TriangleExclamationPoint aria-hidden="true" />0 · unused
                      </Badge>
                    ) : (
                      formatCompact(ix.scans)
                    )}
                  </td>
                  <td className={cn(tbl.td, tbl.num)}>{formatBytes(ix.bytes)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Panel>
  );
}
