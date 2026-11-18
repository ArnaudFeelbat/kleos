import type {
  ApplyEditsResult,
  BackendActionResult,
  ConnectionConfig,
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
  TableRef,
  TestConnectionResult,
} from '@kleos/shared';

/**
 * Every feature talks to the database through this interface, so the HTTP layer
 * and the frontend never see engine-specific code. A second engine is one new
 * implementation of DatabaseAdapter.
 */
export interface DatabaseAdapter {
  /** Opens a session: a pool of up to 4 clients for grid, schema and monitoring. */
  connect(config: ConnectionConfig, password: string | null): Promise<Session>;
  /** Connects once, runs `select version()`, disconnects. Throws the driver's real error. */
  test(config: ConnectionConfig, password: string | null): Promise<TestConnectionResult>;
}

export type QueryOptions = {
  /** Client-generated id, used for paging, cancel and close. */
  qid: string;
  /** Query tab; each tab gets one dedicated client so transactions and cancel behave predictably. */
  tabId: string;
  pageSize: number;
};

export interface Session {
  readonly serverVersion: string;
  /** "16.4" */
  readonly serverVersionShort: string;
  readonly readOnly: boolean;

  /** Reads pg_catalog. System schemas are left out. */
  introspect(): Promise<SchemaModel>;
  /** One page of rows; identifiers quoted, values parameterized, sort and filters on the server. */
  fetchRows(req: RowsRequest): Promise<RowsPage>;
  /** Planner estimate (pg_class.reltuples, or EXPLAIN when filtered). */
  estimateCount(req: CountRequest): Promise<CountResult>;
  /** Exact count(*) for a table and filter. */
  count(req: CountRequest): Promise<CountResult>;
  /**
   * Applies all edits in one transaction. Any statement that affects a number of rows
   * other than 1, or any error, rolls back the whole batch and throws with editIndex
   * (and column when the error belongs to one cell).
   */
  applyEdits(edits: RowEdit[]): Promise<ApplyEditsResult>;

  /** Runs one statement through a server-side cursor on the tab's dedicated client; returns the first page. */
  runQuery(sql: string, opts: QueryOptions): Promise<QueryStarted>;
  nextPage(qid: string, size: number): Promise<QueryPage>;
  /** pg_cancel_backend on the tab client's pid, from a second connection. Safe to call while runQuery is pending. */
  cancelQuery(qid: string): Promise<void>;
  /** Closes the cursor. */
  closeQuery(qid: string): Promise<void>;
  /** EXPLAIN (ANALYZE, FORMAT JSON) inside a transaction that is always rolled back. */
  explain(sql: string, opts: Omit<QueryOptions, 'pageSize'>): Promise<ExplainResult>;
  /** Releases the dedicated client of a closed query tab. */
  closeTab(tabId: string): Promise<void>;

  stats<K extends StatsKind>(kind: K): Promise<StatsResultOf<K>>;
  /** pg_cancel_backend or pg_terminate_backend. */
  backendAction(pid: number, mode: 'cancel' | 'terminate'): Promise<BackendActionResult>;

  close(): Promise<void>;
}

export type { TableRef };
