import type { Hono } from 'hono';
import {
  ApplyEditsRequest,
  CountRequest,
  OpenSessionRequest,
  RowsRequest,
  kleosErrorCodes,
  type ApplyEditsResult,
  type CountResult,
  type RowsPage,
  type SchemaModel,
  type SessionInfo,
} from '@kleos/shared';
import { KleosError } from '../errors';
import type { ServerDeps } from '../http/deps';
import type { OpenSession } from '../sessions/registry';
import { asConnectionError, configOf, requireConnection, sshOptions } from './connections';
import { isRefresh, jsonBody, sqlStateOf } from './validation';

/** SQLSTATE invalid_password, or the driver refusing to authenticate without one. */
function isMissingPassword(err: unknown): boolean {
  if (sqlStateOf(err) === '28P01') return true;
  const message = err instanceof Error ? err.message : '';
  return /no password supplied|password must be a string/i.test(message);
}

function sessionInfo(deps: ServerDeps, entry: OpenSession): SessionInfo {
  return {
    sid: entry.sid,
    // The favorite may have been renamed or recoloured since the session opened.
    connection: deps.store.getConnection(entry.connection.id) ?? entry.connection,
    serverVersion: entry.session.serverVersion,
    serverVersionShort: entry.session.serverVersionShort,
    ...(entry.session.notices ? { notices: entry.session.notices } : {}),
  };
}

export function registerSessionRoutes(api: Hono, deps: ServerDeps): void {
  const { adapter, secrets, sessions } = deps;

  api.post('/sessions', async (c) => {
    const req = await jsonBody(c, OpenSessionRequest);
    const connection = requireConnection(deps, req.connectionId);
    const password = req.password || (await secrets.get(connection.id)) || null;
    const config = configOf(connection);
    const options = await sshOptions(deps, config, connection.id, req);
    let session;
    try {
      // The SSH tunnel opens first, so its problems (host key, passphrase) come before the password prompt.
      session = await adapter.connect(config, password, options);
    } catch (err) {
      if (!password && isMissingPassword(err)) {
        throw new KleosError(401, {
          code: kleosErrorCodes.passwordRequired,
          message: 'This server needs a password',
        });
      }
      throw asConnectionError(err);
    }
    return c.json<SessionInfo>(sessionInfo(deps, sessions.add(connection, session)));
  });

  api.get('/sessions/:sid', (c) => c.json<SessionInfo>(sessionInfo(deps, sessions.get(c.req.param('sid')))));

  api.delete('/sessions/:sid', async (c) => {
    await sessions.close(c.req.param('sid'));
    return c.body(null, 204);
  });

  api.get('/sessions/:sid/schema', async (c) => {
    const entry = sessions.get(c.req.param('sid'));
    let pending = entry.schema;
    if (!pending || isRefresh(c)) {
      const introspection = entry.session.introspect();
      pending = introspection;
      entry.schema = introspection;
      introspection.catch(() => {
        if (entry.schema === introspection) entry.schema = undefined;
      });
    }
    return c.json<SchemaModel>(await pending);
  });

  api.post('/sessions/:sid/rows', async (c) => {
    const { session } = sessions.get(c.req.param('sid'));
    const req = await jsonBody(c, RowsRequest);
    return c.json<RowsPage>(await session.fetchRows(req));
  });

  api.post('/sessions/:sid/count', async (c) => {
    const { session } = sessions.get(c.req.param('sid'));
    const req = await jsonBody(c, CountRequest);
    return c.json<CountResult>(await (req.exact ? session.count(req) : session.estimateCount(req)));
  });

  api.post('/sessions/:sid/edits', async (c) => {
    const { session } = sessions.get(c.req.param('sid'));
    const { edits } = await jsonBody(c, ApplyEditsRequest);
    if (session.readOnly) {
      throw new KleosError(403, { code: kleosErrorCodes.readOnly, message: 'This connection is read-only' });
    }
    return c.json<ApplyEditsResult>(await session.applyEdits(edits));
  });
}
