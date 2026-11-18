import type { Hono } from 'hono';
import { SavedQueryInput, type SavedQuery } from '@kleos/shared';
import type { ServerDeps } from '../http/deps';
import { SavedQueriesQuery, jsonBody, queryOf } from './validation';

export function registerSavedQueryRoutes(api: Hono, deps: ServerDeps): void {
  const { store } = deps;

  api.get('/saved-queries', (c) => {
    const { connectionId } = queryOf(c, SavedQueriesQuery);
    return c.json<SavedQuery[]>(store.listSavedQueries(connectionId));
  });

  api.post('/saved-queries', async (c) => {
    const input = await jsonBody(c, SavedQueryInput);
    return c.json<SavedQuery>(store.createSavedQuery(input));
  });

  api.put('/saved-queries/:id', async (c) => {
    const input = await jsonBody(c, SavedQueryInput);
    return c.json<SavedQuery>(store.updateSavedQuery(c.req.param('id'), input));
  });

  api.delete('/saved-queries/:id', (c) => {
    store.deleteSavedQuery(c.req.param('id'));
    return c.body(null, 204);
  });
}
