import type {
  ApplyEditsResult,
  BackendActionResult,
  ConnectionConfig,
  CountRequest,
  CountResult,
  ExplainResult,
  ExportRequest,
  ImportRequest,
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
import type { z } from 'zod';
import type { KnownHosts } from '../ssh/host-key';

/**
 * Every feature talks to the database through this interface, so the HTTP layer
 * and the frontend never see engine-specific code. A second engine is one new
 * implementation of DatabaseAdapter.
 */
export interface DatabaseAdapter {
  /** Opens a session: a pool of up to 4 clients for grid, schema and monitoring. */
  connect(config: ConnectionConfig, password: string | null, options?: ConnectOptions): Promise<Session>;
  /** Connects once, runs `select version()`, disconnects. Throws the driver's real error. */
  test(config: ConnectionConfig, password: string | null, options?: ConnectOptions): Promise<TestConnectionResult>;
}

/** What a session needs besides its config and password: the SSH tunnel's (0.4), the timeout (0.5). */
export type ConnectOptions = {
  /** SSH key passphrase, from the request or the Keychain. */
  sshPassphrase?: string | null;
  /** Host key fingerprint the user accepted after KLEOS_SSH_HOST_UNKNOWN. */
  trustSshFingerprint?: string;
  /** Trusted SSH host keys; required when the favorite has an SSH tunnel. */
  knownHosts?: KnownHosts;
  /**
   * Settings › Query timeout (0.5): the session's statement_timeout in seconds, sent at startup
   * to the pool and every per-tab client. 0 or absent: no timeout. test() ignores it.
   */
  statementTimeoutSeconds?: number;
};

/** Something the user should know about a session, shown when it opens. (0.4) */
export type SessionNotice = { code: string; message: string };

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
  /** e.g. READ_ONLY_DBLINK on a read-only session of a database with dblink. (0.4) */
  readonly notices?: SessionNotice[];

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

  /**
   * Streams a table (with the grid's filters and sort) or one statement to a file, on its own
   * client inside a READ ONLY transaction. Writes `${path}.kleos-partial` and renames it on
   * success; the partial file is deleted on failure or cancel. (0.4)
   */
  exportFile(req: ExportJob, job: JobContext): Promise<JobResult>;
  /**
   * Inserts a CSV file into an ordinary or partitioned table in one transaction on its own
   * client: all rows or none. Errors name the file line and the column at fault. (0.4)
   */
  importFile(req: ImportJob, job: JobContext): Promise<JobResult>;

  close(): Promise<void>;
}

/** Export and import requests after zod defaults. */
export type ExportJob = z.output<typeof ExportRequest>;
export type ImportJob = z.output<typeof ImportRequest>;

/** What a background job gets from the job registry. */
export type JobContext = {
  /** Aborted by POST /jobs/:jobId/cancel or when the session closes. */
  signal: AbortSignal;
  /** Rows written or inserted so far, and bytes written or read. */
  progress(update: JobResult): void;
};

export type JobResult = { rows: number; bytes: number };

export type { TableRef };
