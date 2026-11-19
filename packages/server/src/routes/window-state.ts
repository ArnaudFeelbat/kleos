import type { Hono } from 'hono';
import { WindowState } from '@kleos/shared';
import type { ServerDeps } from '../http/deps';
import { jsonBody } from './validation';

/**
 * The servers and query tabs to reopen on relaunch. GET answers emptyWindowState when nothing
 * is saved, and leaves out servers whose favorite has been deleted since.
 */
export function registerWindowStateRoutes(api: Hono, deps: ServerDeps): void {
  const { store } = deps;

  api.get('/window-state', (c) => c.json<WindowState>(store.getWindowState()));

  api.put('/window-state', async (c) => {
    store.saveWindowState(await jsonBody(c, WindowState));
    return c.body(null, 204);
  });
}
