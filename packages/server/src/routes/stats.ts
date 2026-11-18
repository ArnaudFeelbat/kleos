import type { Hono } from 'hono';
import { BackendActionRequest, StatsKind, type BackendActionResult, type StatsResult } from '@kleos/shared';
import type { ServerDeps } from '../http/deps';
import { Pid, jsonBody } from './validation';

export function registerStatsRoutes(api: Hono, deps: ServerDeps): void {
  const { sessions } = deps;

  api.get('/sessions/:sid/stats/:kind', async (c) => {
    const { session } = sessions.get(c.req.param('sid'));
    const kind = StatsKind.parse(c.req.param('kind'));
    return c.json<StatsResult>(await session.stats(kind));
  });

  api.post('/sessions/:sid/backends/:pid/cancel', async (c) => {
    const { session } = sessions.get(c.req.param('sid'));
    const pid = Pid.parse(c.req.param('pid'));
    const { mode } = await jsonBody(c, BackendActionRequest);
    return c.json<BackendActionResult>(await session.backendAction(pid, mode));
  });
}
