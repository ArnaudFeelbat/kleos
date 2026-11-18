import { Pause, Play, TriangleExclamationPoint } from 'lucide-react';
import { useMemo, useState, type ReactNode } from 'react';
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
    <div className="bg-sidebar min-h-0 flex-1 overflow-y-auto">
      <TabToolbar tab="monitor">
        <span className="inline-flex items-center gap-1.5 text-xs" role="status">
          <span
            aria-hidden="true"
            className={cn(
              'size-2 rounded-full',
              live ? 'bg-[#22c55e] shadow-[0_0_0_3px_rgba(34,197,94,.2)]' : 'bg-muted-foreground',
            )}
          />
          {live ? 'Live' : paused ? 'Paused' : 'Paused while hidden'}
          <span className="text-muted-foreground">· pauses when this tab is hidden</span>
        </span>
        <Button variant="outline" size="sm" className="h-7 text-xs" onClick={() => setPaused((p) => !p)}>
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
}: {
  label: ReactNode;
  value: string;
  detail: ReactNode;
  warning?: boolean;
}) {
  return (
    <div
      className={cn(
        'bg-card flex min-w-0 flex-col gap-1 rounded-xl border p-4',
        warning && 'border-warning-line bg-warning-bg',
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
      <span className="font-mono text-[28px] font-semibold tracking-[-0.02em]">{value}</span>
      <span className={cn('truncate text-xs', !warning && 'text-muted-foreground')}>{detail}</span>
    </div>
  );
}
