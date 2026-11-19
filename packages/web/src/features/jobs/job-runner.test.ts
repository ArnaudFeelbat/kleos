import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { JobStatus } from '@kleos/shared';
import type * as apiModule from '@/lib/api';
import { api, ApiError } from '@/lib/api';
import { failureText, isJobRunning, JOB_POLL_MS, progressText, runJob, stopJobPolling } from './job-runner';

vi.mock('@/lib/api', async (importOriginal) => {
  const actual = await importOriginal<typeof apiModule>();
  return { ...actual, api: { job: vi.fn(), cancelJob: vi.fn() } };
});
const toastMock = vi.hoisted(() => {
  const fn = vi.fn() as ReturnType<typeof vi.fn> & Record<'loading' | 'success' | 'error', ReturnType<typeof vi.fn>>;
  fn.loading = vi.fn();
  fn.success = vi.fn();
  fn.error = vi.fn();
  return fn;
});
vi.mock('sonner', () => ({ toast: toastMock }));
const mocked = vi.mocked(api);
const revealInFinder = vi.fn();

const status = (patch: Partial<JobStatus>): JobStatus => ({
  jobId: 'j',
  kind: 'export',
  state: 'running',
  rows: 0,
  bytes: 0,
  totalBytes: null,
  path: '/Users/me/Downloads/customers.csv',
  startedAt: '2026-11-19T10:00:00Z',
  finishedAt: null,
  error: null,
  ...patch,
});

type ToastOptions = { id: string; action?: { label: string; onClick(e: { preventDefault(): void }): void } };
const lastOptions = (fn: ReturnType<typeof vi.fn>) => fn.mock.calls.at(-1)![1] as ToastOptions;

beforeEach(() => {
  vi.useFakeTimers();
  window.kleos = { revealInFinder } as unknown as typeof window.kleos;
  mocked.cancelJob.mockResolvedValue(undefined);
});
afterEach(() => {
  stopJobPolling();
  vi.useRealTimers();
  vi.clearAllMocks();
  delete window.kleos;
});

describe('runJob', () => {
  it('polls while the job runs, shows grouped progress, then the outcome with Show in Finder', async () => {
    mocked.job
      .mockResolvedValueOnce(status({ rows: 120_400 }))
      .mockResolvedValueOnce(status({ state: 'done', rows: 1_204_331 }));
    const onDone = vi.fn();
    const start = vi.fn(async (_jobId: string) => status({ rows: 0 }));
    const done = runJob({ kind: 'export', sourceKey: 'k1', subject: 'customers', start, onDone });

    await vi.advanceTimersByTimeAsync(0);
    const jobId = start.mock.calls[0]![0] as string;
    expect(jobId).toMatch(/^[0-9a-f-]{36}$/);
    expect(isJobRunning('k1')).toBe(true);
    expect(toastMock.loading).toHaveBeenLastCalledWith('Exporting customers… 0 rows', expect.anything());

    await vi.advanceTimersByTimeAsync(JOB_POLL_MS);
    expect(mocked.job).toHaveBeenCalledWith(jobId);
    expect(toastMock.loading).toHaveBeenLastCalledWith('Exporting customers… 120,400 rows', expect.anything());
    expect(lastOptions(toastMock.loading).action?.label).toBe('Cancel');

    await vi.advanceTimersByTimeAsync(JOB_POLL_MS);
    expect(await done).toMatchObject({ state: 'done' });
    expect(toastMock.success).toHaveBeenCalledWith(
      'Exported 1,204,331 rows to customers.csv',
      expect.objectContaining({ id: `job:${jobId}` }),
    );
    lastOptions(toastMock.success).action!.onClick({ preventDefault() {} });
    expect(revealInFinder).toHaveBeenCalledWith('/Users/me/Downloads/customers.csv');
    expect(onDone).toHaveBeenCalledTimes(1);
    expect(isJobRunning('k1')).toBe(false);

    // Nothing polls once the job is over.
    await vi.advanceTimersByTimeAsync(JOB_POLL_MS * 5);
    expect(mocked.job).toHaveBeenCalledTimes(2);
  });

  it('cancels from the toast and reports the cancellation', async () => {
    mocked.job.mockResolvedValueOnce(status({ rows: 10 })).mockResolvedValueOnce(status({ state: 'cancelled' }));
    const start = vi.fn(async (_jobId: string) => status({}));
    const done = runJob({ kind: 'export', sourceKey: 'k2', subject: 'orders', start });
    await vi.advanceTimersByTimeAsync(0);

    const preventDefault = vi.fn();
    lastOptions(toastMock.loading).action!.onClick({ preventDefault });
    expect(preventDefault).toHaveBeenCalled();
    expect(mocked.cancelJob).toHaveBeenCalledWith(start.mock.calls[0]![0]);
    expect(toastMock.loading).toHaveBeenLastCalledWith('Cancelling…', expect.objectContaining({ action: undefined }));

    await vi.advanceTimersByTimeAsync(JOB_POLL_MS * 2);
    await done;
    expect(toastMock).toHaveBeenCalledWith('Export of orders cancelled.', expect.anything());
  });

  it('names the file line and column when an import fails', async () => {
    const start = vi.fn(async (_jobId: string) =>
      status({
        kind: 'import',
        state: 'failed',
        error: {
          code: '22P02',
          message: 'invalid input syntax for type integer: "abc"',
          detail: 'line 1204',
          column: 'qty',
        },
      }),
    );
    await runJob({ kind: 'import', sourceKey: 'k3', subject: 'orders', start });
    expect(toastMock.error).toHaveBeenCalledWith(
      'Import into orders failed; nothing was imported',
      expect.objectContaining({
        description: 'At line 1204, column qty: 22P02 invalid input syntax for type integer: "abc"',
      }),
    );
  });

  it('reports a job that could not start', async () => {
    const start = vi.fn(async (_jobId: string) => {
      throw new ApiError(400, { code: 'KLEOS_FILE', message: 'EACCES: permission denied' });
    });
    expect(await runJob({ kind: 'export', sourceKey: 'k4', subject: 'orders', start })).toBeNull();
    expect(toastMock.error).toHaveBeenCalledWith(
      'Couldn’t export orders',
      expect.objectContaining({ description: 'EACCES: permission denied' }),
    );
    expect(isJobRunning('k4')).toBe(false);
  });
});

describe('job texts', () => {
  it('shows import progress as rows and a share of the file', () => {
    expect(
      progressText({ kind: 'import', subject: 'orders' }, status({ rows: 1500, bytes: 250, totalBytes: 1000 })),
    ).toBe('Importing into orders… 1,500 rows (25%)');
    expect(progressText({ kind: 'import', subject: 'orders' }, null)).toBe('Importing into orders…');
  });

  it('keeps an import failure without a location to its message', () => {
    expect(failureText({ kind: 'import', subject: 'orders' }, { code: 'KLEOS_FILE', message: 'File gone' })).toEqual({
      title: 'Import into orders failed; nothing was imported',
      description: 'File gone',
    });
  });
});
