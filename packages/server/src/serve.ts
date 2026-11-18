import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { serve } from '@hono/node-server';
import { serveStatic } from '@hono/node-server/serve-static';
import { createPostgresAdapter } from './adapter/postgres';
import type { DatabaseAdapter } from './adapter/types';
import { createApp } from './http/app';
import type { ServerDeps } from './http/deps';
import { SessionRegistry } from './sessions/registry';
import { createKeychainSecretStore } from './store/keychain';
import { createSqliteStore } from './store/sqlite';
import type { AppStore, SecretStore } from './store/types';

export type StartServerOptions = {
  /** Random per-launch token required on every /api request. */
  token: string;
  /** Directory for app.db (~/Library/Application Support/Kleos). */
  dataDir: string;
  /** 0 picks a free port. */
  port?: number;
  /** Built frontend to serve at /; omitted in development, where Vite serves it. */
  staticDir?: string;
  allowedOrigins?: string[];
  version?: string;
  adapter?: DatabaseAdapter;
  store?: AppStore;
  secrets?: SecretStore;
};

export type RunningServer = {
  port: number;
  /** http://127.0.0.1:<port> */
  url: string;
  deps: ServerDeps;
  /** Closes one database session, e.g. when its window closes. */
  closeSession(sid: string): Promise<void>;
  close(): Promise<void>;
};

export async function startServer(options: StartServerOptions): Promise<RunningServer> {
  mkdirSync(options.dataDir, { recursive: true });
  const deps: ServerDeps = {
    adapter: options.adapter ?? createPostgresAdapter(),
    store: options.store ?? createSqliteStore(join(options.dataDir, 'app.db')),
    secrets: options.secrets ?? createKeychainSecretStore(),
    sessions: new SessionRegistry(),
    version: options.version ?? '0.1.0',
  };

  let port = 0;
  const app = createApp(deps, {
    token: options.token,
    getPort: () => port,
    allowedOrigins: options.allowedOrigins,
  });
  if (options.staticDir) {
    app.use('/*', serveStatic({ root: options.staticDir }));
    app.get('*', serveStatic({ root: options.staticDir, path: 'index.html' }));
  }

  const server = await new Promise<ReturnType<typeof serve>>((resolve) => {
    const s = serve({ fetch: app.fetch, hostname: '127.0.0.1', port: options.port ?? 0 }, () => resolve(s));
  });
  port = (server.address() as AddressInfo).port;

  return {
    port,
    url: `http://127.0.0.1:${port}`,
    deps,
    closeSession: (sid) => deps.sessions.close(sid),
    async close() {
      await deps.sessions.closeAll();
      // Keep-alive sockets from the renderer would otherwise hold close() open forever.
      if ('closeAllConnections' in server) server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      deps.store.close();
    },
  };
}
