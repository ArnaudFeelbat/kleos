import { z } from 'zod';
import {
  ApiErrorBody,
  ApplyEditsResult,
  CountResult,
  ExplainResult,
  Health,
  HistoryEntry,
  LayoutPositions,
  QueryPage,
  QueryStarted,
  RowsPage,
  SavedConnection,
  SavedQuery,
  SchemaModel,
  SessionInfo,
  StatsResult,
  TestConnectionResult,
  BackendActionResult,
  type ConnectionInput,
  type CountRequest,
  type ExplainRequest,
  type NewHistoryEntry,
  type OpenSessionRequest,
  type QueryRequest,
  type RowEdit,
  type RowsRequest,
  type SavedQueryInput,
  type StatsKind,
  type StatsResultOf,
  type TestConnectionRequest,
} from '@kleos/shared';
import { getBridge } from './bridge';

/** Thrown for every non-2xx answer; `body` is the server's { code, message, detail?, position? }. */
export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly body: ApiErrorBody,
  ) {
    super(body.message);
    this.name = 'ApiError';
  }
}

type Method = 'GET' | 'POST' | 'PUT' | 'DELETE';

async function request<T>(method: Method, path: string, schema: z.ZodType<T> | null, body?: unknown): Promise<T> {
  const { apiBase, token } = getBridge();
  const res = await fetch(`${apiBase}/api${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) {
    const json: unknown = await res.json().catch(() => null);
    const parsed = ApiErrorBody.safeParse(json);
    throw new ApiError(
      res.status,
      parsed.success ? parsed.data : { code: 'KLEOS_HTTP', message: `${res.status} ${res.statusText}` },
    );
  }
  if (schema === null || res.status === 204) return undefined as T;
  return schema.parse(await res.json());
}

const enc = encodeURIComponent;
const NoContent = null;

/** Typed client for every route in @kleos/shared/routes.ts. */
export const api = {
  health: () => request('GET', '/health', Health),

  listConnections: () => request('GET', '/connections', z.array(SavedConnection)),
  createConnection: (input: ConnectionInput) => request('POST', '/connections', SavedConnection, input),
  updateConnection: (id: string, input: ConnectionInput) =>
    request('PUT', `/connections/${enc(id)}`, SavedConnection, input),
  deleteConnection: (id: string) => request<void>('DELETE', `/connections/${enc(id)}`, NoContent),
  testConnection: (req: TestConnectionRequest) => request('POST', '/connections/test', TestConnectionResult, req),

  openSession: (req: OpenSessionRequest) => request('POST', '/sessions', SessionInfo, req),
  getSession: (sid: string) => request('GET', `/sessions/${enc(sid)}`, SessionInfo),
  closeSession: (sid: string) => request<void>('DELETE', `/sessions/${enc(sid)}`, NoContent),

  schema: (sid: string, refresh = false) =>
    request('GET', `/sessions/${enc(sid)}/schema${refresh ? '?refresh=1' : ''}`, SchemaModel),
  rows: (sid: string, req: RowsRequest) => request('POST', `/sessions/${enc(sid)}/rows`, RowsPage, req),
  count: (sid: string, req: CountRequest) => request('POST', `/sessions/${enc(sid)}/count`, CountResult, req),
  applyEdits: (sid: string, edits: RowEdit[]) =>
    request('POST', `/sessions/${enc(sid)}/edits`, ApplyEditsResult, { edits }),

  startQuery: (sid: string, req: QueryRequest) => request('POST', `/sessions/${enc(sid)}/queries`, QueryStarted, req),
  nextPage: (sid: string, qid: string, size = 500) =>
    request('GET', `/sessions/${enc(sid)}/queries/${enc(qid)}/page?size=${size}`, QueryPage),
  cancelQuery: (sid: string, qid: string) =>
    request<void>('POST', `/sessions/${enc(sid)}/queries/${enc(qid)}/cancel`, NoContent),
  closeQuery: (sid: string, qid: string) =>
    request<void>('DELETE', `/sessions/${enc(sid)}/queries/${enc(qid)}`, NoContent),
  explain: (sid: string, req: ExplainRequest) => request('POST', `/sessions/${enc(sid)}/explain`, ExplainResult, req),
  closeTab: (sid: string, tabId: string) =>
    request<void>('DELETE', `/sessions/${enc(sid)}/tabs/${enc(tabId)}`, NoContent),

  stats: <K extends StatsKind>(sid: string, kind: K) =>
    request('GET', `/sessions/${enc(sid)}/stats/${kind}`, StatsResult) as Promise<StatsResultOf<K>>,
  backendAction: (sid: string, pid: number, mode: 'cancel' | 'terminate') =>
    request('POST', `/sessions/${enc(sid)}/backends/${pid}/cancel`, BackendActionResult, { mode }),

  getLayout: (connectionId: string, schema: string) =>
    request('GET', `/layouts/${enc(connectionId)}/${enc(schema)}`, LayoutPositions),
  saveLayout: (connectionId: string, schema: string, layout: LayoutPositions) =>
    request<void>('PUT', `/layouts/${enc(connectionId)}/${enc(schema)}`, NoContent, layout),

  history: (connectionId: string, limit = 200) =>
    request('GET', `/history/${enc(connectionId)}?limit=${limit}`, z.array(HistoryEntry)),
  addHistory: (connectionId: string, entry: NewHistoryEntry) =>
    request('POST', `/history/${enc(connectionId)}`, HistoryEntry, entry),

  savedQueries: (connectionId: string) =>
    request('GET', `/saved-queries?connectionId=${enc(connectionId)}`, z.array(SavedQuery)),
  createSavedQuery: (input: SavedQueryInput) => request('POST', '/saved-queries', SavedQuery, input),
  updateSavedQuery: (id: string, input: SavedQueryInput) =>
    request('PUT', `/saved-queries/${enc(id)}`, SavedQuery, input),
  deleteSavedQuery: (id: string) => request<void>('DELETE', `/saved-queries/${enc(id)}`, NoContent),
};

/** Query keys shared across features so invalidation stays consistent. */
export const queryKeys = {
  health: ['health'] as const,
  connections: ['connections'] as const,
  session: (sid: string) => ['session', sid] as const,
  schema: (sid: string) => ['schema', sid] as const,
  rows: (sid: string, req: RowsRequest) => ['rows', sid, req] as const,
  count: (sid: string, req: CountRequest) => ['count', sid, req] as const,
  stats: (sid: string, kind: StatsKind) => ['stats', sid, kind] as const,
  layout: (connectionId: string, schema: string) => ['layout', connectionId, schema] as const,
  history: (connectionId: string) => ['history', connectionId] as const,
  savedQueries: (connectionId: string) => ['saved-queries', connectionId] as const,
};

/** One-line text for an error, e.g. "42703 column o.stauts does not exist". */
export function errorText(err: unknown): string {
  if (err instanceof ApiError) {
    return /^[0-9A-Z]{5}$/.test(err.body.code) ? `${err.body.code} ${err.body.message}` : err.body.message;
  }
  return err instanceof Error ? err.message : String(err);
}
