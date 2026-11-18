import { Pause, Play, TriangleExclamationPoint } from 'lucide-react';
import { useId, useMemo, useState, type ReactNode } from 'react';
import { Button } from '@/components/ui/button';
import { useWorkspace } from '@/features/workspace/context';
import { TabToolbar, useDocumentVisible } from '@/features/workspace/tab-toolbar';
import { errorText } from '@/lib/api';
import { formatInt, formatNumber, formatPercent } from '@/lib/format';
import { cn } from '@/lib/utils';
import { BackendActionDialog, type BackendActionRequest } from './backend-action-dialog';
import { IndexUsagePanel, TableHealthPanel } from './health-panels';
import { LocksPanel } from './locks-panel';
import { groupLocks, longestWait, longestWaitText, sessionCounts } from './monitor-format';
import { Panel } from './panel';
import { SessionsPanel } from './sessions-panel';
import { SlowQueriesPanel } from './slow-queries-panel';
import { ThroughputChart } from './throughput-chart';
import { intervalLabel, useStats } from './use-stats';

/**
 * Monitor tab: KPI tiles, throughput, locks, sessions, table health, index usage and slow
 * queries. Each panel polls at its spec interval only while this tab is active, the window is
 * visible and the user has not paused.
 */
export function MonitorTab() {
  const { activeTab, visible: tabInFront } = useWorkspace();
  const visible = useDocumentVisible();
  const [paused, setPaused] = useState(false);
  const live = tabInFront && activeTab === 'monitor' && visible && !paused;

  const sessions = useStats('sessions', live);
  const locks = useStats('locks', live);
  const throughput = useStats('throughput', live);
  const tables = useStats('tables', live);
  const indexes = useStats('indexes', live);
  const statements = useStats('statements', live);
  const [action, setAction] = useState<BackendActionRequest | null>(null);

  const chains = useMemo(() => (locks.data ? groupLocks(locks.data) : []), [locks.data]);
  const blockerPids = useMemo(() => new Set(chains.map((c) => c.blocker.pid)), [chains]);
  const waitersOf = useMemo(() => new Map(chains.map((c) => [c.blocker.pid, c.waiters.map((w) => w.pid)])), [chains]);

  const counts = sessions.data ? sessionCounts(sessions.data.sessions) : null;
  const samples = throughput.data?.samples ?? [];
  const lastSample = samples.at(-1);
  const hitRatio = lastSample?.cacheHitRatio ?? throughput.data?.cacheHitRatioTotal ?? null;
  const blocked = locks.data?.blocked ?? null;
  const wait = blocked ? longestWait(blocked) : null;
  const err = (q: { error: unknown }) => (q.error ? errorText(q.error) : null);

  return (
    <div className="bg-sidebar dark:bg-background min-h-0 flex-1 overflow-y-auto">
      <TabToolbar tab="monitor">
        <span className="inline-flex items-center gap-1.5 text-xs" role="status">
          <span className="relative flex size-2" aria-hidden="true">
            {live && <span className="bg-success absolute inset-0 animate-ping rounded-full opacity-40" />}
            <span
              className={cn(
                'relative size-2 rounded-full',
                live
                  ? 'bg-success shadow-[0_0_0_3px_color-mix(in_srgb,var(--success)_20%,transparent)]'
                  : 'border-muted-foreground border-[1.5px]',
              )}
            />
          </span>
          <span className="font-medium">{live ? 'Live' : paused ? 'Paused' : 'Paused while hidden'}</span>
          <span className="text-muted-foreground">· pauses when this tab is hidden</span>
        </span>
        <Button variant="outline" size="sm" onClick={() => setPaused((p) => !p)}>
          {paused ? <Play className="size-3" aria-hidden="true" /> : <Pause className="size-3" aria-hidden="true" />}
          {paused ? 'Resume' : 'Pause'}
        </Button>
      </TabToolbar>

      <div className="flex flex-col gap-4 p-4">
        <div className="grid grid-cols-[repeat(auto-fit,minmax(220px,1fr))] gap-4">
          <Kpi
            label="Sessions"
            value={counts ? formatInt(counts.total) : '—'}
            detail={
              counts && sessions.data
                ? `${counts.active} active · ${counts.idleInTransaction} idle in transaction · max ${sessions.data.maxConnections}`
                : 'pg_stat_activity'
            }
          />
          <Kpi
            label="Transactions / s"
            value={lastSample ? formatNumber(lastSample.xactPerSec) : '—'}
            detail={lastSample ? 'Commits + rollbacks, last 5 s' : 'Needs two samples, 5 s apart'}
            aside={<Sparkline values={samples.map((s) => s.xactPerSec)} />}
          />
          <Kpi label="Cache hit ratio" value={formatPercent(hitRatio)} detail="Shared blocks hit / (hit + read)" />
          {blocked && blocked.length > 0 ? (
            <Kpi
              warning
              label={
                <>
                  <TriangleExclamationPoint className="size-3.5" aria-hidden="true" />
                  Blocked queries · warning
                </>
              }
              value={formatInt(blocked.length)}
              detail={wait ? longestWaitText(wait) : null}
            />
          ) : (
            <Kpi label="Blocked queries" value={blocked ? '0' : '—'} detail="None waiting on a lock" />
          )}
        </div>

        <div className="grid grid-cols-1 gap-4 xl:grid-cols-3">
          <Panel
            className="xl:col-span-2"
            title="Transactions per second"
            extra={<span className="text-muted-foreground text-xs">last 15 minutes</span>}
            poll={`pg_stat_database · ${intervalLabel('throughput')}`}
            error={err(throughput)}
          >
            <ThroughputChart samples={samples} />
          </Panel>
          <LocksPanel
            locks={locks.data}
            sessions={sessions.data?.sessions}
            error={err(locks)}
            poll={intervalLabel('locks')}
            onAction={setAction}
          />
        </div>

        <SessionsPanel
          stats={sessions.data}
          blockerPids={blockerPids}
          waitersOf={waitersOf}
          error={err(sessions)}
          poll={intervalLabel('sessions')}
          onAction={setAction}
        />

        <div className="grid grid-cols-1 gap-4 xl:grid-cols-3">
          <TableHealthPanel
            stats={tables.data}
            error={err(tables)}
            poll={intervalLabel('tables')}
            now={tables.dataUpdatedAt}
          />
          <IndexUsagePanel stats={indexes.data} error={err(indexes)} poll={intervalLabel('indexes')} />
          <SlowQueriesPanel stats={statements.data} error={err(statements)} poll={intervalLabel('statements')} />
        </div>
      </div>

      <BackendActionDialog request={action} onClose={() => setAction(null)} />
    </div>
  );
}

function Kpi({
  label,
  value,
  detail,
  warning,
  aside,
}: {
  label: ReactNode;
  value: string;
  detail: ReactNode;
  warning?: boolean;
  /** Small decoration next to the number (the throughput sparkline). */
  aside?: ReactNode;
}) {
  return (
    <div
      className={cn(
        'flex min-w-0 flex-col gap-1.5 rounded-xl px-4 pt-3.5 pb-3.5',
        warning ? 'bg-warning-bg shadow-[0_0_0_1px_var(--warning-line),var(--elev-1)]' : 'surface-raised',
      )}
    >
      <span
        className={cn(
          'inline-flex items-center gap-1.5 text-xs font-medium',
          warning ? 'text-warning' : 'text-muted-foreground',
        )}
      >
        {label}
      </span>
      <div className="flex min-w-0 items-end justify-between gap-3">
        <span className="tabular text-[27px] leading-[1.1] font-semibold tracking-[-0.025em]">{value}</span>
        {aside}
      </div>
      <span className={cn('truncate text-xs', warning ? 'text-foreground/80' : 'text-muted-foreground')}>{detail}</span>
    </div>
  );
}

/**
 * Decorative trend of the throughput samples already loaded for the chart below (no request of
 * its own). Hidden from assistive tech: the number and the chart carry the information.
 */
function Sparkline({ values }: { values: number[] }) {
  // useId may contain characters that url(#…) does not accept.
  const gradientId = `spark${useId().replace(/[^\w-]/g, '')}`;
  if (values.length < 3) return null;
  const w = 88;
  const h = 28;
  const max = Math.max(...values);
  const min = Math.min(...values);
  const span = max - min || 1;
  const step = w / (values.length - 1);
  const points = values.map((v, i) => [i * step, h - 2 - ((v - min) / span) * (h - 4)] as const);
  const line = points.map(([x, y], i) => `${i === 0 ? 'M' : 'L'}${x.toFixed(1)} ${y.toFixed(1)}`).join(' ');
  const last = points.at(-1)!;
  return (
    <svg width={w} height={h} viewBox={`0 0 ${w} ${h}`} className="mb-1 shrink-0 overflow-visible" aria-hidden="true">
      <defs>
        <linearGradient id={gradientId} x1="0" x2="0" y1="0" y2="1">
          <stop offset="0%" stopColor="var(--chart-1)" stopOpacity="0.22" />
          <stop offset="100%" stopColor="var(--chart-1)" stopOpacity="0" />
        </linearGradient>
      </defs>
      <path d={`${line} L${w} ${h} L0 ${h} Z`} fill={`url(#${gradientId})`} />
      <path
        d={line}
        fill="none"
        stroke="var(--chart-1)"
        strokeWidth={1.5}
        strokeLinejoin="round"
        strokeLinecap="round"
      />
      <circle cx={last[0]} cy={last[1]} r={2.5} fill="var(--chart-1)" stroke="var(--card)" strokeWidth={1.5} />
    </svg>
  );
}
