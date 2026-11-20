import type { Hono } from 'hono';
import { DdlRequest, kleosErrorCodes, type DdlPreview, type DdlResult } from '@kleos/shared';
import { KleosError } from '../errors';
import type { ServerDeps } from '../http/deps';
import { jsonBody } from './validation';

/** Schema editing (0.6): the preview of a batch of changes, and its run in one transaction. */
export function registerDdlRoutes(api: Hono, deps: ServerDeps): void {
  const { sessions } = deps;

  api.post('/sessions/:sid/ddl/preview', async (c) => {
    const { session } = sessions.get(c.req.param('sid'));
    const { changes } = await jsonBody(c, DdlRequest);
    return c.json<DdlPreview>(await session.previewDdl(changes));
  });

  api.post('/sessions/:sid/ddl', async (c) => {
    const entry = sessions.get(c.req.param('sid'));
    const { changes } = await jsonBody(c, DdlRequest);
    if (entry.session.readOnly) {
      throw new KleosError(403, { code: kleosErrorCodes.readOnly, message: 'This connection is read-only' });
    }
    try {
      return c.json<DdlResult>(await entry.session.applyDdl(changes));
    } finally {
      // The next GET /schema introspects again. Also after a failure: a rolled-back run left the
      // schema as it was, but a connection lost during COMMIT leaves it unknown.
      entry.schema = undefined;
    }
  });
}
