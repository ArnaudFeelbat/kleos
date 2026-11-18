import type { BackendSession, StatsResultOf } from '@kleos/shared';
import { CircleCheck, TriangleExclamationPoint } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { formatDuration } from '@/lib/format';
import type { BackendActionRequest } from './backend-action-dialog';
import { groupLocks } from './monitor-format';
import { Panel, PanelEmpty } from './panel';

type Props = {
  locks: StatsResultOf<'locks'> | undefined;
  sessions: BackendSession[] | undefined;
  error: string | null;
  poll: string;
  onAction(request: BackendActionRequest): void;
};

/** Blocked -> blocker relationships: each blocker with the backends waiting behind it. */
export function LocksPanel({ locks, sessions, error, poll, onAction }: Props) {
  const chains = locks ? groupLocks(locks) : [];
  const blockedCount = locks?.blocked.length ?? 0;
  const sessionByPid = new Map((sessions ?? []).map((s) => [s.pid, s]));

  return (
    <Panel
      title="Locks"
      poll={`pg_locks · ${poll}`}
      error={error}
      extra={
        blockedCount > 0 ? (
          <Badge className="bg-warning-bg text-warning border-warning-line h-5 text-[11px]">
            <TriangleExclamationPoint aria-hidden="true" />
            {blockedCount} blocked
          </Badge>
        ) : null
      }
    >
      {!locks ? (
        <PanelEmpty>Loading…</PanelEmpty>
      ) : chains.length === 0 ? (
        <p className="text-muted-foreground flex items-center justify-center gap-2 px-4 py-6 text-xs">
          <CircleCheck className="text-success size-4" aria-hidden="true" />
          No query is waiting on a lock.
        </p>
      ) : (
        <ul className="flex max-h-[420px] flex-col gap-4 overflow-y-auto px-4 py-3.5">
          {chains.map(({ blocker, waiters }) => {
            const details = 'query' in blocker ? blocker : null;
            const session = sessionByPid.get(blocker.pid);
            const who = details?.user ?? session?.user ?? details?.application ?? session?.application ?? '';
            const state = details?.state ?? session?.state ?? null;
            const query = details?.query ?? session?.query ?? '';
            const isSelf = session?.isSelf ?? false;
            const target = {
              pid: blocker.pid,
              user: details?.user ?? session?.user ?? null,
              application: details?.application ?? session?.application ?? '',
            };
            const waiterPids = waiters.map((w) => w.pid);
            return (
              <li key={blocker.pid} className="flex flex-col gap-2.5">
                <div className="bg-warning-bg border-warning-line flex flex-col gap-1 rounded-lg border px-3 py-2.5">
                  <span className="flex items-center gap-1.5 text-xs">
                    <span className="text-muted-foreground">Blocker</span>
                    <b className="font-mono font-semibold">{blocker.pid}</b>
                    <span className="text-muted-foreground truncate">{who}</span>
                  </span>
                  {(state || session?.xactAgeSec != null) && (
                    <span className="text-xs">
                      {state ?? 'unknown state'}
                      {session?.xactAgeSec != null && (
                        <>
                          {' · '}
                          <b className="font-mono font-semibold">{formatDuration(session.xactAgeSec)}</b>
                        </>
                      )}
                    </span>
                  )}
                  {query && (
                    <span className="text-muted-foreground truncate font-mono text-[11px]" title={query}>
                      {query}
                    </span>
                  )}
                </div>
                <ul className="ml-3 flex flex-col gap-2 border-l-2 pl-3.5" aria-label={`Waiting on ${blocker.pid}`}>
                  {waiters.map((w) => (
                    <li key={w.pid} className="flex min-w-0 flex-col gap-0.5 text-xs">
                      <span>
                        <span className="text-muted-foreground">waits</span>{' '}
                        <b className="font-mono font-semibold">{w.pid}</b>{' '}
                        <span className="text-muted-foreground">
                          {w.application || w.user || ''} · {formatDuration(w.waitingSec)}
                        </span>
                      </span>
                      {w.waitingFor && <span className="text-warning font-mono text-[11px]">{w.waitingFor}</span>}
                      <span className="text-muted-foreground truncate font-mono text-[11px]" title={w.query}>
                        {w.query}
                      </span>
                    </li>
                  ))}
                </ul>
                <div className="flex gap-2">
                  <Button
                    variant="outline"
                    size="sm"
                    className="h-7 text-xs"
                    disabled={isSelf}
                    onClick={() => onAction({ mode: 'cancel', target, waiterPids })}
                  >
                    Cancel {blocker.pid}
                  </Button>
                  <Button
                    variant="outline"
                    size="sm"
                    className="text-destructive hover:text-destructive h-7 text-xs"
                    disabled={isSelf}
                    onClick={() => onAction({ mode: 'terminate', target, waiterPids })}
                  >
                    Terminate {blocker.pid}
                  </Button>
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </Panel>
  );
}
