import type { Hono } from 'hono';
import type { ServerDeps } from '../http/deps';
import { registerConnectionRoutes } from './connections';
import { registerDdlRoutes } from './ddl';
import { registerGridLayoutRoutes } from './grid-layouts';
import { registerHistoryRoutes } from './history';
import { registerJobRoutes } from './jobs';
import { registerLayoutRoutes } from './layouts';
import { registerQueryRoutes } from './queries';
import { registerSavedQueryRoutes } from './saved-queries';
import { registerSessionRoutes } from './sessions';
import { registerSnippetRoutes } from './snippets';
import { registerStatsRoutes } from './stats';
import { registerWindowStateRoutes } from './window-state';

/** Mounts every /api route of @kleos/shared/routes.ts under the given app (already prefixed /api). */
export function registerRoutes(api: Hono, deps: ServerDeps): void {
  registerWindowStateRoutes(api, deps);
  registerConnectionRoutes(api, deps);
  registerSessionRoutes(api, deps);
  registerDdlRoutes(api, deps);
  registerQueryRoutes(api, deps);
  registerStatsRoutes(api, deps);
  registerJobRoutes(api, deps);
  registerLayoutRoutes(api, deps);
  registerGridLayoutRoutes(api, deps);
  registerHistoryRoutes(api, deps);
  registerSavedQueryRoutes(api, deps);
  registerSnippetRoutes(api, deps);
}
