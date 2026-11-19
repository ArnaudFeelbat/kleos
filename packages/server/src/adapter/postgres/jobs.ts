import pg from 'pg';
import type Cursor from 'pg-cursor';
import type { Session } from '../types';
import { toConnectError } from './connect';
import { exportFile } from './export';
import { importFile } from './import';
import { backendPid, metaQuery } from './types';

/** How often a cancel is signalled again while a statement keeps running, and how many times. */
const CANCEL_EVERY_MS = 200;
const CANCEL_ATTEMPTS = 10;

/** The error a job throws once its signal is aborted; the registry reports the job as cancelled. */
export function jobCancelledError(): Error {
  return Object.assign(new Error('The job was cancelled'), { name: 'JobCancelled' });
}

/**
 * The client a job runs on: its own connection, outside the session's pool, so a long export
 * or import never holds a grid or monitoring client. A cancel sends pg_cancel_backend (from the
 * pool) while a statement runs, repeats it for a statement that had not started yet, and as a
 * last resort closes the connection, which also ends any transaction.
 */
export class JobConnection {
  /** True while a statement or cursor read is executing on the backend. */
  private executing = false;

  private constructor(
    readonly client: pg.Client,
    private readonly pid: number,
    private readonly pool: pg.Pool,
    private readonly signal: AbortSignal,
  ) {}

  static async open(pool: pg.Pool, signal: AbortSignal): Promise<JobConnection> {
    if (signal.aborted) throw jobCancelledError();
    // The pool's settings already went through the SSL fallback (and point at any tunnel).
    const client = new pg.Client(pool.options);
    client.on('error', () => undefined);
    try {
      await client.connect();
    } catch (err) {
      throw toConnectError(err);
    }
    const connection = new JobConnection(client, backendPid(client), pool, signal);
    signal.addEventListener('abort', () => void connection.interrupt(), { once: true });
    return connection;
  }

  /** Throws when the job was cancelled; called between statements and batches. */
  checkCancelled(): void {
    if (this.signal.aborted) throw jobCancelledError();
  }

  async query(config: pg.QueryConfig | string, values?: unknown[]): Promise<pg.QueryResult> {
    this.checkCancelled();
    return this.running(() =>
      typeof config === 'string' ? this.client.query(config, values) : this.client.query(config),
    );
  }

  /** cursor.read as a promise, guarding pg-cursor's double callback after an error. */
  read<R>(cursor: Cursor<R>, rows: number): Promise<{ rows: R[]; fields: pg.FieldDef[] }> {
    this.checkCancelled();
    return this.running(
      () =>
        new Promise((resolve, reject) => {
          let settled = false;
          cursor.read(rows, (err, read, result) => {
            if (settled) return;
            settled = true;
            if (err) reject(err);
            else resolve({ rows: read, fields: result?.fields ?? [] });
          });
        }),
    );
  }

  /** Ends the connection; a transaction still open is rolled back by the server. Never throws. */
  async close(): Promise<void> {
    await this.client.end().catch(() => undefined);
  }

  private async running<T>(work: () => Promise<T>): Promise<T> {
    this.executing = true;
    try {
      return await work();
    } finally {
      this.executing = false;
    }
  }

  private async interrupt(): Promise<void> {
    for (let attempt = 0; attempt < CANCEL_ATTEMPTS; attempt += 1) {
      if (!this.executing) return;
      await metaQuery(this.pool, 'select pg_cancel_backend($1::int)', [this.pid]).catch(() => undefined);
      await new Promise((resolve) => setTimeout(resolve, CANCEL_EVERY_MS));
    }
    if (this.executing) {
      // The statement ignores cancels (or the pool is unreachable): drop the connection.
      (this.client as unknown as { connection?: { stream?: { destroy(): void } } }).connection?.stream?.destroy();
    }
  }
}

/** Runs `work` on a fresh job connection and always closes it. */
export async function withJobConnection<T>(
  pool: pg.Pool,
  signal: AbortSignal,
  work: (connection: JobConnection) => Promise<T>,
): Promise<T> {
  const connection = await JobConnection.open(pool, signal);
  try {
    return await work(connection);
  } finally {
    await connection.close();
  }
}

/** The Session's export and import methods for a session's pool. */
export function postgresJobs(pool: pg.Pool): Pick<Session, 'exportFile' | 'importFile'> {
  return {
    exportFile: (req, job) => withJobConnection(pool, job.signal, (connection) => exportFile(connection, req, job)),
    importFile: (req, job) => withJobConnection(pool, job.signal, (connection) => importFile(connection, req, job)),
  };
}
