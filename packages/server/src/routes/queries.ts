import type { Hono } from 'hono';
import {
  ExplainRequest,
  QueryRequest,
  type ExplainResult,
  type HistoryEntry,
  type QueryPage,
  type QueryStarted,
} from '@kleos/shared';
import { KleosError, isPgError } from '../errors';
import type { ServerDeps } from '../http/deps';
import { PageQuery, jsonBody, queryOf, sqlStateOf } from './validation';

const QUERY_CANCELED = '57014';

/** "42703 column o.stauts does not exist" for Postgres errors, the plain message otherwise. */
export function historyErrorText(err: unknown): string {
  if (isPgError(err)) return `${err.code} ${err.message}`;
  if (err instanceof KleosError) {
    const state = sqlStateOf(err);
    return state ? `${state} ${err.body.message}` : err.body.message;
  }
  return err instanceof Error ? err.message : String(err);
}

/**
 * Runs `work` and records it in the connection's history, success or failure. The
 * original result or error always reaches the caller; a failing history write is
 * only logged.
 */
async function withHistory<T>(
  deps: ServerDeps,
  connectionId: string,
  sql: string,
  kind: HistoryEntry['kind'],
  work: () => Promise<T>,
  measure: (result: T, wallMs: number) => { elapsedMs: number; rowCount: number | null },
): Promise<T> {
  const started = Date.now();
  const ranAt = new Date(started).toISOString();
  const record = (entry: Omit<HistoryEntry, 'id' | 'connectionId' | 'sql' | 'kind' | 'ranAt'>) => {
    try {
      deps.store.addHistory(connectionId, { sql, kind, ranAt, ...entry });
    } catch (err) {
      console.error('[kleos] could not record history', err);
    }
  };
  let result: T;
  try {
    result = await work();
  } catch (err) {
    record({
      elapsedMs: Date.now() - started,
      rowCount: null,
      error: historyErrorText(err),
      cancelled: sqlStateOf(err) === QUERY_CANCELED,
    });
    throw err;
  }
  record({ ...measure(result, Date.now() - started), error: null, cancelled: false });
  return result;
}

export function registerQueryRoutes(api: Hono, deps: ServerDeps): void {
  const { sessions } = deps;

  api.post('/sessions/:sid/queries', async (c) => {
    const { session, connection } = sessions.get(c.req.param('sid'));
    const req = await jsonBody(c, QueryRequest);
    const started = await withHistory(
      deps,
      connection.id,
      req.sql,
      'query',
      () => session.runQuery(req.sql, { qid: req.qid, tabId: req.tabId, pageSize: req.pageSize }),
      (r) => ({ elapsedMs: r.elapsedMs, rowCount: r.rowCount }),
    );
    return c.json<QueryStarted>(started);
  });

  api.get('/sessions/:sid/queries/:qid/page', async (c) => {
    const { session } = sessions.get(c.req.param('sid'));
    const { size } = queryOf(c, PageQuery);
    return c.json<QueryPage>(await session.nextPage(c.req.param('qid'), size));
  });

  api.post('/sessions/:sid/queries/:qid/cancel', async (c) => {
    const { session } = sessions.get(c.req.param('sid'));
    await session.cancelQuery(c.req.param('qid'));
    return c.body(null, 204);
  });

  api.delete('/sessions/:sid/queries/:qid', async (c) => {
    const { session } = sessions.get(c.req.param('sid'));
    await session.closeQuery(c.req.param('qid'));
    return c.body(null, 204);
  });

  api.post('/sessions/:sid/explain', async (c) => {
    const { session, connection } = sessions.get(c.req.param('sid'));
    const req = await jsonBody(c, ExplainRequest);
    const result = await withHistory(
      deps,
      connection.id,
      req.sql,
      'explain',
      () => session.explain(req.sql, { qid: req.qid, tabId: req.tabId }),
      (_r, wallMs) => ({ elapsedMs: wallMs, rowCount: null }),
    );
    return c.json<ExplainResult>(result);
  });

  api.delete('/sessions/:sid/tabs/:tabId', async (c) => {
    const { session } = sessions.get(c.req.param('sid'));
    await session.closeTab(c.req.param('tabId'));
    return c.body(null, 204);
  });
}
