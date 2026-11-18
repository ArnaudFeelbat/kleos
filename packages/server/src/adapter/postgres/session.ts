import type pg from 'pg';
import type {
  ApplyEditsResult,
  BackendActionResult,
  CountRequest,
  CountResult,
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
import type { QueryOptions, Session } from '../types';
import { applyEdits } from './edits';
import { introspect } from './introspect';
import { QueryManager } from './query';
import { estimateCount, exactCount, fetchRows } from './rows';
import { StatsCollector } from './stats';
import { TypeCache } from './types';

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
};

/**
 * One open connection: a pool of up to 4 clients for grid, schema and monitoring, plus one
 * dedicated client per query tab.
 */
export class PostgresSession implements Session {
  readonly serverVersion: string;
  readonly serverVersionShort: string;
  readonly readOnly: boolean;

  private readonly pool: pg.Pool;
  private readonly queries: QueryManager;
  private readonly monitor: StatsCollector;
  private closing: Promise<void> | null = null;

  constructor(init: SessionInit) {
    this.pool = init.pool;
    this.readOnly = init.readOnly;
    this.serverVersion = init.serverVersion;
    this.serverVersionShort = init.serverVersionShort;
    this.queries = new QueryManager(init.pool, init.clientConfig, new TypeCache(init.pool), init.ownPids);
    this.monitor = new StatsCollector(init.pool, init.ownPids, init.serverVersionNum);
  }

  introspect(): Promise<SchemaModel> {
    return introspect(this.pool);
  }

  fetchRows(req: RowsRequest): Promise<RowsPage> {
    return fetchRows(this.pool, req);
  }

  estimateCount(req: CountRequest): Promise<CountResult> {
    return estimateCount(this.pool, req);
  }

  count(req: CountRequest): Promise<CountResult> {
    return exactCount(this.pool, req);
  }

  applyEdits(edits: RowEdit[]): Promise<ApplyEditsResult> {
    return applyEdits(this.pool, edits, this.readOnly);
  }

  runQuery(sql: string, opts: QueryOptions): Promise<QueryStarted> {
    return this.queries.runQuery(sql, opts);
  }

  nextPage(qid: string, size: number): Promise<QueryPage> {
    return this.queries.nextPage(qid, size);
  }

  cancelQuery(qid: string): Promise<void> {
    return this.queries.cancelQuery(qid);
  }

  closeQuery(qid: string): Promise<void> {
    return this.queries.closeQuery(qid);
  }

  explain(sql: string, opts: Omit<QueryOptions, 'pageSize'>): Promise<ExplainResult> {
    return this.queries.explain(sql, opts);
  }

  closeTab(tabId: string): Promise<void> {
    return this.queries.closeTab(tabId);
  }

  async stats<K extends StatsKind>(kind: K): Promise<StatsResultOf<K>> {
    return (await this.monitor.collect(kind)) as StatsResultOf<K>;
  }

  backendAction(pid: number, mode: 'cancel' | 'terminate'): Promise<BackendActionResult> {
    return this.monitor.backendAction(pid, mode);
  }

  /** Ends cursors, tab clients and the pool. Idempotent; never throws. */
  close(): Promise<void> {
    this.closing ??= (async () => {
      await this.queries.closeAll().catch(() => undefined);
      await this.pool.end().catch(() => undefined);
    })();
    return this.closing;
  }
}
