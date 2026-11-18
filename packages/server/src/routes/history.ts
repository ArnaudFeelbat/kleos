import type { Hono } from 'hono';
import { NewHistoryEntry, type HistoryEntry } from '@kleos/shared';
import type { ServerDeps } from '../http/deps';
import { HistoryQuery, jsonBody, queryOf } from './validation';

export function registerHistoryRoutes(api: Hono, deps: ServerDeps): void {
  const { store } = deps;

  api.get('/history/:connectionId', (c) => {
    const { limit } = queryOf(c, HistoryQuery);
    return c.json<HistoryEntry[]>(store.listHistory(c.req.param('connectionId'), limit));
  });

  api.post('/history/:connectionId', async (c) => {
    const entry = await jsonBody(c, NewHistoryEntry);
    return c.json<HistoryEntry>(store.addHistory(c.req.param('connectionId'), entry));
  });
}
