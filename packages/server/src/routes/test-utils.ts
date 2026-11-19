import type {
  ApplyEditsResult,
  BackendActionResult,
  ConnectionConfig,
  ConnectionInput,
  CountRequest,
  CountResult,
  ExplainResult,
  QueryPage,
  QueryStarted,
  RowEdit,
  RowsPage,
  RowsRequest,
  SavedConnection,
  SchemaModel,
  StatsKind,
  StatsResultOf,
  TestConnectionResult,
} from '@kleos/shared';
import type {
  DatabaseAdapter,
  ExportJob,
  ImportJob,
  JobContext,
  JobResult,
  QueryOptions,
  Session,
} from '../adapter/types';
import { createApp } from '../http/app';
import { SessionRegistry } from '../sessions/registry';
import { createMemorySecretStore } from '../store/keychain';
import { createSqliteStore } from '../store/sqlite';

export const PORT = 41234;
export const TOKEN = 'b'.repeat(64);

/** An Error shaped like node-postgres's DatabaseError. */
export function pgError(code: string, message: string, extra: Record<string, unknown> = {}): Error {
  return Object.assign(new Error(message), { code, severity: 'ERROR', ...extra });
}

export type Call = [method: string, ...args: unknown[]];

/** Records every call, returns canned data, and throws whatever is set in `errors[method]`. */
export class FakeSession implements Session {
  readonly serverVersion = 'PostgreSQL 16.4 on aarch64-apple-darwin';
  readonly serverVersionShort = '16.4';
  readonly calls: Call[] = [];
  readonly errors = new Map<keyof Session, unknown>();
  closed = false;
  private introspections = 0;

  constructor(readonly readOnly = false) {}

  callsTo(method: keyof Session): unknown[][] {
    return this.calls.filter((c) => c[0] === method).map(([, ...args]) => args);
  }

  private hit(method: keyof Session, ...args: unknown[]): void {
    this.calls.push([method, ...args]);
    const err = this.errors.get(method);
    if (err) throw err;
  }

  async introspect(): Promise<SchemaModel> {
    this.hit('introspect');
    this.introspections += 1;
    return {
      schemas: ['public'],
      tables: [],
      views: [],
      foreignKeys: [],
      enums: [],
      introspectedAt: `run-${this.introspections}`,
    };
  }
  async fetchRows(req: RowsRequest): Promise<RowsPage> {
    this.hit('fetchRows', req);
    return {
      columns: [{ name: 'id', type: 'integer', typeName: 'int4', typeOid: 23, typeCategory: 'N' }],
      rows: [['1'], ['2']],
      hasMore: false,
      elapsedMs: 3,
    };
  }
  async estimateCount(req: CountRequest): Promise<CountResult> {
    this.hit('estimateCount', req);
    return { count: '1000', exact: false };
  }
  async count(req: CountRequest): Promise<CountResult> {
    this.hit('count', req);
    return { count: '1234', exact: true };
  }
  async applyEdits(edits: RowEdit[]): Promise<ApplyEditsResult> {
    this.hit('applyEdits', edits);
    return { applied: edits.length, rows: edits.map(() => null), columns: [] };
  }
  async runQuery(sql: string, opts: QueryOptions): Promise<QueryStarted> {
    this.hit('runQuery', sql, opts);
    return { qid: opts.qid, columns: [], rows: [['x']], hasMore: true, command: null, rowCount: 1, elapsedMs: 12 };
  }
  async nextPage(qid: string, size: number): Promise<QueryPage> {
    this.hit('nextPage', qid, size);
    return { rows: [['y']], hasMore: false, elapsedMs: 2 };
  }
  async cancelQuery(qid: string): Promise<void> {
    this.hit('cancelQuery', qid);
  }
  async closeQuery(qid: string): Promise<void> {
    this.hit('closeQuery', qid);
  }
  async explain(sql: string, opts: Omit<QueryOptions, 'pageSize'>): Promise<ExplainResult> {
    this.hit('explain', sql, opts);
    return { plan: { 'Node Type': 'Seq Scan', 'Relation Name': 'orders' }, planningMs: 0.1, executionMs: 1.5 };
  }
  async closeTab(tabId: string): Promise<void> {
    this.hit('closeTab', tabId);
  }
  async stats<K extends StatsKind>(kind: K): Promise<StatsResultOf<K>> {
    this.hit('stats', kind);
    return { kind: 'tables', tables: [] } as unknown as StatsResultOf<K>;
  }
  async backendAction(pid: number, mode: 'cancel' | 'terminate'): Promise<BackendActionResult> {
    this.hit('backendAction', pid, mode);
    return { ok: true };
  }
  /** What exportFile and importFile do once called; a test can make it wait for the cancel. */
  jobWork: (job: JobContext) => Promise<JobResult> = async () => ({ rows: 3, bytes: 42 });
  async exportFile(req: ExportJob, job: JobContext): Promise<JobResult> {
    this.hit('exportFile', req);
    return this.jobWork(job);
  }
  async importFile(req: ImportJob, job: JobContext): Promise<JobResult> {
    this.hit('importFile', req);
    return this.jobWork(job);
  }
  async close(): Promise<void> {
    this.hit('close');
    this.closed = true;
  }
}

type ConnectOptions = NonNullable<Parameters<DatabaseAdapter['connect']>[2]>;

export class FakeAdapter implements DatabaseAdapter {
  readonly connectCalls: Array<{ config: ConnectionConfig; password: string | null }> = [];
  readonly testCalls: Array<{ config: ConnectionConfig; password: string | null }> = [];
  /** The SSH options of each call, index for index with connectCalls and testCalls. (0.4) */
  readonly connectOptions: ConnectOptions[] = [];
  readonly testOptions: ConnectOptions[] = [];
  readonly sessions: FakeSession[] = [];
  connectError: unknown = null;
  testError: unknown = null;

  async connect(config: ConnectionConfig, password: string | null, options: ConnectOptions = {}): Promise<Session> {
    this.connectCalls.push({ config, password });
    this.connectOptions.push(options);
    if (this.connectError) throw this.connectError;
    const session = new FakeSession(config.readOnly);
    this.sessions.push(session);
    return session;
  }
  async test(
    config: ConnectionConfig,
    password: string | null,
    options: ConnectOptions = {},
  ): Promise<TestConnectionResult> {
    this.testCalls.push({ config, password });
    this.testOptions.push(options);
    if (this.testError) throw this.testError;
    return { version: 'PostgreSQL 16.4', elapsedMs: 4 };
  }
}

export const connectionInput = (overrides: Partial<ConnectionInput> = {}): ConnectionInput => ({
  nickname: 'Local',
  host: 'localhost',
  port: 5432,
  user: 'postgres',
  database: 'shop',
  sslMode: 'prefer',
  color: 'none',
  readOnly: false,
  password: null,
  savePassword: false,
  ...overrides,
});

export type TestResponse = { status: number; body: unknown };

export function setup() {
  const store = createSqliteStore(':memory:');
  const secrets = createMemorySecretStore();
  const adapter = new FakeAdapter();
  const sessions = new SessionRegistry();
  const app = createApp(
    { adapter, store, secrets, sessions, version: '0.0.0-test' },
    { token: TOKEN, getPort: () => PORT },
  );

  /** Sends a request with valid auth; `body` is JSON-encoded unless it is already a string. */
  async function call(method: string, path: string, body?: unknown): Promise<TestResponse> {
    const res = await app.request(`/api${path}`, {
      method,
      headers: {
        host: `127.0.0.1:${PORT}`,
        authorization: `Bearer ${TOKEN}`,
        'content-type': 'application/json',
      },
      body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body),
    });
    const text = await res.text();
    return { status: res.status, body: text ? (JSON.parse(text) as unknown) : null };
  }

  async function createConnection(overrides: Partial<ConnectionInput> = {}): Promise<SavedConnection> {
    const res = await call('POST', '/connections', connectionInput(overrides));
    if (res.status !== 200) throw new Error(`create failed: ${JSON.stringify(res.body)}`);
    return res.body as SavedConnection;
  }

  /** Creates a favorite with a saved password and opens a session on it. */
  async function openSession(overrides: Partial<ConnectionInput> = {}) {
    const connection = await createConnection({ password: 'pw', savePassword: true, ...overrides });
    const res = await call('POST', '/sessions', { connectionId: connection.id });
    if (res.status !== 200) throw new Error(`open failed: ${JSON.stringify(res.body)}`);
    const sid = (res.body as { sid: string }).sid;
    const session = adapter.sessions.at(-1)!;
    return { connection, sid, session };
  }

  return { store, secrets, adapter, sessions, app, call, createConnection, openSession };
}
