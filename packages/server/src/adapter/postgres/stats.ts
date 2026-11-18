import {
  type BackendActionResult,
  type BackendSession,
  type IndexUsage,
  type LockWait,
  type SlowStatement,
  type StatsKind,
  type StatsResult,
  type TableHealth,
  type ThroughputSample,
  quoteIdent,
} from '@kleos/shared';
import { isPgError } from '../../errors';
import { type Queryable, metaQuery } from './types';

/** Throughput samples are kept this long, oldest dropped first. */
const THROUGHPUT_WINDOW_MS = 15 * 60 * 1000;
const STATEMENTS_LIMIT = 50;

type DatabaseCounters = {
  xact_commit: number;
  xact_rollback: number;
  tup_returned: number;
  tup_fetched: number;
  blks_read: number;
  blks_hit: number;
  numbackends: number;
};

type Snapshot = { at: number; counters: DatabaseCounters };

/**
 * The six monitoring snapshots. Holds the previous pg_stat_database snapshot and the last
 * 15 minutes of throughput samples for this session.
 */
export class StatsCollector {
  private previous: Snapshot | null = null;
  private samples: ThroughputSample[] = [];

  constructor(
    private readonly q: Queryable,
    /** Backend pids opened by this session (pool and tab clients). */
    private readonly ownPids: Set<number>,
    private readonly serverVersionNum: number,
  ) {}

  collect(kind: StatsKind): Promise<StatsResult> {
    switch (kind) {
      case 'sessions':
        return this.sessions();
      case 'locks':
        return this.locks();
      case 'throughput':
        return this.throughput();
      case 'tables':
        return this.tables();
      case 'indexes':
        return this.indexes();
      case 'statements':
        return this.statements();
    }
  }

  async backendAction(pid: number, mode: 'cancel' | 'terminate'): Promise<BackendActionResult> {
    const fn = mode === 'cancel' ? 'pg_cancel_backend' : 'pg_terminate_backend';
    const rows = await metaQuery<{ ok: boolean | null }>(this.q, `select ${fn}($1::int) as ok`, [pid]);
    return { ok: rows[0]?.ok === true };
  }

  private async sessions(): Promise<StatsResult> {
    const rows = await metaQuery<{
      pid: number;
      user: string | null;
      database: string | null;
      application: string;
      client: string | null;
      state: string | null;
      wait_event_type: string | null;
      wait_event: string | null;
      backend_start: string | null;
      xact_start: string | null;
      query_start: string | null;
      xact_age_sec: number | null;
      query_age_sec: number | null;
      query: string;
      backend_type: string | null;
      blocked_by: number[];
      max_connections: number;
    }>(
      this.q,
      `select a.pid, a.usename::text as user, a.datname::text as database,
              coalesce(a.application_name, '') as application,
              coalesce(host(a.client_addr), case when a.client_port = -1 then 'local' end) as client,
              a.state, a.wait_event_type, a.wait_event,
              a.backend_start::text as backend_start, a.xact_start::text as xact_start,
              a.query_start::text as query_start,
              extract(epoch from now() - a.xact_start)::float8 as xact_age_sec,
              extract(epoch from now() - a.query_start)::float8 as query_age_sec,
              coalesce(a.query, '') as query, a.backend_type,
              pg_blocking_pids(a.pid) as blocked_by,
              current_setting('max_connections')::int as max_connections
         from pg_stat_activity a
        order by a.backend_type is distinct from 'client backend', a.backend_start, a.pid`,
    );
    const sessions: BackendSession[] = rows.map((r) => ({
      pid: r.pid,
      user: r.user,
      database: r.database,
      application: r.application,
      client: r.client,
      state: r.state,
      waitEventType: r.wait_event_type,
      waitEvent: r.wait_event,
      backendStart: r.backend_start,
      xactStart: r.xact_start,
      queryStart: r.query_start,
      xactAgeSec: r.xact_age_sec,
      queryAgeSec: r.query_age_sec,
      query: r.query,
      backendType: r.backend_type,
      blockedBy: r.blocked_by ?? [],
      isSelf: this.ownPids.has(r.pid),
    }));
    let maxConnections = rows[0]?.max_connections;
    if (maxConnections === undefined) {
      const setting = await metaQuery<{ max: number }>(this.q, `select current_setting('max_connections')::int as max`);
      maxConnections = setting[0]?.max ?? 0;
    }
    return { kind: 'sessions', maxConnections, sessions };
  }

  private async locks(): Promise<StatsResult> {
    // pg_locks.waitstart exists from PostgreSQL 14; before that the wait is timed from query_start.
    const waitStart = this.serverVersionNum >= 140000 ? 'coalesce(l.waitstart, a.query_start)' : 'a.query_start';
    const rows = await metaQuery<{
      pid: number;
      user: string | null;
      application: string;
      state: string | null;
      query: string;
      blocked_by: number[];
      waiting_for: string | null;
      waiting_sec: number | null;
      is_blocked: boolean;
      is_blocker: boolean;
    }>(
      this.q,
      `with waits as (
         select pid, pg_blocking_pids(pid) as blocked_by
           from pg_stat_activity
          where cardinality(pg_blocking_pids(pid)) > 0
       ), involved as (
         select pid from waits
         union
         select unnest(blocked_by) from waits
       ), lock_waits as (
         select distinct on (l.pid) l.pid,
                l.mode || ' on ' || case
                  when c.oid is not null and l.locktype = 'relation' then quote_ident(n.nspname) || '.' || quote_ident(c.relname)
                  when c.oid is not null then l.locktype || ' of ' || quote_ident(n.nspname) || '.' || quote_ident(c.relname)
                  when l.locktype = 'transactionid' then 'transaction ' || l.transactionid::text
                  when l.locktype = 'virtualxid' then 'virtual transaction ' || l.virtualxid
                  else l.locktype
                end as waiting_for,
                extract(epoch from now() - ${waitStart})::float8 as waiting_sec
           from pg_locks l
           join pg_stat_activity a on a.pid = l.pid
           left join pg_class c on c.oid = l.relation
           left join pg_namespace n on n.oid = c.relnamespace
          where not l.granted
          order by l.pid, l.locktype = 'relation' desc
       )
       select a.pid, a.usename::text as user, coalesce(a.application_name, '') as application, a.state,
              coalesce(a.query, '') as query, coalesce(w.blocked_by, '{}') as blocked_by,
              lw.waiting_for, lw.waiting_sec,
              w.pid is not null as is_blocked,
              exists (select 1 from waits w2 where a.pid = any (w2.blocked_by)) as is_blocker
         from pg_stat_activity a
         join involved i on i.pid = a.pid
         left join waits w on w.pid = a.pid
         left join lock_waits lw on lw.pid = a.pid
        order by a.pid`,
    );
    const toWait = (r: (typeof rows)[number]): LockWait => ({
      pid: r.pid,
      user: r.user,
      application: r.application,
      state: r.state,
      query: r.query,
      waitingSec: r.waiting_sec,
      blockedBy: r.blocked_by ?? [],
      waitingFor: r.waiting_for,
    });
    return {
      kind: 'locks',
      blocked: rows.filter((r) => r.is_blocked).map(toWait),
      blockers: rows.filter((r) => r.is_blocker).map(toWait),
    };
  }

  private async throughput(): Promise<StatsResult> {
    const rows = await metaQuery<DatabaseCounters>(
      this.q,
      `select xact_commit::float8 as xact_commit, xact_rollback::float8 as xact_rollback,
              tup_returned::float8 as tup_returned, tup_fetched::float8 as tup_fetched,
              blks_read::float8 as blks_read, blks_hit::float8 as blks_hit, numbackends
         from pg_stat_database
        where datname = current_database()`,
    );
    const counters = rows[0];
    const now = Date.now();
    if (counters) {
      const previous = this.previous;
      this.previous = { at: now, counters };
      if (previous) this.addSample(previous, this.previous);
    }
    this.samples = this.samples.filter((s) => now - Date.parse(s.t) <= THROUGHPUT_WINDOW_MS);
    const touched = counters ? counters.blks_hit + counters.blks_read : 0;
    return {
      kind: 'throughput',
      samples: [...this.samples],
      cacheHitRatioTotal: counters && touched > 0 ? counters.blks_hit / touched : null,
      numBackends: counters?.numbackends ?? 0,
    };
  }

  private addSample(before: Snapshot, after: Snapshot): void {
    const seconds = (after.at - before.at) / 1000;
    if (seconds <= 0) return;
    const delta = (key: keyof DatabaseCounters) => after.counters[key] - before.counters[key];
    // A negative delta means the statistics were reset: skip this interval.
    const keys = ['xact_commit', 'xact_rollback', 'tup_returned', 'tup_fetched', 'blks_read', 'blks_hit'] as const;
    if (keys.some((key) => delta(key) < 0)) return;
    const commits = delta('xact_commit') / seconds;
    const rollbacks = delta('xact_rollback') / seconds;
    const touched = delta('blks_hit') + delta('blks_read');
    this.samples.push({
      t: new Date(after.at).toISOString(),
      commitsPerSec: commits,
      rollbacksPerSec: rollbacks,
      xactPerSec: commits + rollbacks,
      tuplesReturnedPerSec: delta('tup_returned') / seconds,
      tuplesFetchedPerSec: delta('tup_fetched') / seconds,
      blocksReadPerSec: delta('blks_read') / seconds,
      cacheHitRatio: touched > 0 ? delta('blks_hit') / touched : null,
    });
  }

  private async tables(): Promise<StatsResult> {
    const rows = await metaQuery<{
      schema: string;
      name: string;
      total_bytes: number;
      live_tuples: number;
      dead_tuples: number;
      last_vacuum: string | null;
      last_autovacuum: string | null;
      last_analyze: string | null;
      last_autoanalyze: string | null;
    }>(
      this.q,
      `select s.schemaname::text as schema, s.relname::text as name,
              pg_total_relation_size(s.relid)::float8 as total_bytes,
              s.n_live_tup::float8 as live_tuples, s.n_dead_tup::float8 as dead_tuples,
              s.last_vacuum::text as last_vacuum, s.last_autovacuum::text as last_autovacuum,
              s.last_analyze::text as last_analyze, s.last_autoanalyze::text as last_autoanalyze
         from pg_stat_user_tables s
        order by total_bytes desc, schema, name`,
    );
    const tables: TableHealth[] = rows.map((r) => ({
      schema: r.schema,
      name: r.name,
      totalBytes: r.total_bytes,
      liveTuples: r.live_tuples,
      deadTuples: r.dead_tuples,
      lastVacuum: r.last_vacuum,
      lastAutovacuum: r.last_autovacuum,
      lastAnalyze: r.last_analyze,
      lastAutoanalyze: r.last_autoanalyze,
    }));
    return { kind: 'tables', tables };
  }

  private async indexes(): Promise<StatsResult> {
    const rows = await metaQuery<{
      schema: string;
      table: string;
      name: string;
      scans: number;
      tuples_read: number;
      bytes: number;
      unique: boolean;
    }>(
      this.q,
      `select s.schemaname::text as schema, s.relname::text as table, s.indexrelname::text as name,
              s.idx_scan::float8 as scans, s.idx_tup_read::float8 as tuples_read,
              pg_relation_size(s.indexrelid)::float8 as bytes, i.indisunique as unique
         from pg_stat_user_indexes s
         join pg_index i on i.indexrelid = s.indexrelid
        order by s.schemaname, s.relname, s.indexrelname`,
    );
    const indexes: IndexUsage[] = rows.map((r) => ({
      schema: r.schema,
      table: r.table,
      name: r.name,
      scans: r.scans,
      tuplesRead: r.tuples_read,
      bytes: r.bytes,
      unique: r.unique,
    }));
    return { kind: 'indexes', indexes };
  }

  /**
   * Top statements by total time from pg_stat_statements when the extension is installed in this
   * database. Missing, not preloaded or not readable: `available: false` with the statement to
   * run, never an error.
   */
  private async statements(): Promise<StatsResult> {
    const unavailable = (installHint: string): StatsResult => ({
      kind: 'statements',
      available: false,
      installHint,
      statements: [],
    });
    const extension = await metaQuery<{ schema: string; exec_time_columns: boolean }>(
      this.q,
      `select n.nspname::text as schema,
              exists (select 1 from pg_attribute a
                       where a.attrelid = to_regclass(format('%I.pg_stat_statements', n.nspname))
                         and a.attname = 'total_exec_time') as exec_time_columns
         from pg_extension e
         join pg_namespace n on n.oid = e.extnamespace
        where e.extname = 'pg_stat_statements'`,
    );
    const ext = extension[0];
    if (!ext) return unavailable('CREATE EXTENSION pg_stat_statements;');
    // Column names changed in pg_stat_statements 1.8 (PostgreSQL 13).
    const total = ext.exec_time_columns ? 'total_exec_time' : 'total_time';
    const mean = ext.exec_time_columns ? 'mean_exec_time' : 'mean_time';
    const view = `${quoteIdent(ext.schema)}.pg_stat_statements`;
    try {
      const rows = await metaQuery<{ query: string; calls: number; mean_ms: number; total_ms: number; rows: number }>(
        this.q,
        `select s.query, s.calls::float8 as calls, s.${mean}::float8 as mean_ms, s.${total}::float8 as total_ms,
                s.rows::float8 as rows
           from ${view} s
          where s.dbid = (select oid from pg_database where datname = current_database())
          order by s.${total} desc
          limit ${STATEMENTS_LIMIT}`,
      );
      const statements: SlowStatement[] = rows.map((r) => ({
        query: r.query ?? '',
        calls: r.calls,
        meanMs: r.mean_ms,
        totalMs: r.total_ms,
        rows: r.rows,
      }));
      return { kind: 'statements', available: true, installHint: null, statements };
    } catch (err) {
      if (!isPgError(err)) throw err;
      // 55000: installed but not loaded through shared_preload_libraries.
      return unavailable(
        err.code === '55000'
          ? "ALTER SYSTEM SET shared_preload_libraries = 'pg_stat_statements'; -- then restart the server"
          : 'CREATE EXTENSION pg_stat_statements;',
      );
    }
  }
}
