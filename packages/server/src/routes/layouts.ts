import type { Hono } from 'hono';
import { LayoutPositions } from '@kleos/shared';
import type { ServerDeps } from '../http/deps';
import { jsonBody } from './validation';

export function registerLayoutRoutes(api: Hono, deps: ServerDeps): void {
  const { store } = deps;

  api.get('/layouts/:connectionId/:schema', (c) =>
    c.json<LayoutPositions>(store.getLayout(c.req.param('connectionId'), c.req.param('schema'))),
  );

  api.put('/layouts/:connectionId/:schema', async (c) => {
    const layout = await jsonBody(c, LayoutPositions);
    store.saveLayout(c.req.param('connectionId'), c.req.param('schema'), layout);
    return c.body(null, 204);
  });
}
