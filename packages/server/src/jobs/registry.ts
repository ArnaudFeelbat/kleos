import { type JobStatus, kleosErrorCodes } from '@kleos/shared';
import type { JobContext, JobResult } from '../adapter/types';
import { KleosError } from '../errors';
import { toErrorResponse } from '../http/app';
import type { SessionRegistry } from '../sessions/registry';

/** Finished jobs stay readable this long, for a window that polls late (or was asleep). */
export const FINISHED_JOB_TTL_MS = 60 * 60 * 1000;

type Job = {
  status: JobStatus;
  sid: string;
  controller: AbortController;
  /** Settles once the work has ended and cleaned up (file deleted, transaction rolled back). */
  done: Promise<void>;
};

export type StartJob = {
  jobId: string;
  sid: string;
  kind: JobStatus['kind'];
  path: string;
  totalBytes: number | null;
  run: (job: JobContext) => Promise<JobResult>;
};

/**
 * Export and import jobs by id, in memory. A job belongs to its session and is cancelled when
 * the session closes; a finished job is forgotten an hour later. The state turns `cancelled`
 * once the work has actually stopped, so a cancelled export has no file left behind and a
 * cancelled import has rolled back.
 */
export class JobRegistry {
  private readonly jobs = new Map<string, Job>();

  constructor(
    sessions: SessionRegistry,
    private readonly ttlMs = FINISHED_JOB_TTL_MS,
  ) {
    sessions.onClose((sid) => this.cancelSession(sid));
  }

  /** Registers the job, starts its work in the background and returns its first status. */
  start(spec: StartJob): JobStatus {
    if (this.jobs.has(spec.jobId)) {
      throw new KleosError(409, { code: kleosErrorCodes.validation, message: `Job ${spec.jobId} already exists` });
    }
    const controller = new AbortController();
    const status: JobStatus = {
      jobId: spec.jobId,
      kind: spec.kind,
      state: 'running',
      rows: 0,
      bytes: 0,
      totalBytes: spec.totalBytes,
      path: spec.path,
      startedAt: new Date().toISOString(),
      finishedAt: null,
      error: null,
    };
    const job: Job = { status, sid: spec.sid, controller, done: Promise.resolve() };
    this.jobs.set(spec.jobId, job);
    const context: JobContext = {
      signal: controller.signal,
      progress: ({ rows, bytes }) => {
        if (status.state !== 'running') return;
        status.rows = rows;
        status.bytes = bytes;
      },
    };
    job.done = (async () => {
      try {
        const result = await spec.run(context);
        this.finish(job, controller.signal.aborted ? 'cancelled' : 'done', result);
      } catch (err) {
        if (controller.signal.aborted) this.finish(job, 'cancelled');
        else this.finish(job, 'failed', undefined, err);
      }
    })();
    return { ...status };
  }

  get(jobId: string): JobStatus {
    return { ...this.require(jobId).status };
  }

  /** Asks the job to stop; a finished job is left as it is. */
  cancel(jobId: string): void {
    const job = this.require(jobId);
    if (job.status.state === 'running') job.controller.abort();
  }

  /** Settles when the job's work has ended (tests, shutdown). */
  async settled(jobId: string): Promise<JobStatus> {
    const job = this.require(jobId);
    await job.done;
    return { ...job.status };
  }

  /** Cancels every running job of a session; resolves once they have all stopped. */
  async cancelSession(sid: string): Promise<void> {
    const running = [...this.jobs.values()].filter((j) => j.sid === sid && j.status.state === 'running');
    for (const job of running) job.controller.abort();
    await Promise.all(running.map((j) => j.done));
  }

  private finish(job: Job, state: Exclude<JobStatus['state'], 'running'>, result?: JobResult, err?: unknown): void {
    const { status } = job;
    status.state = state;
    status.finishedAt = new Date().toISOString();
    if (result) {
      status.rows = result.rows;
      status.bytes = result.bytes;
    }
    if (state === 'failed') {
      const { body, status: http } = toErrorResponse(err);
      if (http >= 500) console.error(`[kleos] ${status.kind} job failed`, err);
      status.error = body;
    }
    const timer = setTimeout(() => {
      if (this.jobs.get(status.jobId) === job) this.jobs.delete(status.jobId);
    }, this.ttlMs);
    timer.unref?.();
  }

  private require(jobId: string): Job {
    const job = this.jobs.get(jobId);
    if (!job) throw new KleosError(404, { code: kleosErrorCodes.jobNotFound, message: 'Job not found' });
    return job;
  }
}

const registries = new WeakMap<SessionRegistry, JobRegistry>();

/** The job registry of a server, one per SessionRegistry, created on first use. */
export function jobRegistryOf(sessions: SessionRegistry): JobRegistry {
  let jobs = registries.get(sessions);
  if (!jobs) {
    jobs = new JobRegistry(sessions);
    registries.set(sessions, jobs);
  }
  return jobs;
}
