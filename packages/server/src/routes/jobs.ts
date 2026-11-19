import type { Hono } from 'hono';
import type { JobStatus } from '@kleos/shared';
import type { ServerDeps } from '../http/deps';
import { jobRegistryOf } from '../jobs/registry';
import { registerExportRoutes } from './exports';
import { registerImportRoutes } from './imports';

/** Export, import and the job routes they share (0.4). */
export function registerJobRoutes(api: Hono, deps: ServerDeps): void {
  registerExportRoutes(api, deps);
  registerImportRoutes(api, deps);
  const jobs = () => jobRegistryOf(deps.sessions);

  api.get('/jobs/:jobId', (c) => c.json<JobStatus>(jobs().get(c.req.param('jobId'))));

  /** Idempotent: cancelling a finished job changes nothing. */
  api.post('/jobs/:jobId/cancel', (c) => {
    jobs().cancel(c.req.param('jobId'));
    return c.body(null, 204);
  });
}
