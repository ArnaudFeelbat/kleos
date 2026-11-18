import type { Hono } from 'hono';
import { GridLayout } from '@kleos/shared';
import type { ServerDeps } from '../http/deps';
import { jsonBody } from './validation';

/** A table's column order and widths in the Data tab, per favorite. */
export function registerGridLayoutRoutes(api: Hono, deps: ServerDeps): void {
  const { store } = deps;

  api.get('/grid-layouts/:connectionId/:schema/:table', (c) =>
    c.json<GridLayout>(store.getGridLayout(c.req.param('connectionId'), c.req.param('schema'), c.req.param('table'))),
  );

  api.put('/grid-layouts/:connectionId/:schema/:table', async (c) => {
    const layout = await jsonBody(c, GridLayout);
    store.saveGridLayout(c.req.param('connectionId'), c.req.param('schema'), c.req.param('table'), layout);
    return c.body(null, 204);
  });
}
