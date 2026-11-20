import { z } from 'zod';
import {
  ApiErrorBody,
  ApplyEditsResult,
  DdlPreview,
  DdlResult,
  CountResult,
  ExplainResult,
  GridLayout,
  Health,
  HistoryEntry,
  ImportPreview,
  JobStatus,
  LayoutPositions,
  QueryPage,
  QueryStarted,
  RowsPage,
  SavedConnection,
  SavedQuery,
  SchemaModel,
  SessionInfo,
  Snippet,
  StatsResult,
  TestConnectionResult,
  WindowState,
  BackendActionResult,
  type ConnectionInput,
  type CountRequest,
  type DdlRequest,
  type ExplainRequest,
  type ExportRequest,
  type ImportPreviewRequest,
  type ImportRequest,
  type NewHistoryEntry,
  type OpenSessionRequest,
  type QueryRequest,
  type RowEdit,
  type RowsRequest,
  type SavedQueryInput,
  type HistorySearch,
  type SnippetInput,
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

/** Browsers refuse keepalive requests whose body exceeds 64 KiB; stay under it. */
const KEEPALIVE_LIMIT = 60_000;

async function request<T>(
  method: Method,
  path: string,
  schema: z.ZodType<T> | null,
  body?: unknown,
  options: { keepalive?: boolean } = {},
): Promise<T> {
  const { apiBase, token } = getBridge();
  const json = body !== undefined ? JSON.stringify(body) : undefined;
  const res = await fetch(`${apiBase}/api${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      ...(json !== undefined ? { 'Content-Type': 'application/json' } : {}),
    },
    body: json,
    // Lets a save started while the window closes finish; too large a body would be refused.
    ...(options.keepalive && (json?.length ?? 0) < KEEPALIVE_LIMIT ? { keepalive: true } : {}),
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
  /** The exact statements a list of schema changes becomes; nothing runs. (0.6) */
  previewDdl: (sid: string, req: DdlRequest) => request('POST', `/sessions/${enc(sid)}/ddl/preview`, DdlPreview, req),
  /** Runs them in one transaction; a failure carries statementIndex and applies nothing. (0.6) */
  applyDdl: (sid: string, req: DdlRequest) => request('POST', `/sessions/${enc(sid)}/ddl`, DdlResult, req),
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

  getGridLayout: (connectionId: string, schema: string, table: string) =>
    request('GET', `/grid-layouts/${enc(connectionId)}/${enc(schema)}/${enc(table)}`, GridLayout),
  saveGridLayout: (connectionId: string, schema: string, table: string, layout: GridLayout) =>
    request<void>('PUT', `/grid-layouts/${enc(connectionId)}/${enc(schema)}/${enc(table)}`, NoContent, layout),

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

  // 0.7 — history search across servers, snippets.
  searchHistory: (search: HistorySearch) => {
    const qs = new URLSearchParams();
    for (const [key, value] of Object.entries(search))
      if (value !== undefined && value !== '') qs.set(key, String(value));
    return request('GET', `/history?${qs.toString()}`, z.array(HistoryEntry));
  },
  snippets: () => request('GET', '/snippets', z.array(Snippet)),
  createSnippet: (input: SnippetInput) => request('POST', '/snippets', Snippet, input),
  updateSnippet: (id: string, input: SnippetInput) => request('PUT', `/snippets/${enc(id)}`, Snippet, input),
  deleteSnippet: (id: string) => request<void>('DELETE', `/snippets/${enc(id)}`, NoContent),

  // 0.4 — export/import jobs and the restored window.
  startExport: (sid: string, req: ExportRequest) => request('POST', `/sessions/${enc(sid)}/exports`, JobStatus, req),
  importPreview: (req: ImportPreviewRequest) => request('POST', '/imports/preview', ImportPreview, req),
  startImport: (sid: string, req: ImportRequest) => request('POST', `/sessions/${enc(sid)}/imports`, JobStatus, req),
  job: (jobId: string) => request('GET', `/jobs/${enc(jobId)}`, JobStatus),
  cancelJob: (jobId: string) => request<void>('POST', `/jobs/${enc(jobId)}/cancel`, NoContent),
  getWindowState: () => request('GET', '/window-state', WindowState),
  saveWindowState: (state: WindowState) => request<void>('PUT', '/window-state', NoContent, state, { keepalive: true }),
  forgetSshHost: (host: string, port: number) =>
    request<void>('DELETE', `/ssh-known-hosts/${enc(host)}/${port}`, NoContent),
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
  gridLayout: (connectionId: string, schema: string, table: string) =>
    ['grid-layout', connectionId, schema, table] as const,
  history: (connectionId: string) => ['history', connectionId] as const,
  savedQueries: (connectionId: string) => ['saved-queries', connectionId] as const,
  historySearch: (search: HistorySearch) => ['history-search', search] as const,
  snippets: ['snippets'] as const,
  job: (jobId: string) => ['job', jobId] as const,
  windowState: ['window-state'] as const,
};

/** One-line text for an error, e.g. "42703 column o.stauts does not exist". */
export function errorText(err: unknown): string {
  if (err instanceof ApiError) {
    return /^[0-9A-Z]{5}$/.test(err.body.code) ? `${err.body.code} ${err.body.message}` : err.body.message;
  }
  return err instanceof Error ? err.message : String(err);
}
