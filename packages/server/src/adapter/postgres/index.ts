import pg from 'pg';
import type { ConnectionConfig, TestConnectionResult } from '@kleos/shared';
import type { DatabaseAdapter, Session } from '../types';
import { clientConfig, withSslFallback } from './connect';
import { PostgresSession } from './session';
import { backendPid, metaQuery, processId } from './types';

const POOL_SIZE = 4;
/** Idle pool clients are closed after a minute; monitoring polls keep them warm while visible. */
const POOL_IDLE_MS = 60_000;

/**
 * The Postgres implementation of DatabaseAdapter (node-postgres + pg-cursor). Every value
 * crosses as text or null; identifiers are quoted and values are parameters.
 */
export function createPostgresAdapter(): DatabaseAdapter {
  return {
    async connect(config: ConnectionConfig, password: string | null): Promise<Session> {
      const ownPids = new Set<number>();
      const { value } = await withSslFallback(config, async (ssl) => {
        const settings = clientConfig(config, password, ssl);
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
            return { pool, settings, info: info! };
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
      });
    },

    async test(config: ConnectionConfig, password: string | null): Promise<TestConnectionResult> {
      const started = performance.now();
      const { value: version } = await withSslFallback(config, async (ssl) => {
        const client = new pg.Client(clientConfig(config, password, ssl));
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
      return { version, elapsedMs: Math.round(performance.now() - started) };
    },
  };
}
