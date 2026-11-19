/**
 * The HTTP API, all JSON on 127.0.0.1 under /api, every request carrying
 * `Authorization: Bearer <per-launch token>`. Bodies and responses are the Zod
 * schemas named beside each route. Errors return ApiErrorBody.
 *
 *   GET    /health                                   -> Health
 *   GET    /connections                              -> SavedConnection[]
 *   POST   /connections          ConnectionInput     -> SavedConnection
 *   PUT    /connections/:id      ConnectionInput     -> SavedConnection
 *   DELETE /connections/:id                          -> 204 (also removes the Keychain entry)
 *   POST   /connections/test     TestConnectionRequest -> TestConnectionResult
 *   POST   /sessions             OpenSessionRequest  -> SessionInfo
 *   GET    /sessions/:sid                            -> SessionInfo
 *   DELETE /sessions/:sid                            -> 204
 *   GET    /sessions/:sid/schema?refresh=1           -> SchemaModel
 *   POST   /sessions/:sid/rows   RowsRequest         -> RowsPage
 *   POST   /sessions/:sid/count  CountRequest        -> CountResult
 *   POST   /sessions/:sid/edits  ApplyEditsRequest   -> ApplyEditsResult
 *   POST   /sessions/:sid/queries QueryRequest       -> QueryStarted   (records history)
 *   GET    /sessions/:sid/queries/:qid/page?size=500 -> QueryPage
 *   POST   /sessions/:sid/queries/:qid/cancel        -> 204
 *   DELETE /sessions/:sid/queries/:qid               -> 204 (closes the cursor)
 *   POST   /sessions/:sid/explain ExplainRequest     -> ExplainResult  (records history)
 *   DELETE /sessions/:sid/tabs/:tabId                -> 204 (releases the tab's dedicated client)
 *   GET    /sessions/:sid/stats/:kind                -> StatsResult
 *   POST   /sessions/:sid/backends/:pid/cancel BackendActionRequest -> BackendActionResult
 *   GET    /layouts/:connectionId/:schema            -> LayoutPositions
 *   PUT    /layouts/:connectionId/:schema LayoutPositions -> 204
 *   GET    /grid-layouts/:connectionId/:schema/:table -> GridLayout (empty when none saved)
 *   PUT    /grid-layouts/:connectionId/:schema/:table GridLayout -> 204
 *   POST   /sessions/:sid/exports ExportRequest       -> JobStatus (202; runs in the background)        (0.4)
 *   POST   /imports/preview      ImportPreviewRequest -> ImportPreview                                 (0.4)
 *   POST   /sessions/:sid/imports ImportRequest       -> JobStatus (202; one transaction, all or nothing) (0.4)
 *   GET    /jobs/:jobId                              -> JobStatus                                      (0.4)
 *   POST   /jobs/:jobId/cancel                       -> 204                                            (0.4)
 *   GET    /window-state                             -> WindowState (empty when none saved)            (0.4)
 *   PUT    /window-state          WindowState        -> 204                                            (0.4)
 *   GET    /history/:connectionId?limit=200          -> HistoryEntry[] (newest first)
 *   POST   /history/:connectionId NewHistoryEntry    -> HistoryEntry
 *   GET    /saved-queries?connectionId=              -> SavedQuery[]
 *   POST   /saved-queries        SavedQueryInput     -> SavedQuery
 *   PUT    /saved-queries/:id    SavedQueryInput     -> SavedQuery
 *   DELETE /saved-queries/:id                        -> 204
 */
export const API_PREFIX = '/api';
