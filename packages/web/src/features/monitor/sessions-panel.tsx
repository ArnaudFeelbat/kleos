import type { BackendSession, StatsResultOf } from '@kleos/shared';
import { TriangleExclamationPoint } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { formatDuration } from '@/lib/format';
import { cn } from '@/lib/utils';
import type { BackendActionRequest } from './backend-action-dialog';
import { formatWait, isClientBackend, sortSessions, stateKind } from './monitor-format';
import { Panel, PanelLoading, tbl } from './panel';

const MAX_ROWS = 200;

type Props = {
  stats: StatsResultOf<'sessions'> | undefined;
  /** pids blocking others, from the locks panel, listed first. */
  blockerPids: ReadonlySet<number>;
  /** pid -> pids waiting on it. */
  waitersOf: ReadonlyMap<number, number[]>;
  error: string | null;
  poll: string;
  onAction(request: BackendActionRequest): void;
};

export function StateBadge({ state }: { state: string | null }) {
  const kind = stateKind(state);
  if (kind === 'idle-in-transaction') {
    return (
      <Badge className="bg-warning-bg text-warning border-warning-line h-5 text-[11px]">
        <TriangleExclamationPoint aria-hidden="true" />
        {state}
      </Badge>
    );
  }
  if (kind === 'active') {
    return (
      <Badge variant="outline" className="h-5 text-[11px]">
        <span className="bg-success size-1.5 rounded-full" aria-hidden="true" />
        active
      </Badge>
    );
  }
  return (
    <Badge variant="outline" className="text-muted-foreground h-5 text-[11px]">
      {state ?? 'unknown'}
    </Badge>
  );
}

/** pg_stat_activity client backends with Cancel / Terminate per row (confirmed by a dialog). */
export function SessionsPanel({ stats, blockerPids, waitersOf, error, poll, onAction }: Props) {
  const clients = stats ? sortSessions(stats.sessions.filter(isClientBackend), blockerPids) : [];
  const shown = clients.slice(0, MAX_ROWS);

  return (
    <Panel
      title="Sessions"
      poll={`pg_stat_activity · ${poll}`}
      error={error}
      extra={
        stats ? (
          <span className="text-muted-foreground text-xs">
            {clients.length} {clients.length === 1 ? 'backend' : 'backends'}
            {shown.length < clients.length && ` · ${shown.length} shown`}
          </span>
        ) : null
      }
    >
      {!stats ? (
        <PanelLoading rows={5} />
      ) : (
        <div className="relative overflow-x-auto">
          <table className={tbl.table}>
            <thead>
              <tr>
                <th className={cn(tbl.th, 'text-right')}>pid</th>
                <th className={tbl.th}>user</th>
                <th className={tbl.th}>application</th>
                <th className={tbl.th}>state</th>
                <th className={tbl.th}>wait</th>
                <th className={cn(tbl.th, 'text-right')}>xact age</th>
                <th className={cn(tbl.th, 'w-full')}>query</th>
                <th className={tbl.th}>
                  <span className="sr-only">Actions</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {shown.map((s) => (
                <SessionRow key={s.pid} session={s} waiterPids={waitersOf.get(s.pid) ?? []} onAction={onAction} />
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Panel>
  );
}

function SessionRow({
  session: s,
  waiterPids,
  onAction,
}: {
  session: BackendSession;
  waiterPids: number[];
  onAction(request: BackendActionRequest): void;
}) {
  const wait = formatWait(s.waitEventType, s.waitEvent);
  const target = { pid: s.pid, user: s.user, application: s.application };
  const idleInTx = stateKind(s.state) === 'idle-in-transaction';
  const selfTitle = s.isSelf ? 'This is a Kleos connection of this window' : undefined;
  return (
    <tr className={cn(idleInTx ? 'bg-warning-bg' : tbl.tr)}>
      <td className={cn(tbl.td, tbl.num)}>{s.pid}</td>
      <td className={tbl.td}>{s.user ?? '—'}</td>
      <td className={cn(tbl.td, 'text-muted-foreground')}>
        <span className="inline-flex items-center gap-1.5">
          <span className="max-w-[140px] truncate">{s.application || '—'}</span>
          {s.isSelf && (
            <Badge variant="outline" className="text-foreground h-4 px-1.5 text-[10px]">
              you
            </Badge>
          )}
        </span>
      </td>
      <td className={tbl.td}>
        <StateBadge state={s.state} />
      </td>
      <td className={cn(tbl.td, 'font-mono', s.waitEventType === 'Lock' ? 'text-warning' : 'text-muted-foreground')}>
        {wait ?? '—'}
      </td>
      <td className={cn(tbl.td, tbl.num, s.xactAgeSec === null && 'text-muted-foreground')}>
        {formatDuration(s.xactAgeSec)}
      </td>
      <td className={cn(tbl.td, 'max-w-px font-mono')}>
        {s.query ? (
          <Tooltip>
            <TooltipTrigger asChild>
              <span tabIndex={0} className="block truncate outline-none focus-visible:underline">
                {s.query}
              </span>
            </TooltipTrigger>
            <TooltipContent
              side="bottom"
              align="start"
              className="max-w-[560px] font-mono text-[11px] whitespace-pre-wrap"
            >
              {s.query}
            </TooltipContent>
          </Tooltip>
        ) : (
          <span className="text-muted-foreground">—</span>
        )}
      </td>
      <td className={tbl.td}>
        <div className="flex gap-1" title={selfTitle}>
          <Button
            variant="ghost"
            size="sm"
            className="h-7 px-2.5 text-xs"
            disabled={s.isSelf}
            aria-label={`Cancel the query of backend ${s.pid}`}
            onClick={() => onAction({ mode: 'cancel', target, waiterPids })}
          >
            Cancel
          </Button>
          <Button
            variant="ghost"
            size="sm"
            className="text-destructive hover:text-destructive h-7 px-2.5 text-xs"
            disabled={s.isSelf}
            aria-label={`Terminate backend ${s.pid}`}
            onClick={() => onAction({ mode: 'terminate', target, waiterPids })}
          >
            Terminate
          </Button>
        </div>
      </td>
    </tr>
  );
}
