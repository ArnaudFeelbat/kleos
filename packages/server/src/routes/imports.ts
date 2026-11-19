import { stat } from 'node:fs/promises';
import { isAbsolute } from 'node:path';
import type { Hono } from 'hono';
import {
  ImportPreviewRequest,
  ImportRequest,
  kleosErrorCodes,
  type ImportPreview,
  type JobStatus,
} from '@kleos/shared';
import { KleosError } from '../errors';
import type { ServerDeps } from '../http/deps';
import { previewCsv } from '../jobs/csv-reader';
import { fileError } from '../jobs/files';
import { jobRegistryOf } from '../jobs/registry';
import { jsonBody } from './validation';

function requireAbsolute(path: string): void {
  if (!isAbsolute(path)) throw KleosError.validation('The file path must be absolute');
}

export function registerImportRoutes(api: Hono, deps: ServerDeps): void {
  const { sessions } = deps;

  /** Reads the whole file once (no session needed): delimiter, columns, first rows, row count. */
  api.post('/imports/preview', async (c) => {
    const req = await jsonBody(c, ImportPreviewRequest);
    requireAbsolute(req.path);
    return c.json<ImportPreview>(await previewCsv(req));
  });

  /** Starts the import and answers at once; the window polls GET /jobs/:jobId. */
  api.post('/sessions/:sid/imports', async (c) => {
    const sid = c.req.param('sid');
    const { session } = sessions.get(sid);
    const req = await jsonBody(c, ImportRequest);
    requireAbsolute(req.path);
    if (session.readOnly) {
      throw new KleosError(403, { code: kleosErrorCodes.readOnly, message: 'This connection is read-only' });
    }
    let totalBytes: number;
    try {
      totalBytes = (await stat(req.path)).size;
    } catch (err) {
      throw fileError(err);
    }
    const status = jobRegistryOf(sessions).start({
      jobId: req.jobId,
      sid,
      kind: 'import',
      path: req.path,
      totalBytes,
      run: (job) => session.importFile(req, job),
    });
    return c.json<JobStatus>(status, 202);
  });
}
