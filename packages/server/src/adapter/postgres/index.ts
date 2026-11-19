import pg from 'pg';
import type { ConnectionConfig, TestConnectionResult } from '@kleos/shared';
import { type SshTunnel, openTunnel } from '../../ssh/tunnel';
import type { ConnectOptions, DatabaseAdapter, Session, SessionNotice } from '../types';
import { type Endpoint, clientConfig, withSslFallback } from './connect';
import { PostgresSession } from './session';
import { type Queryable, backendPid, metaQuery, processId } from './types';

const POOL_SIZE = 4;
/** Idle pool clients are closed after a minute; monitoring polls keep them warm while visible. */
const POOL_IDLE_MS = 60_000;

/**
 * Opens the favorite's SSH tunnel, if it has one, before anything else: SSH problems (agent,
 * key, passphrase, host key) are reported before Postgres ever asks for a password.
 */
async function tunnelFor(config: ConnectionConfig, options: ConnectOptions): Promise<SshTunnel | null> {
  if (!config.ssh) return null;
  if (!options.knownHosts) throw new Error('An SSH tunnel needs the known hosts store');
  return openTunnel({
    ssh: config.ssh,
    target: { host: config.host, port: config.port },
    passphrase: options.sshPassphrase ?? null,
    trustFingerprint: options.trustSshFingerprint,
    knownHosts: options.knownHosts,
  });
}

function endpointOf(tunnel: SshTunnel | null): Endpoint | null {
  return tunnel ? { host: '127.0.0.1', port: tunnel.localPort } : null;
}

/**
 * Runs `open` with the favorite's tunnel (or none); on failure closes the tunnel and reports
 * a tunnel-caused error as such.
 */
async function throughTunnel<T>(
  config: ConnectionConfig,
  options: ConnectOptions,
  open: (endpoint: Endpoint | null, tunnel: SshTunnel | null) => Promise<T>,
): Promise<T> {
  const tunnel = await tunnelFor(config, options);
  try {
    return await open(endpointOf(tunnel), tunnel);
  } catch (err) {
    const explained = tunnel ? await tunnel.explain(err) : err;
    await tunnel?.close();
    throw explained;
  }
}

/**
 * Notices for a read-only session. dblink_exec opens its own connection, with its own
 * settings, so default_transaction_read_only does not reach it. (postgres_fdw writes are
 * refused: they go through the local executor, which checks the read-only transaction.)
 */
async function readOnlyNotices(client: Queryable): Promise<SessionNotice[]> {
  const [row] = await metaQuery<{ dblink: boolean }>(
    client,
    `select exists (select 1 from pg_extension where extname = 'dblink') as dblink`,
  );
  return row?.dblink
    ? [
        {
          code: 'READ_ONLY_DBLINK',
          message:
            'dblink is installed in this database: dblink_exec can still write, here or on other servers, even on a read-only connection.',
        },
      ]
    : [];
}

/**
 * The Postgres implementation of DatabaseAdapter (node-postgres + pg-cursor). Every value
 * crosses as text or null; identifiers are quoted and values are parameters.
 */
export function createPostgresAdapter(): DatabaseAdapter {
  return {
    connect(config: ConnectionConfig, password: string | null, options: ConnectOptions = {}): Promise<Session> {
      return throughTunnel(config, options, (endpoint, tunnel) => openSession(config, password, endpoint, tunnel));
    },

    async test(config: ConnectionConfig, password: string | null, options: ConnectOptions = {}) {
      const started = performance.now();
      const { version, ssl } = await throughTunnel(config, options, async (endpoint, tunnel) => {
        try {
          const { value, ssl } = await withSslFallback(config, async (ssl) => {
            const client = new pg.Client(clientConfig(config, password, ssl, endpoint));
            client.on('error', () => undefined);
            // A failed connect cleans up after itself; end() is only for a client that connected.
            await client.connect();
            try {
              const [row] = await metaQuery<{ version: string }>(client, 'select version() as version');
              return row?.version ?? '';
            } finally {
              await client.end().catch(() => undefined);
            }
          });
          return { version: value, ssl };
        } finally {
          await tunnel?.close();
        }
      });
      return {
        version,
        elapsedMs: Math.round(performance.now() - started),
        tls: ssl !== false,
      } satisfies TestConnectionResult;
    },
  };
}

async function openSession(
  config: ConnectionConfig,
  password: string | null,
  endpoint: Endpoint | null,
  tunnel: SshTunnel | null,
): Promise<Session> {
  const ownPids = new Set<number>();
  const { value } = await withSslFallback(config, async (ssl) => {
    const settings = clientConfig(config, password, ssl, endpoint);
    const pool = new pg.Pool({ ...settings, max: POOL_SIZE, idleTimeoutMillis: POOL_IDLE_MS });
    // Idle clients that die (server restart, terminated backend) must not crash the app.
    pool.on('error', () => undefined);
    pool.on('connect', (client) => ownPids.add(backendPid(client)));
    pool.on('remove', (client) => {
      const pid = processId(client);
      if (pid !== null) ownPids.delete(pid);
    });
    try {
      const client = await pool.connect();
      try {
        const [info] = await metaQuery<{ version: string; short: string; num: number }>(
          client,
          `select version() as version, current_setting('server_version') as short,
                      current_setting('server_version_num')::int as num`,
        );
        const notices = config.readOnly ? await readOnlyNotices(client) : [];
        return { pool, settings, info: info!, notices };
      } finally {
        client.release();
      }
    } catch (err) {
      await pool.end().catch(() => undefined);
      throw err;
    }
  });
  return new PostgresSession({
    pool: value.pool,
    clientConfig: value.settings,
    readOnly: config.readOnly,
    serverVersion: value.info.version,
    // "16.4 (Debian 16.4-1.pgdg120+1)" -> "16.4"
    serverVersionShort: value.info.short.split(' ')[0] ?? value.info.short,
    serverVersionNum: value.info.num,
    ownPids,
    notices: value.notices,
    tunnel,
  });
}
