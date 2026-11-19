import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import type { ImportPreview, JobStatus } from '@kleos/shared';
import { JobRegistry, jobRegistryOf } from '../jobs/registry';
import { SessionRegistry } from '../sessions/registry';
import { pgError, setup } from './test-utils';

const dir = mkdtempSync(join(tmpdir(), 'kleos-jobs-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

function file(name: string, content: string | Buffer): string {
  const path = join(dir, name);
  writeFileSync(path, content);
  return path;
}

const exportBody = (jobId: string, overrides: Record<string, unknown> = {}) => ({
  jobId,
  source: { kind: 'table', table: { schema: 'public', name: 'orders' }, filters: [], sort: [] },
  format: 'csv',
  path: join(dir, `${jobId}.csv`),
  ...overrides,
});

const importBody = (jobId: string, path: string) => ({
  jobId,
  table: { schema: 'public', name: 'orders' },
  path,
  delimiter: ',',
  hasHeader: true,
  mapping: [{ fileColumn: 0, column: 'id' }],
});

/** A job body that runs until the cancel arrives. */
function untilCancelled(job: { signal: AbortSignal }): Promise<never> {
  return new Promise((_resolve, reject) => {
    job.signal.addEventListener('abort', () => setTimeout(() => reject(new Error('stopped')), 5));
  });
}

describe('export and import jobs', () => {
  it('starts an export with 202 and the running status, then reports it done', async () => {
    const { call, openSession, sessions } = setup();
    const { sid, session } = await openSession();
    const res = await call('POST', `/sessions/${sid}/exports`, exportBody('e1'));
    expect(res.status).toBe(202);
    expect(res.body).toMatchObject({
      jobId: 'e1',
      kind: 'export',
      state: 'running',
      rows: 0,
      bytes: 0,
      totalBytes: null,
      finishedAt: null,
      error: null,
    });
    expect(session.callsTo('exportFile')[0]?.[0]).toMatchObject({ jobId: 'e1', format: 'csv' });

    await jobRegistryOf(sessions).settled('e1');
    const done = await call('GET', '/jobs/e1');
    expect(done.status).toBe(200);
    expect(done.body).toMatchObject({ state: 'done', rows: 3, bytes: 42 });
    expect((done.body as JobStatus).finishedAt).toEqual(expect.any(String));
  });

  it('refuses a second job with the same id (409) and an unknown job (404)', async () => {
    const { call, openSession } = setup();
    const { sid } = await openSession();
    expect((await call('POST', `/sessions/${sid}/exports`, exportBody('dup'))).status).toBe(202);
    const again = await call('POST', `/sessions/${sid}/exports`, exportBody('dup'));
    expect(again.status).toBe(409);
    expect(again.body).toMatchObject({ code: 'KLEOS_VALIDATION' });

    for (const res of [await call('GET', '/jobs/nope'), await call('POST', '/jobs/nope/cancel')]) {
      expect(res.status).toBe(404);
      expect(res.body).toMatchObject({ code: 'KLEOS_JOB_NOT_FOUND' });
    }
  });

  it('refuses a relative path and an unknown session', async () => {
    const { call, openSession } = setup();
    const { sid } = await openSession();
    const relative = await call('POST', `/sessions/${sid}/exports`, exportBody('rel', { path: 'out.csv' }));
    expect(relative.status).toBe(400);
    expect((await call('POST', '/sessions/nope/exports', exportBody('x'))).status).toBe(404);
  });

  it('cancels a running job, then answers 204 again for the finished one', async () => {
    const { call, openSession, sessions } = setup();
    const { sid, session } = await openSession();
    session.jobWork = (job) => {
      job.progress({ rows: 10, bytes: 100 });
      return untilCancelled(job);
    };
    await call('POST', `/sessions/${sid}/exports`, exportBody('c1'));
    expect((await call('GET', '/jobs/c1')).body).toMatchObject({ state: 'running', rows: 10, bytes: 100 });

    expect((await call('POST', '/jobs/c1/cancel')).status).toBe(204);
    const status = await jobRegistryOf(sessions).settled('c1');
    expect(status).toMatchObject({ state: 'cancelled', error: null });
    expect((await call('POST', '/jobs/c1/cancel')).status).toBe(204);
    expect((await call('GET', '/jobs/c1')).body).toMatchObject({ state: 'cancelled' });
  });

  it('reports a failure with the error body', async () => {
    const { call, openSession, sessions } = setup();
    const { sid, session } = await openSession();
    session.jobWork = async () => {
      throw pgError('25006', 'cannot execute INSERT in a read-only transaction');
    };
    await call('POST', `/sessions/${sid}/exports`, exportBody('f1'));
    const status = await jobRegistryOf(sessions).settled('f1');
    expect(status.state).toBe('failed');
    expect(status.error).toEqual({ code: '25006', message: 'cannot execute INSERT in a read-only transaction' });
  });

  it('cancels the jobs of a session when it closes', async () => {
    const { call, openSession } = setup();
    const { sid, session } = await openSession();
    session.jobWork = untilCancelled;
    await call('POST', `/sessions/${sid}/exports`, exportBody('s1'));
    expect((await call('DELETE', `/sessions/${sid}`)).status).toBe(204);
    // The session's close waited for the job to stop.
    expect((await call('GET', '/jobs/s1')).body).toMatchObject({ state: 'cancelled' });
  });

  it('starts an import with the file size as totalBytes', async () => {
    const { call, openSession, sessions } = setup();
    const { sid, session } = await openSession();
    const path = file('in.csv', 'id\n1\n2\n');
    const res = await call('POST', `/sessions/${sid}/imports`, importBody('i1', path));
    expect(res.status).toBe(202);
    expect(res.body).toMatchObject({ kind: 'import', state: 'running', totalBytes: 7, path });
    expect(session.callsTo('importFile')[0]?.[0]).toMatchObject({ nullValues: [''] });
    await jobRegistryOf(sessions).settled('i1');
  });

  it('refuses an import on a read-only session and a missing file', async () => {
    const { call, openSession } = setup();
    const ro = await openSession({ readOnly: true });
    const path = file('ro.csv', 'id\n1\n');
    const refused = await call('POST', `/sessions/${ro.sid}/imports`, importBody('r1', path));
    expect(refused.status).toBe(403);
    expect(refused.body).toMatchObject({ code: 'KLEOS_READ_ONLY' });
    expect(ro.session.callsTo('importFile')).toHaveLength(0);

    const rw = await openSession();
    const missing = await call('POST', `/sessions/${rw.sid}/imports`, importBody('m1', join(dir, 'missing.csv')));
    expect(missing.status).toBe(400);
    expect(missing.body).toMatchObject({ code: 'KLEOS_FILE', detail: 'ENOENT' });
  });

  it('forgets a finished job after its time to live', async () => {
    const sessions = new SessionRegistry();
    const jobs = new JobRegistry(sessions, 20);
    jobs.start({
      jobId: 'ttl',
      sid: 's',
      kind: 'export',
      path: '/x.csv',
      totalBytes: null,
      run: async () => ({ rows: 1, bytes: 1 }),
    });
    expect((await jobs.settled('ttl')).state).toBe('done');
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(() => jobs.get('ttl')).toThrow('Job not found');
  });
});

describe('POST /imports/preview', () => {
  async function preview(body: Record<string, unknown>) {
    const { call } = setup();
    return call('POST', '/imports/preview', body);
  }

  it('detects a semicolon file, strips the BOM and reads the header', async () => {
    const path = file('semi.csv', '\uFEFFid;name;note\n1;Ada;"a, b"\n2;Grace;"x;y"\n');
    const res = await preview({ path });
    expect(res.status).toBe(200);
    expect(res.body).toEqual<ImportPreview>({
      path,
      delimiter: ';',
      columns: ['id', 'name', 'note'],
      rows: [
        ['1', 'Ada', 'a, b'],
        ['2', 'Grace', 'x;y'],
      ],
      totalRows: 2,
      bytes: Buffer.byteLength('\uFEFFid;name;note\n1;Ada;"a, b"\n2;Grace;"x;y"\n'),
    });
  });

  it('detects comma and tab, and names columns without a header', async () => {
    const comma = await preview({ path: file('comma.csv', 'a,b\n1,2\n') });
    expect(comma.body).toMatchObject({ delimiter: ',', columns: ['a', 'b'] });
    const tab = await preview({ path: file('tab.tsv', '1\tx\n2\ty\n3\tz\n'), hasHeader: false });
    expect(tab.body).toMatchObject({
      delimiter: '\t',
      columns: ['column 1', 'column 2'],
      rows: [
        ['1', 'x'],
        ['2', 'y'],
        ['3', 'z'],
      ],
      totalRows: 3,
    });
  });

  it('honours an explicit delimiter, returns 50 rows and counts them all', async () => {
    const lines = ['n'];
    for (let i = 1; i <= 120; i += 1) lines.push(String(i));
    const res = await preview({ path: file('many.csv', `${lines.join('\n')}\n`), delimiter: ';' });
    const body = res.body as ImportPreview;
    expect(body.delimiter).toBe(';');
    expect(body.rows).toHaveLength(50);
    expect(body.rows[49]).toEqual(['50']);
    expect(body.totalRows).toBe(120);
  });

  it('keeps quoted line breaks inside one row', async () => {
    const res = await preview({ path: file('multi.csv', 'id,text\n1,"one\ntwo"\n2,three\n') });
    expect(res.body).toMatchObject({
      rows: [
        ['1', 'one\ntwo'],
        ['2', 'three'],
      ],
      totalRows: 2,
    });
  });

  it('fails with KLEOS_FILE for a file that is not UTF-8, missing, or not CSV', async () => {
    const latin1 = await preview({ path: file('latin1.csv', Buffer.from('name\ncaf\xe9\n', 'latin1')) });
    expect(latin1.status).toBe(400);
    expect(latin1.body).toMatchObject({ code: 'KLEOS_FILE', message: expect.stringMatching(/not UTF-8/) });

    const missing = await preview({ path: join(dir, 'nope.csv') });
    expect(missing.body).toMatchObject({ code: 'KLEOS_FILE', detail: 'ENOENT' });

    const broken = await preview({ path: file('broken.csv', 'a,b\n1,"open\n2,3\n') });
    expect(broken.body).toMatchObject({ code: 'KLEOS_FILE', message: expect.stringMatching(/not valid CSV/) });
  });
});
