import type { BackendSession, LockWait, StatsResultOf, TableHealth } from '@kleos/shared';
import { formatDuration } from '@/lib/format';

/** Dead tuples above this share of a table get a warning icon. */
export const DEAD_TUPLE_WARN_PCT = 20;

/** pg_stat_activity also lists background workers; max_connections counts client backends. */
export function isClientBackend(s: BackendSession): boolean {
  return s.backendType === null || s.backendType === 'client backend';
}

export function sessionCounts(sessions: BackendSession[]) {
  const clients = sessions.filter(isClientBackend);
  return {
    total: clients.length,
    active: clients.filter((s) => s.state === 'active').length,
    idleInTransaction: clients.filter((s) => s.state?.startsWith('idle in transaction')).length,
  };
}

export type StateKind = 'active' | 'idle' | 'idle-in-transaction' | 'other';

export function stateKind(state: string | null): StateKind {
  if (state === 'active') return 'active';
  if (state === 'idle') return 'idle';
  if (state?.startsWith('idle in transaction')) return 'idle-in-transaction';
  return 'other';
}

/** "Lock: transactionid", "IO: DataFileRead"; null when the backend waits on nothing. */
export function formatWait(type: string | null, event: string | null): string | null {
  if (!type && !event) return null;
  if (!type) return event;
  if (!event) return type;
  return `${type}: ${event}`;
}

/**
 * Sessions table order: backends in a lock chain first, then by transaction age (oldest first),
 * idle backends without a transaction last.
 */
export function sortSessions(sessions: BackendSession[], blockerPids: ReadonlySet<number>): BackendSession[] {
  const rank = (s: BackendSession) => (blockerPids.has(s.pid) ? 0 : s.blockedBy.length > 0 ? 1 : 2);
  return [...sessions].sort(
    (a, b) => rank(a) - rank(b) || (b.xactAgeSec ?? -1) - (a.xactAgeSec ?? -1) || a.pid - b.pid,
  );
}

/** Dead tuples as a percentage of all tuples, null when the table is empty. */
export function deadTuplePercent(t: Pick<TableHealth, 'liveTuples' | 'deadTuples'>): number | null {
  const total = t.liveTuples + t.deadTuples;
  return total > 0 ? (t.deadTuples / total) * 100 : null;
}

/** The later of the last manual and the last auto vacuum. */
export function lastVacuumed(t: Pick<TableHealth, 'lastVacuum' | 'lastAutovacuum'>): string | null {
  const times = [t.lastVacuum, t.lastAutovacuum].filter((x): x is string => !!x);
  if (times.length === 0) return null;
  return times.reduce((a, b) => (Date.parse(a) >= Date.parse(b) ? a : b));
}

export type LockChain = {
  /** The blocking backend; only its pid is known when it is not in `blockers`. */
  blocker: LockWait | { pid: number };
  waiters: LockWait[];
};

/** Groups blocked backends under each backend that blocks them (one waiter may appear under several). */
export function groupLocks(locks: Pick<StatsResultOf<'locks'>, 'blocked' | 'blockers'>): LockChain[] {
  const byPid = new Map(locks.blockers.map((b) => [b.pid, b]));
  const chains = new Map<number, LockChain>();
  for (const waiter of locks.blocked) {
    for (const pid of waiter.blockedBy) {
      let chain = chains.get(pid);
      if (!chain) {
        chain = { blocker: byPid.get(pid) ?? { pid }, waiters: [] };
        chains.set(pid, chain);
      }
      chain.waiters.push(waiter);
    }
  }
  return [...chains.values()].sort((a, b) => b.waiters.length - a.waiters.length || a.blocker.pid - b.blocker.pid);
}

/** The blocked backend that has waited longest, for the KPI tile. */
export function longestWait(blocked: LockWait[]): { seconds: number; pid: number; blockerPid: number | null } | null {
  let best: LockWait | null = null;
  for (const w of blocked) if (!best || (w.waitingSec ?? 0) > (best.waitingSec ?? 0)) best = w;
  if (!best) return null;
  return { seconds: best.waitingSec ?? 0, pid: best.pid, blockerPid: best.blockedBy[0] ?? null };
}

export type BackendTarget = { pid: number; user: string | null; application: string };

/** Confirmation copy naming the pid and what the action does to it and to the backends it blocks. */
export function backendActionCopy(mode: 'cancel' | 'terminate', target: BackendTarget, waiterPids: number[]) {
  const who = target.user ?? target.application ?? 'this backend';
  const waiting =
    waiterPids.length === 0
      ? ''
      : waiterPids.length === 1
        ? ` Waiting query ${waiterPids[0]} will proceed.`
        : ` Waiting queries ${waiterPids.slice(0, -1).join(', ')} and ${waiterPids.at(-1)} will proceed.`;
  if (mode === 'terminate') {
    return {
      title: `Terminate backend ${target.pid}?`,
      description: `pg_terminate_backend closes ${who}'s connection and rolls back its open transaction.${waiting}`,
      confirm: 'Terminate',
    };
  }
  return {
    title: `Cancel the query of backend ${target.pid}?`,
    description: `pg_cancel_backend stops the statement ${who} is running; the connection stays open and an open transaction is aborted.${waiterPids.length > 0 ? ' Locks held by the transaction stay until it rolls back.' : ''}`,
    confirm: 'Cancel query',
  };
}

/** "Longest wait 3m 58s behind pid 48211" */
export function longestWaitText(w: NonNullable<ReturnType<typeof longestWait>>): string {
  return `Longest wait ${formatDuration(w.seconds)}${w.blockerPid !== null ? ` behind pid ${w.blockerPid}` : ''}`;
}
