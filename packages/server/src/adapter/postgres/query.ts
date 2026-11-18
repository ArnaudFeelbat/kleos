import pg from 'pg';
import Cursor from 'pg-cursor';
import {
  type CellValue,
  type ExplainResult,
  type PlanNode,
  type QueryPage,
  type QueryStarted,
  kleosErrorCodes,
} from '@kleos/shared';
import { KleosError } from '../../errors';
import type { QueryOptions } from '../types';
import { toConnectError } from './connect';
import { type TypeCache, backendPid, dataQuery, metaQuery, processId, queryCanceledError, textTypes } from './types';

/** What every cancellable run has: the backend executing it, and whether it is executing right now. */
type Running = {
  qid: string;
  tabId: string;
  /** Backend pid running the statement; null until the client is ready. */
  pid: number | null;
  /** Set by cancelQuery; checked before the statement is sent, for a cancel that arrives first. */
  cancelRequested: boolean;
  /** True while a statement (or a cursor read) is executing on the backend. */
  executing: boolean;
};

type CursorRun = Running & {
  kind: 'cursor';
  cursor: Cursor<CellValue[]> | null;
  /** Rows read ahead of the page returned, so hasMore is exact. */
  buffer: CellValue[][];
  /** The portal is exhausted (or failed); the tab client is free again. */
  finished: boolean;
  /** Full command tag ("CREATE TABLE", "INSERT 0 3"), captured from CommandComplete. */
  commandTag: string | null;
  /** Serializes reads of one cursor. */
  chain: Promise<unknown>;
  /** Read-only sessions: the tab client whose READ ONLY transaction wraps this run; null until opened. */
  guard: TabClient | null;
  /** Set once the run has let go of its tab client (wrapping transaction ended); see release(). */
  released: Promise<void> | null;
};

type ExplainRun = Running & { kind: 'explain' };

type TabClient = { client: pg.Client; pid: number };

type CursorResult = { fields: pg.FieldDef[]; rowCount: number | null };

/** How long to wait between repeated cancel signals, for a signal that lands before execution starts. */
const CANCEL_RETRY_MS = 150;
const CANCEL_ATTEMPTS = 5;

/**
 * Query tabs: one dedicated client per tab (opened on first use), one server-side cursor per
 * running query, cancel from a pooled connection with pg_cancel_backend.
 *
 * On a read-only session every statement runs inside a transaction Kleos opens as
 * BEGIN READ ONLY and pins with a first query, and ends with ROLLBACK once the statement is
 * finished, failed, cancelled or closed. Postgres then refuses every write whatever the user
 * types: SET TRANSACTION READ WRITE (and BEGIN READ WRITE, which tries the same) fails with
 * "must be called before any query"; SET default_transaction_read_only, SET SESSION
 * CHARACTERISTICS and set_config are undone by the ROLLBACK; a COMMIT or ROLLBACK typed by the
 * user only ends the wrapper early (the next statement is wrapped again); procedures and DO
 * blocks cannot commit inside it. Read-write sessions run statements bare, so user
 * transactions span runs as before.
 */
export class QueryManager {
  private readonly tabs = new Map<string, Promise<TabClient>>();
  private readonly runs = new Map<string, CursorRun | ExplainRun>();

  constructor(
    private readonly pool: pg.Pool,
    private readonly clientConfig: pg.ClientConfig,
    private readonly typeCache: TypeCache,
    /** Backend pids opened by this session, for the Sessions panel's isSelf. */
    private readonly ownPids: Set<number>,
    private readonly readOnly: boolean,
  ) {}

  async runQuery(sql: string, { qid, tabId, pageSize }: QueryOptions): Promise<QueryStarted> {
    const started = performance.now();
    const previous = this.runs.get(qid);
    const run: CursorRun = {
      kind: 'cursor',
      qid,
      tabId,
      pid: null,
      cancelRequested: false,
      executing: false,
      cursor: null,
      buffer: [],
      finished: false,
      commandTag: null,
      chain: Promise.resolve(),
      guard: null,
      released: null,
    };
    // Registered before anything is awaited, so a cancel can find it at any point.
    this.runs.set(qid, run);
    try {
      // An open cursor holds the tab's client: close whatever still runs on this tab
      // (and a previous run under the same qid). closeRun waits until each has ended its
      // wrapping transaction, so this run's BEGIN cannot be overtaken by their ROLLBACK.
      const others = [...this.runs.values()].filter(
        (other) => other.tabId === tabId && other.kind === 'cursor' && other !== run,
      );
      if (previous && previous !== run && !others.includes(previous)) others.push(previous);
      await Promise.all(others.map((other) => this.closeRun(other)));
      const tab = await this.tabClient(tabId);
      run.pid = tab.pid;
      if (run.cancelRequested) throw queryCanceledError();
      if (this.readOnly) {
        await this.beginReadOnly(run, tab);
        if (run.cancelRequested) throw queryCanceledError();
      }

      const cursor = new Cursor<CellValue[]>(sql, undefined, { rowMode: 'array', types: textTypes });
      captureCommandTag(cursor, run);
      run.cursor = tab.client.query(cursor);
      const page = await this.page(run, pageSize);
      const columns = page.result ? await this.typeCache.columnsFor(page.result.fields) : [];
      const isCommand = columns.length === 0;
      const tag = run.finished ? run.commandTag : null;
      return {
        qid,
        columns,
        rows: page.rows,
        hasMore: page.hasMore,
        command: isCommand ? (run.commandTag ?? null) : tag && !tag.startsWith('SELECT') ? tag : null,
        rowCount: isCommand ? (page.result?.rowCount ?? null) : page.rows.length,
        elapsedMs: Math.round(performance.now() - started),
      };
    } catch (err) {
      // Closes a cursor left open (e.g. column lookup failed) and ends the wrapping transaction.
      await this.closeRun(run).catch(() => undefined);
      throw err;
    }
  }

  async nextPage(qid: string, size: number): Promise<QueryPage> {
    const run = this.runs.get(qid);
    if (!run || run.kind !== 'cursor') {
      throw new KleosError(404, { code: kleosErrorCodes.queryNotFound, message: 'Query not found or closed' });
    }
    const started = performance.now();
    try {
      const page = await this.page(run, size);
      return { rows: page.rows, hasMore: page.hasMore, elapsedMs: Math.round(performance.now() - started) };
    } catch (err) {
      this.forget(run);
      throw err;
    }
  }

  /**
   * Sends pg_cancel_backend for the backend running this query, from a pooled connection.
   * Unknown or finished queries are a no-op. While the statement keeps executing the signal is
   * repeated a few times in the background, in case the first one landed just before execution.
   */
  async cancelQuery(qid: string): Promise<void> {
    const run = this.runs.get(qid);
    if (!run) return;
    run.cancelRequested = true;
    if (run.pid === null || !run.executing) return;
    const pid = run.pid;
    await this.signal(pid);
    void (async () => {
      for (let attempt = 1; attempt < CANCEL_ATTEMPTS; attempt += 1) {
        await delay(CANCEL_RETRY_MS);
        if (this.runs.get(qid) !== run || !run.executing || run.pid !== pid) return;
        await this.signal(pid).catch(() => undefined);
      }
    })();
  }

  /** Closes the cursor (cancelling it first if it is still executing). Unknown ids are a no-op. */
  async closeQuery(qid: string): Promise<void> {
    const run = this.runs.get(qid);
    if (run) await this.closeRun(run);
  }

  private async closeRun(run: CursorRun | ExplainRun): Promise<void> {
    this.forget(run);
    // A run still opening its client stops before sending its statement.
    run.cancelRequested = true;
    if (run.kind === 'explain') {
      // Its pooled client is released when the statement ends; cancel so that happens now.
      if (run.executing && run.pid !== null) await this.signal(run.pid).catch(() => undefined);
      return;
    }
    await this.closeCursor(run);
    await this.release(run);
  }

  private async closeCursor(run: CursorRun): Promise<void> {
    if (!run.cursor || run.finished) return;
    const cursor = run.cursor;
    if (run.executing && run.pid !== null) {
      await this.signal(run.pid).catch(() => undefined);
    }
    // Let an in-flight read settle (it fails with 57014 after the cancel) before closing the portal.
    await run.chain.catch(() => undefined);
    if (run.finished) return;
    run.finished = true;
    try {
      await cursor.close();
    } catch {
      // The client is gone; nothing left to close.
    }
  }

  /**
   * Read-only sessions: opens the READ ONLY transaction that wraps one run. The `select 1` takes
   * the transaction's first snapshot, after which Postgres refuses to switch it to read-write.
   */
  private async beginReadOnly(run: CursorRun, tab: TabClient): Promise<void> {
    if (run.released) throw queryCanceledError();
    run.guard = tab;
    await tab.client.query('begin transaction read only; select 1');
  }

  /**
   * Ends the run's wrapping transaction, if it opened one. Idempotent: every caller gets the
   * same promise, settled once the tab client is free for the next run. A ROLLBACK that fails
   * leaves the client in an unknown state, so the client is dropped and the next run opens a
   * fresh one.
   */
  private release(run: CursorRun): Promise<void> {
    run.released ??= (async () => {
      const tab = run.guard;
      if (!tab) return;
      try {
        await tab.client.query('rollback');
      } catch {
        const current = this.tabs.get(run.tabId);
        if (current && (await current.catch(() => null)) === tab && this.tabs.get(run.tabId) === current) {
          this.tabs.delete(run.tabId);
        }
        await endClient(tab, this.ownPids);
      }
    })();
    return run.released;
  }

  /**
   * EXPLAIN (ANALYZE, FORMAT JSON) on a pooled client inside BEGIN ... ROLLBACK, so even a write
   * never sticks (BEGIN READ ONLY on a read-only session, so a write fails). Cancellable by qid
   * like a query.
   */
  async explain(sql: string, { qid, tabId }: { qid: string; tabId: string }): Promise<ExplainResult> {
    const previous = this.runs.get(qid);
    const run: ExplainRun = { kind: 'explain', qid, tabId, pid: null, cancelRequested: false, executing: false };
    // Registered before anything is awaited, so a cancel can find it at any point.
    this.runs.set(qid, run);
    let client: pg.PoolClient | undefined;
    let broken: Error | undefined;
    try {
      if (previous) await this.closeRun(previous);
      client = await this.pool.connect();
      run.pid = backendPid(client);
      if (run.cancelRequested) throw queryCanceledError();
      await client.query(this.readOnly ? 'begin transaction read only' : 'begin');
      try {
        run.executing = true;
        const result = await dataQuery(client, `explain (analyze, format json) ${sql}`);
        const output = JSON.parse(result.rows[0]?.[0] ?? '[]') as Array<{
          Plan: PlanNode;
          'Planning Time'?: number;
          'Execution Time'?: number;
        }>;
        const root = output[0];
        if (!root) throw new Error('EXPLAIN returned no plan');
        return { plan: root.Plan, planningMs: root['Planning Time'] ?? 0, executionMs: root['Execution Time'] ?? 0 };
      } finally {
        run.executing = false;
        try {
          await client.query('rollback');
        } catch (err) {
          broken = err as Error;
        }
      }
    } finally {
      this.forget(run);
      client?.release(broken);
    }
  }

  /** Closes the tab's cursors and its dedicated client. */
  async closeTab(tabId: string): Promise<void> {
    await Promise.all([...this.runs.values()].filter((run) => run.tabId === tabId).map((run) => this.closeRun(run)));
    const pending = this.tabs.get(tabId);
    if (!pending) return;
    this.tabs.delete(tabId);
    const tab = await pending.catch(() => null);
    if (tab) await endClient(tab, this.ownPids);
  }

  /** Ends every cursor and tab client; never throws. */
  async closeAll(): Promise<void> {
    const tabIds = new Set([...this.tabs.keys(), ...[...this.runs.values()].map((r) => r.tabId)]);
    await Promise.allSettled([...tabIds].map((tabId) => this.closeTab(tabId)));
    this.runs.clear();
  }

  private forget(run: Running): void {
    if (this.runs.get(run.qid) === run) this.runs.delete(run.qid);
  }

  private async signal(pid: number): Promise<void> {
    await metaQuery(this.pool, 'select pg_cancel_backend($1::int)', [pid]);
  }

  /** The tab's dedicated client, opened on first use; a client that dies is replaced on the next run. */
  private tabClient(tabId: string): Promise<TabClient> {
    const existing = this.tabs.get(tabId);
    if (existing) return existing;
    const opening = this.openTabClient(tabId);
    this.tabs.set(tabId, opening);
    opening.catch(() => {
      if (this.tabs.get(tabId) === opening) this.tabs.delete(tabId);
    });
    return opening;
  }

  private async openTabClient(tabId: string): Promise<TabClient> {
    const client = new pg.Client(this.clientConfig);
    const drop = () => {
      const pid = processId(client);
      if (pid !== null) this.ownPids.delete(pid);
      // Cursors of a dead client can never be closed; mark them so closeQuery does not wait on them.
      for (const run of this.runs.values()) {
        if (run.kind === 'cursor' && run.tabId === tabId) run.finished = true;
      }
      void this.tabs.get(tabId)?.then(
        (current) => {
          if (current.client === client) this.tabs.delete(tabId);
        },
        () => undefined,
      );
    };
    client.on('error', drop);
    client.on('end', drop);
    try {
      await client.connect();
    } catch (err) {
      throw toConnectError(err);
    }
    const tab = { client, pid: backendPid(client) };
    this.ownPids.add(tab.pid);
    return tab;
  }

  /** Returns `size` rows, reading one row ahead so hasMore is exact. Reads of one cursor are serialized. */
  private page(
    run: CursorRun,
    size: number,
  ): Promise<{ rows: CellValue[][]; hasMore: boolean; result?: CursorResult }> {
    const next = run.chain.then(async () => {
      let result: CursorResult | undefined;
      const need = size + 1 - run.buffer.length;
      if (need > 0 && !run.finished && run.cursor) {
        run.executing = true;
        try {
          const read = await readCursor(run.cursor, need);
          result = read.result;
          for (const row of read.rows) run.buffer.push(row);
          if (read.rows.length < need) run.finished = true;
        } catch (err) {
          // Cleared before the ROLLBACK, so a repeated cancel signal is not aimed at it.
          run.executing = false;
          run.finished = true;
          await this.release(run);
          throw err;
        } finally {
          run.executing = false;
        }
      }
      // The portal is done: end the wrapping transaction before the rows are handed back.
      if (run.finished) await this.release(run);
      const rows = run.buffer.splice(0, size);
      return { rows, hasMore: run.buffer.length > 0, result };
    });
    run.chain = next.catch(() => undefined);
    return next;
  }
}

/** cursor.read with the result metadata (fields, rowCount), guarding pg-cursor's double callback after an error. */
function readCursor(
  cursor: Cursor<CellValue[]>,
  rows: number,
): Promise<{ rows: CellValue[][]; result?: CursorResult }> {
  return new Promise((resolve, reject) => {
    let settled = false;
    cursor.read(rows, (err, read, result) => {
      if (settled) return;
      settled = true;
      if (err) reject(err);
      else resolve({ rows: read, result: result ? { fields: result.fields, rowCount: result.rowCount } : undefined });
    });
  });
}

type CursorInternals = { handleCommandComplete(msg: { text?: string; command?: string }): void };

/**
 * pg's Result keeps only the first word of the command tag ("CREATE" for "CREATE TABLE"),
 * so the full tag is taken from the CommandComplete message as it passes.
 */
function captureCommandTag(cursor: Cursor<CellValue[]>, run: CursorRun): void {
  const internals = cursor as unknown as CursorInternals;
  const original = internals.handleCommandComplete.bind(cursor);
  internals.handleCommandComplete = (msg) => {
    run.commandTag = msg.text ?? msg.command ?? null;
    original(msg);
  };
}

async function endClient(tab: TabClient, ownPids: Set<number>): Promise<void> {
  ownPids.delete(tab.pid);
  try {
    await tab.client.end();
  } catch {
    // Already closed.
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
