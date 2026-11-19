import { isAbsolute } from 'node:path';
import type { Hono } from 'hono';
import { ExportRequest, type JobStatus } from '@kleos/shared';
import { KleosError } from '../errors';
import type { ServerDeps } from '../http/deps';
import { jobRegistryOf } from '../jobs/registry';
import { jsonBody } from './validation';

export function registerExportRoutes(api: Hono, deps: ServerDeps): void {
  const { sessions } = deps;

  /** Starts the export and answers at once; the window polls GET /jobs/:jobId. */
  api.post('/sessions/:sid/exports', async (c) => {
    const sid = c.req.param('sid');
    const { session } = sessions.get(sid);
    const req = await jsonBody(c, ExportRequest);
    if (!isAbsolute(req.path)) throw KleosError.validation('The export path must be absolute');
    const status = jobRegistryOf(sessions).start({
      jobId: req.jobId,
      sid,
      kind: 'export',
      path: req.path,
      totalBytes: null,
      run: (job) => session.exportFile(req, job),
    });
    return c.json<JobStatus>(status, 202);
  });
}
