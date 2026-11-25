import pg from 'pg';
import type {
  ApplyEditsResult,
  BackendActionResult,
  CountRequest,
  CountResult,
  DdlPreview,
  DdlResult,
  ExplainResult,
  QueryPage,
  QueryStarted,
  RowEdit,
  RowsPage,
  RowsRequest,
  SchemaModel,
  StatsKind,
  StatsResultOf,
} from '@kleos/shared';
import type { SshTunnel } from '../../ssh/tunnel';
import type { DdlJob, QueryOptions, Session, SessionNotice } from '../types';
import { applyDdl, previewDdl } from './ddl';
import { applyEdits } from './edits';
import { introspect } from './introspect';
import { postgresJobs } from './jobs';
import { QueryManager } from './query';
import { estimateCount, exactCount, fetchRows } from './rows';
import { StatsCollector } from './stats';
import { type Queryable, TypeCache, metaQuery } from './types';

/** While a closing session waits for its pool, how often its busy clients are signalled again, and how many times. */
const CLOSE_CANCEL_EVERY_MS = 200;
const CLOSE_CANCEL_ATTEMPTS = 10;

export type SessionInit = {
  pool: pg.Pool;
  /** Settings that worked for the pool (SSL fallback resolved), reused for the per-tab clients. */
  clientConfig: pg.ClientConfig;
  readOnly: boolean;
  serverVersion: string;
  serverVersionShort: string;
  serverVersionNum: number;
  /** Backend pids of the pool's clients, kept current by the pool's connect/remove events. */
  ownPids: Set<number>;
  notices?: SessionNotice[];
  /** The SSH tunnel every client goes through, closed with the session. */
  tunnel?: SshTunnel | null;
};

/**
 * One open connection: a pool of up to 4 clients for grid, schema and monitoring, plus one
 * dedicated client per query tab.
 */
export class PostgresSession implements Session {
  readonly serverVersion: string;
  readonly serverVersionShort: string;
  readonly readOnly: boolean;
  readonly notices: SessionNotice[];

  private readonly pool: pg.Pool;
  private readonly ownPids: Set<number>;
  private readonly tunnel: SshTunnel | null;
  private readonly queries: QueryManager;
  private readonly monitor: StatsCollector;
  private closing: Promise<void> | null = null;

  /** Export and import (0.4): each job on its own client, outside the pool; see jobs.ts. */
  // Through the guard, so a job cut by a dropped SSH tunnel fails with the tunnel's error.
  readonly exportFile: Session['exportFile'] = (req, job) =>
    this.guard(() => postgresJobs(this.pool).exportFile(req, job));
  readonly importFile: Session['importFile'] = (req, job) =>
    this.guard(() => postgresJobs(this.pool).importFile(req, job));

  constructor(init: SessionInit) {
    this.pool = init.pool;
    this.ownPids = init.ownPids;
    this.readOnly = init.readOnly;
    this.serverVersion = init.serverVersion;
    this.serverVersionShort = init.serverVersionShort;
    this.notices = init.notices ?? [];
    this.tunnel = init.tunnel ?? null;
    this.queries = new QueryManager(
      init.pool,
      init.clientConfig,
      new TypeCache(init.pool),
      init.ownPids,
      init.readOnly,
    );
    this.monitor = new StatsCollector(init.pool, init.ownPids, init.serverVersionNum);
  }

  introspect(): Promise<SchemaModel> {
    return this.guard(() => introspect(this.pool));
  }

  fetchRows(req: RowsRequest): Promise<RowsPage> {
    return this.guard(() => this.withRawWhere(req.where, (q) => fetchRows(q, req)));
  }

  estimateCount(req: CountRequest): Promise<CountResult> {
    return this.guard(() => this.withRawWhere(req.where, (q) => estimateCount(q, req)));
  }

  count(req: CountRequest): Promise<CountResult> {
    return this.guard(() => this.withRawWhere(req.where, (q) => exactCount(q, req)));
  }

  /**
   * The raw WHERE box is the user's own SQL on a pooled client. The extended protocol already
   * refuses a second statement; on a read-only session it also runs inside BEGIN READ ONLY ...
   * ROLLBACK, so a function it calls cannot write, and a setting it changes (set_config of
   * default_transaction_read_only) is undone before the client goes back to the pool.
   */
  private withRawWhere<T>(where: string | undefined, run: (q: Queryable) => Promise<T>): Promise<T> {
    if (!this.readOnly || !where?.trim()) return run(this.pool);
    return inReadOnlyTransaction(this.pool, run);
  }

  applyEdits(edits: RowEdit[]): Promise<ApplyEditsResult> {
    return this.guard(() => applyEdits(this.pool, edits, this.readOnly));
  }

  previewDdl(changes: DdlJob[]): Promise<DdlPreview> {
    return this.guard(() => previewDdl(this.pool, changes));
  }

  applyDdl(changes: DdlJob[]): Promise<DdlResult> {
    return this.guard(() => applyDdl(this.pool, changes, this.readOnly));
  }

  runQuery(sql: string, opts: QueryOptions): Promise<QueryStarted> {
    return this.guard(() => this.queries.runQuery(sql, opts));
  }

  nextPage(qid: string, size: number): Promise<QueryPage> {
    return this.guard(() => this.queries.nextPage(qid, size));
  }

  cancelQuery(qid: string): Promise<void> {
    return this.guard(() => this.queries.cancelQuery(qid));
  }

  closeQuery(qid: string): Promise<void> {
    return this.queries.closeQuery(qid);
  }

  explain(sql: string, opts: Omit<QueryOptions, 'pageSize'>): Promise<ExplainResult> {
    return this.guard(() => this.queries.explain(sql, opts));
  }

  closeTab(tabId: string): Promise<void> {
    return this.queries.closeTab(tabId);
  }

  async stats<K extends StatsKind>(kind: K): Promise<StatsResultOf<K>> {
    return (await this.guard(() => this.monitor.collect(kind))) as StatsResultOf<K>;
  }

  backendAction(pid: number, mode: 'cancel' | 'terminate'): Promise<BackendActionResult> {
    return this.guard(() => this.monitor.backendAction(pid, mode));
  }

  /**
   * Through an SSH tunnel, a failure caused by the tunnel (gone, or the SSH host unable to reach
   * the database) is reported as such, a KLEOS_CONNECTION naming the tunnel, instead of the
   * driver's "Connection terminated unexpectedly" or a 500.
   */
  private async guard<T>(run: () => Promise<T>): Promise<T> {
    try {
      return await run();
    } catch (err) {
      throw this.tunnel ? await this.tunnel.explain(err) : err;
    }
  }

  /** Ends cursors, tab clients, the pool and the SSH tunnel. Idempotent; never throws. */
  close(): Promise<void> {
    this.closing ??= (async () => {
      await this.queries.closeAll().catch(() => undefined);
      // pool.end() waits for every checked-out client to come back. A grid request still running
      // on one (a slow raw WHERE, an exact count of a big table) used to hold the close, and the
      // DELETE /sessions/:sid answering it, until the statement finished on its own (0.7.2).
      // end() first, so no new checkout can start, then cancel what the busy clients run.
      const ended = this.pool.end().catch(() => undefined);
      await this.cancelPooledStatements(ended);
      await ended;
      await this.tunnel?.close();
    })();
    return this.closing;
  }

  /**
   * Sends pg_cancel_backend to the pool's backends until the pool has ended, from a client of
   * its own (the pool takes no new checkouts once ending, and every client may be busy). The
   * pids are all the session's remaining backends: once the tab clients are closed those are the
   * pool's, and a cancel reaching an idle one does nothing. Repeated for a client that was
   * between two statements (BEGIN READ ONLY, then the user's WHERE) when the first one landed.
   */
  private async cancelPooledStatements(ended: Promise<void>): Promise<void> {
    // end() drops the idle clients at once: nothing left means nothing was running.
    if (this.pool.totalCount === 0) return;
    let finished = false;
    void ended.then(() => {
      finished = true;
    });
    let client: pg.Client | null = null;
    try {
      for (let attempt = 0; attempt < CLOSE_CANCEL_ATTEMPTS && !finished; attempt += 1) {
        if (!client) {
          // The pool's settings already went through the SSL fallback (and point at any tunnel).
          client = new pg.Client(this.pool.options);
          client.on('error', () => undefined);
          await client.connect();
        }
        await metaQuery(client, 'select pg_cancel_backend(pid) from unnest($1::int[]) as pid', [[...this.ownPids]]);
        await Promise.race([ended, new Promise((resolve) => setTimeout(resolve, CLOSE_CANCEL_EVERY_MS))]);
      }
    } catch {
      // Server unreachable: the busy clients fail on their own, which ends the pool too.
    } finally {
      await client?.end().catch(() => undefined);
    }
  }
}

/** Runs `run` on one pooled client inside BEGIN READ ONLY ... ROLLBACK. */
async function inReadOnlyTransaction<T>(pool: pg.Pool, run: (q: Queryable) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  let broken: Error | undefined;
  try {
    await client.query('begin transaction read only');
    try {
      return await run(client);
    } finally {
      try {
        await client.query('rollback');
      } catch (err) {
        broken = err as Error;
      }
    }
  } finally {
    // A client whose ROLLBACK failed may still be in the transaction: destroy it.
    client.release(broken);
  }
}
