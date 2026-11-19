import { useSyncExternalStore } from 'react';
import { toast } from 'sonner';
import type { ApiErrorBody, JobStatus } from '@kleos/shared';
import { api, ApiError } from '@/lib/api';
import { getBridge } from '@/lib/bridge';
import { formatInt } from '@/lib/format';

/** How often a running job is polled. */
export const JOB_POLL_MS = 400;

export type JobSpec = {
  kind: 'export' | 'import';
  /**
   * Identifies what the job reads or writes, e.g. "s1:export:public.orders": a second job
   * on the same key can't start while the first runs (see useJobRunning).
   */
  sourceKey: string;
  /** What the toasts name: a table name, or "query results". */
  subject: string;
  /** Sends the start request; the job id is chosen here so Cancel works from the first toast. */
  start(jobId: string): Promise<JobStatus>;
  /** After a job finished successfully (e.g. refresh the imported table). */
  onDone?(status: JobStatus): void;
};

// ---- running jobs, by source -------------------------------------------------------------

const running = new Map<string, string>();
const listeners = new Set<() => void>();
let version = 0;
const emit = () => {
  version += 1;
  for (const l of listeners) l();
};
const subscribe = (l: () => void) => {
  listeners.add(l);
  return () => listeners.delete(l);
};

export function isJobRunning(sourceKey: string): boolean {
  return running.has(sourceKey);
}

/** True while a job started on `sourceKey` (from any component) has not finished. */
export function useJobRunning(sourceKey: string): boolean {
  useSyncExternalStore(subscribe, () => version);
  return running.has(sourceKey);
}

// ---- texts ---------------------------------------------------------------------------------

const rowsText = (n: number) => `${formatInt(n)} ${n === 1 ? 'row' : 'rows'}`;

export function fileName(path: string): string {
  return path.split(/[/\\]/).pop() || path;
}

/** "22P02 invalid input syntax…" for SQLSTATEs, the plain message for Kleos's own codes. */
function bodyText(body: ApiErrorBody): string {
  return /^[0-9A-Z]{5}$/.test(body.code) ? `${body.code} ${body.message}` : body.message;
}

export function progressText(spec: Pick<JobSpec, 'kind' | 'subject'>, status: JobStatus | null): string {
  const lead = spec.kind === 'export' ? `Exporting ${spec.subject}…` : `Importing into ${spec.subject}…`;
  if (!status) return lead;
  const pct =
    status.totalBytes && status.totalBytes > 0
      ? ` (${Math.min(99, Math.floor((status.bytes / status.totalBytes) * 100))}%)`
      : '';
  return `${lead} ${rowsText(status.rows)}${pct}`;
}

export function doneText(spec: Pick<JobSpec, 'kind' | 'subject'>, status: JobStatus): string {
  return spec.kind === 'export'
    ? `Exported ${rowsText(status.rows)} to ${fileName(status.path)}`
    : `Imported ${rowsText(status.rows)} into ${spec.subject}`;
}

/** Title and description of a failed job; import errors name the file line and column. */
export function failureText(
  spec: Pick<JobSpec, 'kind' | 'subject'>,
  error: ApiErrorBody | null,
): { title: string; description: string } {
  if (spec.kind === 'export') {
    return { title: `Couldn’t export ${spec.subject}`, description: error ? bodyText(error) : 'Unknown error.' };
  }
  // The server puts the file line in `detail` ("line 1204") and the column in `column`.
  const line = error?.detail && /^line \d+/i.test(error.detail) ? error.detail.toLowerCase() : null;
  const where = [line, error?.column ? `column ${error.column}` : null].filter(Boolean).join(', ');
  const message = error ? bodyText(error) : 'Unknown error.';
  return {
    title: `Import into ${spec.subject} failed; nothing was imported`,
    description: where ? `At ${where}: ${message}` : message,
  };
}

export function cancelledText(spec: Pick<JobSpec, 'kind' | 'subject'>): string {
  return spec.kind === 'export'
    ? `Export of ${spec.subject} cancelled.`
    : `Import into ${spec.subject} cancelled; nothing was imported.`;
}

// ---- the runner ----------------------------------------------------------------------------

/** Timers of jobs still being polled, so stopJobPolling can end them (tests, window teardown). */
const sleepers = new Set<{ timer: ReturnType<typeof setTimeout>; wake(): void }>();
let generation = 0;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const entry = {
      timer: setTimeout(() => {
        sleepers.delete(entry);
        resolve();
      }, ms),
      wake: resolve,
    };
    sleepers.add(entry);
  });
}

/** Stops every polling loop (their toasts stay as they are) and forgets running jobs. */
export function stopJobPolling(): void {
  generation += 1;
  for (const s of sleepers) {
    clearTimeout(s.timer);
    s.wake();
  }
  sleepers.clear();
  running.clear();
  emit();
}

const errorBody = (err: unknown): ApiErrorBody =>
  err instanceof ApiError
    ? err.body
    : { code: 'KLEOS_HTTP', message: err instanceof Error ? err.message : String(err) };

/**
 * Starts a job and follows it with one toast: progress with Cancel while it runs, then the
 * outcome. Polling lives outside React on purpose: an export keeps reporting after the user
 * leaves the table it came from. It stops as soon as the job is no longer running.
 * Resolves with the final status, or null when the job could not start or be followed.
 */
export async function runJob(spec: JobSpec): Promise<JobStatus | null> {
  const jobId = crypto.randomUUID();
  const toastId = `job:${jobId}`;
  const gen = generation;
  let cancelling = false;
  let hidden = false;
  running.set(spec.sourceKey, jobId);
  emit();

  const showProgress = (status: JobStatus | null) => {
    if (hidden) return;
    toast.loading(cancelling ? 'Cancelling…' : progressText(spec, status), {
      id: toastId,
      // Closing the toast hides the progress; the outcome still shows.
      onDismiss: () => {
        hidden = true;
      },
      action: cancelling
        ? undefined
        : {
            label: 'Cancel',
            onClick: (e) => {
              // Keep the toast: it turns into the outcome once the server has stopped.
              e.preventDefault();
              cancelling = true;
              showProgress(status);
              api.cancelJob(jobId).catch(() => {
                // The job may have just finished; the next poll tells.
              });
            },
          },
    });
  };

  try {
    showProgress(null);
    let status = await spec.start(jobId);
    while (status.state === 'running') {
      showProgress(status);
      await sleep(JOB_POLL_MS);
      if (gen !== generation) return null;
      status = await api.job(jobId);
    }
    if (status.state === 'done') {
      const path = status.path;
      toast.success(doneText(spec, status), {
        id: toastId,
        duration: 10_000,
        action:
          spec.kind === 'export'
            ? { label: 'Show in Finder', onClick: () => getBridge().revealInFinder(path) }
            : undefined,
      });
      spec.onDone?.(status);
    } else if (status.state === 'failed') {
      const { title, description } = failureText(spec, status.error);
      toast.error(title, { id: toastId, description, duration: 15_000, action: undefined });
    } else {
      toast(cancelledText(spec), { id: toastId, action: undefined });
    }
    return status;
  } catch (err) {
    if (gen !== generation) return null;
    const { title, description } = failureText(spec, errorBody(err));
    toast.error(title, { id: toastId, description, duration: 15_000, action: undefined });
    return null;
  } finally {
    if (gen === generation && running.get(spec.sourceKey) === jobId) {
      running.delete(spec.sourceKey);
      emit();
    }
  }
}
