import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import type { PostgreSqlContainer, StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import type { ConnectionConfig } from '@kleos/shared';

const IMAGE = 'postgres:17-alpine';

/**
 * Points testcontainers at OrbStack's socket when DOCKER_HOST is unset, and turns off Ryuk
 * (each suite stops its own container in afterAll). Must run before testcontainers loads,
 * which is why the module is imported dynamically below.
 */
function configureDocker(): void {
  const orbstack = join(homedir(), '.orbstack/run/docker.sock');
  if (!process.env.DOCKER_HOST && existsSync(orbstack)) process.env.DOCKER_HOST = `unix://${orbstack}`;
  process.env.TESTCONTAINERS_RYUK_DISABLED ??= 'true';
}

export type TestDatabase = {
  /** Connection settings for the adapter (superuser, no SSL). */
  config: ConnectionConfig;
  password: string;
  /** A plain client outside Kleos (application_name kleos-test), for setup and checks. */
  admin(): Promise<pg.Client>;
  /** Runs SQL as the superuser on a short-lived client. */
  sql(text: string, values?: unknown[]): Promise<pg.QueryResult>;
  stop(): Promise<void>;
};

export function fixture(name: string): string {
  return readFileSync(fileURLToPath(new URL(`../fixtures/${name}`, import.meta.url)), 'utf8');
}

/** Starts a throwaway Postgres and runs the given fixture files (from test/fixtures) in order. */
export async function startPostgres(
  options: {
    seeds?: string[];
    command?: string[];
    /**
     * Last say on the container before it starts (network, files, entrypoint). Runs after Docker
     * is configured, so it may import testcontainers itself. (0.4)
     */
    customize?: (builder: PostgreSqlContainer) => PostgreSqlContainer | Promise<PostgreSqlContainer>;
    /** Another Postgres image, e.g. an older major next to the default 17 one. (0.7.2) */
    image?: string;
  } = {},
): Promise<TestDatabase> {
  configureDocker();
  const { PostgreSqlContainer } = await import('@testcontainers/postgresql');
  const { Wait } = await import('testcontainers');
  // The image logs this line twice: after initdb's temporary server, then for the real one.
  // Cheaper than the module's default (exec'd pg_isready + port probes), which matters on a busy Mac.
  let builder = new PostgreSqlContainer(options.image ?? IMAGE)
    .withWaitStrategy(Wait.forLogMessage(/database system is ready to accept connections/, 2))
    .withStartupTimeout(170_000);
  if (options.command) builder = builder.withCommand(options.command);
  if (options.customize) builder = await options.customize(builder);
  const container: StartedPostgreSqlContainer = await builder.start();

  const config: ConnectionConfig = {
    nickname: 'test',
    host: container.getHost(),
    port: container.getPort(),
    user: container.getUsername(),
    database: container.getDatabase(),
    sslMode: 'disable',
    color: 'none',
    readOnly: false,
  };
  const password = container.getPassword();

  const admin = async () => {
    const client = new pg.Client({
      host: config.host,
      port: config.port,
      user: config.user,
      password,
      database: config.database,
      application_name: 'kleos-test',
    });
    client.on('error', () => undefined);
    await client.connect();
    return client;
  };

  const sql = async (text: string, values?: unknown[]) => {
    const client = await admin();
    try {
      return await client.query(text, values);
    } finally {
      await client.end();
    }
  };

  for (const seed of options.seeds ?? []) await sql(fixture(seed));

  return {
    config,
    password,
    admin,
    sql,
    stop: async () => {
      await container.stop({ timeout: 1000 });
    },
  };
}

/** Awaits a promise that must reject and returns its error. */
export async function rejectionOf(promise: Promise<unknown>): Promise<Record<string, unknown> & Error> {
  try {
    await promise;
  } catch (err) {
    return err as Record<string, unknown> & Error;
  }
  throw new Error('Expected the promise to reject');
}

/** Polls until `check` returns true or the timeout passes. */
export async function waitUntil(check: () => Promise<boolean>, timeoutMs = 5000, everyMs = 50): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, everyMs));
  }
  throw new Error(`Condition not met within ${timeoutMs} ms`);
}

/** Number of backends Kleos has open on the test database. */
export async function kleosBackends(db: TestDatabase): Promise<number> {
  const result = await db.sql(
    `select count(*)::int as n from pg_stat_activity where application_name = 'Kleos' and datname = current_database()`,
  );
  return result.rows[0].n as number;
}
