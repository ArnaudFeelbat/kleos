import type { Hono } from 'hono';
import { HistorySearch, NewHistoryEntry, type HistoryEntry } from '@kleos/shared';
import type { ServerDeps } from '../http/deps';
import { HistoryQuery, jsonBody, queryOf } from './validation';

export function registerHistoryRoutes(api: Hono, deps: ServerDeps): void {
  const { store } = deps;

  // Search across servers (0.7). No path segment after /history, so it never meets /history/:connectionId.
  api.get('/history', (c) => c.json<HistoryEntry[]>(store.searchHistory(queryOf(c, HistorySearch))));

  api.get('/history/:connectionId', (c) => {
    const { limit } = queryOf(c, HistoryQuery);
    return c.json<HistoryEntry[]>(store.listHistory(c.req.param('connectionId'), limit));
  });

  api.post('/history/:connectionId', async (c) => {
    const entry = await jsonBody(c, NewHistoryEntry);
    return c.json<HistoryEntry>(store.addHistory(c.req.param('connectionId'), entry));
  });
}
