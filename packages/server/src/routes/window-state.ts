import type { Hono } from 'hono';
import { WindowState } from '@kleos/shared';
import type { ServerDeps } from '../http/deps';
import { KleosError } from '../errors';
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

  // Forgets a trusted SSH host key once the user has confirmed the server's key really
  // changed; the next connection then asks to trust the new key (TOFU again).
  api.delete('/ssh-known-hosts/:host/:port', (c) => {
    const port = Number(c.req.param('port'));
    if (!Number.isInteger(port) || port < 1 || port > 65535) throw KleosError.validation('Invalid SSH port');
    store.forgetKnownHost(c.req.param('host'), port);
    return c.body(null, 204);
  });
}
