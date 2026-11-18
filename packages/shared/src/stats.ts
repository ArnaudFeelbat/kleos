import { z } from 'zod';

export const statsKinds = ['sessions', 'locks', 'throughput', 'tables', 'indexes', 'statements'] as const;
export const StatsKind = z.enum(statsKinds);
export type StatsKind = z.infer<typeof StatsKind>;

/** Poll interval per panel, in milliseconds, from the spec. */
export const statsIntervals: Record<StatsKind, number> = {
  sessions: 2000,
  locks: 2000,
  throughput: 5000,
  tables: 30000,
  indexes: 30000,
  statements: 30000,
};

export const BackendSession = z.object({
  pid: z.number(),
  user: z.string().nullable(),
  database: z.string().nullable(),
  application: z.string(),
  client: z.string().nullable(),
  /** active, idle, idle in transaction, idle in transaction (aborted), fastpath function call, disabled, or null */
  state: z.string().nullable(),
  waitEventType: z.string().nullable(),
  waitEvent: z.string().nullable(),
  backendStart: z.string().nullable(),
  xactStart: z.string().nullable(),
  queryStart: z.string().nullable(),
  /** Seconds since xact_start, computed by the server clock. */
  xactAgeSec: z.number().nullable(),
  /** Seconds since query_start. */
  queryAgeSec: z.number().nullable(),
  query: z.string(),
  backendType: z.string().nullable(),
  blockedBy: z.array(z.number()),
  /** True for a backend opened by this Kleos session. */
  isSelf: z.boolean(),
});
export type BackendSession = z.infer<typeof BackendSession>;

export const SessionsStats = z.object({
  kind: z.literal('sessions'),
  maxConnections: z.number(),
  sessions: z.array(BackendSession),
});

export const LockWait = z.object({
  pid: z.number(),
  user: z.string().nullable(),
  application: z.string(),
  state: z.string().nullable(),
  query: z.string(),
  waitingSec: z.number().nullable(),
  /** pg_blocking_pids(pid) */
  blockedBy: z.array(z.number()),
  /** Mode and relation of the lock being waited for, when known, e.g. "RowExclusiveLock on public.accounts". */
  waitingFor: z.string().nullable(),
});
export type LockWait = z.infer<typeof LockWait>;

export const LocksStats = z.object({
  kind: z.literal('locks'),
  /** Backends waiting on a lock. */
  blocked: z.array(LockWait),
  /** Backends that block others, with their own details. */
  blockers: z.array(LockWait),
});

export const ThroughputSample = z.object({
  /** ISO time of the sample */
  t: z.string(),
  commitsPerSec: z.number(),
  rollbacksPerSec: z.number(),
  /** commits + rollbacks */
  xactPerSec: z.number(),
  tuplesReturnedPerSec: z.number(),
  tuplesFetchedPerSec: z.number(),
  blocksReadPerSec: z.number(),
  /** blks_hit / (blks_hit + blks_read) over the interval, 0..1, null when no block was touched */
  cacheHitRatio: z.number().nullable(),
});
export type ThroughputSample = z.infer<typeof ThroughputSample>;

export const ThroughputStats = z.object({
  kind: z.literal('throughput'),
  /** In-memory samples of the last 15 minutes, oldest first; empty until two snapshots exist. */
  samples: z.array(ThroughputSample),
  /** Since the stats reset, for a headline when samples are few. */
  cacheHitRatioTotal: z.number().nullable(),
  numBackends: z.number(),
});

export const TableHealth = z.object({
  schema: z.string(),
  name: z.string(),
  totalBytes: z.number(),
  liveTuples: z.number(),
  deadTuples: z.number(),
  lastVacuum: z.string().nullable(),
  lastAutovacuum: z.string().nullable(),
  lastAnalyze: z.string().nullable(),
  lastAutoanalyze: z.string().nullable(),
});
export type TableHealth = z.infer<typeof TableHealth>;

export const TablesStats = z.object({ kind: z.literal('tables'), tables: z.array(TableHealth) });

export const IndexUsage = z.object({
  schema: z.string(),
  table: z.string(),
  name: z.string(),
  scans: z.number(),
  tuplesRead: z.number(),
  bytes: z.number(),
  unique: z.boolean(),
});
export type IndexUsage = z.infer<typeof IndexUsage>;

export const IndexesStats = z.object({ kind: z.literal('indexes'), indexes: z.array(IndexUsage) });

export const SlowStatement = z.object({
  query: z.string(),
  calls: z.number(),
  meanMs: z.number(),
  totalMs: z.number(),
  rows: z.number(),
});
export type SlowStatement = z.infer<typeof SlowStatement>;

export const StatementsStats = z.object({
  kind: z.literal('statements'),
  /** False when pg_stat_statements is not installed in this database. */
  available: z.boolean(),
  /** The statement to show instead of an error when unavailable. */
  installHint: z.string().nullable(),
  statements: z.array(SlowStatement),
});

export const StatsResult = z.discriminatedUnion('kind', [
  SessionsStats,
  LocksStats,
  ThroughputStats,
  TablesStats,
  IndexesStats,
  StatementsStats,
]);
export type StatsResult = z.infer<typeof StatsResult>;
export type StatsResultOf<K extends StatsKind> = Extract<StatsResult, { kind: K }>;

export const BackendActionRequest = z.object({
  mode: z.enum(['cancel', 'terminate']),
});
export type BackendActionRequest = z.infer<typeof BackendActionRequest>;

export const BackendActionResult = z.object({
  /** What pg_cancel_backend / pg_terminate_backend returned. */
  ok: z.boolean(),
});
export type BackendActionResult = z.infer<typeof BackendActionResult>;
