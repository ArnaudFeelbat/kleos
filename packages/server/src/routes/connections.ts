import type { Hono } from 'hono';
import {
  ConnectionInput,
  TestConnectionRequest,
  type ConnectionConfig,
  type SavedConnection,
  type TestConnectionResult,
} from '@kleos/shared';
import { KleosError, connectionErrorBody, isPgError } from '../errors';
import type { ServerDeps } from '../http/deps';
import { jsonBody } from './validation';

/** The favorite's fields without id, timestamps, password or Keychain flags. */
export function configOf(value: ConnectionConfig): ConnectionConfig {
  const { nickname, host, port, user, database, sslMode, color, readOnly } = value;
  return { nickname, host, port, user, database, sslMode, color, readOnly };
}

/**
 * Driver failures without a SQLSTATE (host unreachable, connection refused, SSL
 * required) become a 400 KLEOS_CONNECTION carrying the driver's message.
 */
export function asConnectionError(err: unknown): unknown {
  if (err instanceof KleosError || isPgError(err)) return err;
  return new KleosError(400, connectionErrorBody(err));
}

export function requireConnection(deps: ServerDeps, id: string): SavedConnection {
  const connection = deps.store.getConnection(id);
  if (!connection) throw KleosError.notFound('Connection not found');
  return connection;
}

export function registerConnectionRoutes(api: Hono, deps: ServerDeps): void {
  const { store, secrets, sessions, adapter } = deps;

  api.get('/connections', (c) => c.json<SavedConnection[]>(store.listConnections()));

  api.post('/connections', async (c) => {
    const input = await jsonBody(c, ConnectionInput);
    const save = input.savePassword && !!input.password;
    const created = store.createConnection(configOf(input), save);
    if (save && input.password) {
      try {
        await secrets.set(created.id, input.password);
      } catch (err) {
        // Never leave a favorite that claims a Keychain entry it does not have.
        store.deleteConnection(created.id);
        throw err;
      }
    }
    return c.json<SavedConnection>(created);
  });

  api.post('/connections/test', async (c) => {
    const req = await jsonBody(c, TestConnectionRequest);
    const password = req.password ?? (req.connectionId ? await secrets.get(req.connectionId) : null);
    try {
      return c.json<TestConnectionResult>(await adapter.test(configOf(req), password));
    } catch (err) {
      throw asConnectionError(err);
    }
  });

  api.put('/connections/:id', async (c) => {
    const id = c.req.param('id');
    const existing = requireConnection(deps, id);
    const input = await jsonBody(c, ConnectionInput);
    let hasPassword = existing.hasPassword;
    if (!input.savePassword) {
      await secrets.delete(id);
      hasPassword = false;
    } else if (input.password) {
      await secrets.set(id, input.password);
      hasPassword = true;
    }
    // savePassword with a null (or empty) password keeps whatever is stored.
    return c.json<SavedConnection>(store.updateConnection(id, configOf(input), hasPassword));
  });

  api.delete('/connections/:id', async (c) => {
    const id = c.req.param('id');
    await Promise.allSettled(sessions.forConnection(id).map((s) => sessions.close(s.sid)));
    await secrets.delete(id);
    store.deleteConnection(id);
    return c.body(null, 204);
  });
}
