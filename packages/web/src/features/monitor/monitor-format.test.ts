import type { BackendSession, LockWait } from '@kleos/shared';
import { describe, expect, it } from 'vitest';
import {
  backendActionCopy,
  deadTuplePercent,
  formatWait,
  groupLocks,
  lastVacuumed,
  longestWait,
  longestWaitText,
  sessionCounts,
  sortSessions,
  stateKind,
} from './monitor-format';

function session(pid: number, patch: Partial<BackendSession> = {}): BackendSession {
  return {
    pid,
    user: 'app',
    database: 'shop',
    application: 'node-pg',
    client: null,
    state: 'idle',
    waitEventType: null,
    waitEvent: null,
    backendStart: null,
    xactStart: null,
    queryStart: null,
    xactAgeSec: null,
    queryAgeSec: null,
    query: '',
    backendType: 'client backend',
    blockedBy: [],
    isSelf: false,
    ...patch,
  };
}

function wait(pid: number, blockedBy: number[], waitingSec: number | null = 10): LockWait {
  return {
    pid,
    user: 'app',
    application: 'billing_api',
    state: 'active',
    query: 'UPDATE …',
    waitingSec,
    blockedBy,
    waitingFor: null,
  };
}

describe('sessions', () => {
  it('counts client backends only', () => {
    const counts = sessionCounts([
      session(1, { state: 'active' }),
      session(2, { state: 'idle in transaction' }),
      session(3, { state: 'idle in transaction (aborted)' }),
      session(4),
      session(5, { backendType: 'autovacuum launcher', state: null }),
    ]);
    expect(counts).toEqual({ total: 4, active: 1, idleInTransaction: 2 });
  });

  it('classifies states and formats waits', () => {
    expect(stateKind('active')).toBe('active');
    expect(stateKind('idle in transaction (aborted)')).toBe('idle-in-transaction');
    expect(stateKind(null)).toBe('other');
    expect(formatWait('Lock', 'transactionid')).toBe('Lock: transactionid');
    expect(formatWait(null, null)).toBeNull();
  });

  it('puts blockers, then blocked, then the oldest transactions first', () => {
    const sorted = sortSessions(
      [
        session(1, { xactAgeSec: 5 }),
        session(2, { xactAgeSec: 50 }),
        session(3, { blockedBy: [4], xactAgeSec: 1 }),
        session(4, { xactAgeSec: 2 }),
        session(5),
      ],
      new Set([4]),
    );
    expect(sorted.map((s) => s.pid)).toEqual([4, 3, 2, 1, 5]);
  });
});

describe('locks', () => {
  it('groups waiters under their blockers, unknown blockers by pid', () => {
    const blocker = wait(48211, [], null);
    const chains = groupLocks({
      blockers: [blocker],
      blocked: [wait(48230, [48211], 238), wait(48244, [48211], 65), wait(5, [9])],
    });
    expect(chains).toHaveLength(2);
    expect(chains[0]!.blocker).toBe(blocker);
    expect(chains[0]!.waiters.map((w) => w.pid)).toEqual([48230, 48244]);
    expect(chains[1]!.blocker).toEqual({ pid: 9 });
  });

  it('finds the longest wait for the KPI tile', () => {
    const w = longestWait([wait(48230, [48211], 238), wait(48244, [48211], 65)]);
    expect(w).toEqual({ seconds: 238, pid: 48230, blockerPid: 48211 });
    expect(longestWaitText(w!)).toBe('Longest wait 3m 58s behind pid 48211');
    expect(longestWait([])).toBeNull();
  });
});

describe('table health', () => {
  it('computes dead tuple share and the last vacuum', () => {
    expect(deadTuplePercent({ liveTuples: 66, deadTuples: 34 })).toBeCloseTo(34);
    expect(deadTuplePercent({ liveTuples: 0, deadTuples: 0 })).toBeNull();
    expect(lastVacuumed({ lastVacuum: '2026-11-10T00:00:00Z', lastAutovacuum: '2026-11-17T00:00:00Z' })).toBe(
      '2026-11-17T00:00:00Z',
    );
    expect(lastVacuumed({ lastVacuum: null, lastAutovacuum: null })).toBeNull();
  });
});

describe('backendActionCopy', () => {
  const target = { pid: 48211, user: 'etl_writer', application: 'airflow' };

  it('names the pid, the consequence and the waiters it releases', () => {
    const copy = backendActionCopy('terminate', target, [48230, 48244]);
    expect(copy.title).toBe('Terminate backend 48211?');
    expect(copy.description).toBe(
      "pg_terminate_backend closes etl_writer's connection and rolls back its open transaction. Waiting queries 48230 and 48244 will proceed.",
    );
    expect(copy.confirm).toBe('Terminate');
  });

  it('explains that cancel keeps the connection', () => {
    const copy = backendActionCopy('cancel', target, []);
    expect(copy.title).toBe('Cancel the query of backend 48211?');
    expect(copy.description).toMatch(/connection stays open/);
  });
});
