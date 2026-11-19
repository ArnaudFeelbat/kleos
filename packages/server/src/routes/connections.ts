import type { Hono } from 'hono';
import {
  ConnectionInput,
  TestConnectionRequest,
  type ConnectionConfig,
  type SavedConnection,
  type TestConnectionResult,
} from '@kleos/shared';
import type { ConnectOptions } from '../adapter/types';
import { KleosError, connectionErrorBody, isPgError } from '../errors';
import type { ServerDeps } from '../http/deps';
import { sshSecretAccount } from '../store/types';
import { jsonBody } from './validation';

/** The favorite's fields without id, timestamps, password or Keychain flags; ssh and CA absent are null. */
export function configOf(value: ConnectionConfig): ConnectionConfig {
  const { nickname, host, port, user, database, sslMode, color, readOnly } = value;
  return {
    nickname,
    host,
    port,
    user,
    database,
    sslMode,
    color,
    readOnly,
    ssh: value.ssh ?? null,
    sslRootCertPath: value.sslRootCertPath || null,
  };
}

/** Whether the favorite authenticates its SSH tunnel with a key file, the only case with a passphrase. */
function usesSshKey(config: ConnectionConfig): boolean {
  return config.ssh?.auth === 'key';
}

/**
 * What the adapter needs for the favorite's SSH tunnel: the passphrase sent with the request,
 * else the one in the Keychain (when `connectionId` names a saved favorite), and the trusted
 * host keys. Nothing is read from the Keychain for a favorite without a key-file tunnel.
 */
export async function sshOptions(
  deps: ServerDeps,
  config: ConnectionConfig,
  connectionId: string | undefined,
  request: { sshPassphrase?: string | null; trustSshFingerprint?: string },
): Promise<ConnectOptions> {
  if (!config.ssh) return {};
  const stored = usesSshKey(config) && connectionId ? await deps.secrets.get(sshSecretAccount(connectionId)) : null;
  return {
    sshPassphrase: request.sshPassphrase || stored || null,
    ...(request.trustSshFingerprint ? { trustSshFingerprint: request.trustSshFingerprint } : {}),
    knownHosts: deps.store,
  };
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
    const config = configOf(input);
    const save = input.savePassword && !!input.password;
    const saveSsh = usesSshKey(config) && !!input.saveSshPassphrase && !!input.sshPassphrase;
    const created = store.createConnection(config, save, saveSsh);
    try {
      if (save && input.password) await secrets.set(created.id, input.password);
      if (saveSsh && input.sshPassphrase) await secrets.set(sshSecretAccount(created.id), input.sshPassphrase);
    } catch (err) {
      // Never leave a favorite that claims a Keychain entry it does not have.
      await secrets.delete(created.id).catch(() => undefined);
      store.deleteConnection(created.id);
      throw err;
    }
    return c.json<SavedConnection>(created);
  });

  api.post('/connections/test', async (c) => {
    const req = await jsonBody(c, TestConnectionRequest);
    const config = configOf(req);
    const password = req.password ?? (req.connectionId ? await secrets.get(req.connectionId) : null);
    const options = await sshOptions(deps, config, req.connectionId, req);
    try {
      return c.json<TestConnectionResult>(await adapter.test(config, password, options));
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
    const config = configOf(input);
    let hasSshPassphrase = existing.hasSshPassphrase ?? false;
    // A favorite that no longer tunnels with a key file has no use for a passphrase.
    if (!usesSshKey(config) || input.saveSshPassphrase === false) {
      await secrets.delete(sshSecretAccount(id));
      hasSshPassphrase = false;
    } else if (input.saveSshPassphrase && input.sshPassphrase) {
      await secrets.set(sshSecretAccount(id), input.sshPassphrase);
      hasSshPassphrase = true;
    }
    return c.json<SavedConnection>(store.updateConnection(id, config, hasPassword, hasSshPassphrase));
  });

  api.delete('/connections/:id', async (c) => {
    const id = c.req.param('id');
    await Promise.allSettled(sessions.forConnection(id).map((s) => sessions.close(s.sid)));
    await secrets.delete(id);
    await secrets.delete(sshSecretAccount(id));
    store.deleteConnection(id);
    return c.body(null, 204);
  });
}
