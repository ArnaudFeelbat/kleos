import type { Hono } from 'hono';
import type { ServerDeps } from '../http/deps';
import { registerConnectionRoutes } from './connections';
import { registerGridLayoutRoutes } from './grid-layouts';
import { registerHistoryRoutes } from './history';
import { registerLayoutRoutes } from './layouts';
import { registerQueryRoutes } from './queries';
import { registerSavedQueryRoutes } from './saved-queries';
import { registerSessionRoutes } from './sessions';
import { registerStatsRoutes } from './stats';

/** Mounts every /api route of @kleos/shared/routes.ts under the given app (already prefixed /api). */
export function registerRoutes(api: Hono, deps: ServerDeps): void {
  registerConnectionRoutes(api, deps);
  registerSessionRoutes(api, deps);
  registerQueryRoutes(api, deps);
  registerStatsRoutes(api, deps);
  registerLayoutRoutes(api, deps);
  registerGridLayoutRoutes(api, deps);
  registerHistoryRoutes(api, deps);
  registerSavedQueryRoutes(api, deps);
}
