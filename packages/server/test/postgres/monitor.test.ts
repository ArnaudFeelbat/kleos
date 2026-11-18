import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type pg from 'pg';
import { StatsResult } from '@kleos/shared';
import { createPostgresAdapter } from '../../src/adapter/postgres';
import type { Session } from '../../src/adapter/types';
import { type TestDatabase, startPostgres, waitUntil } from '../helpers/postgres';

let db: TestDatabase;
let session: Session;

beforeAll(async () => {
  db = await startPostgres({
    seeds: ['shop.sql'],
    command: ['postgres', '-c', 'shared_preload_libraries=pg_stat_statements'],
  });
  await db.sql('create extension pg_stat_statements');
  session = await createPostgresAdapter().connect(db.config, db.password);
});

afterAll(async () => {
  await session?.close();
  await db?.stop();
});

async function pidOf(client: pg.Client): Promise<number> {
  return (await client.query('select pg_backend_pid() as pid')).rows[0].pid as number;
}

describe('stats', () => {
  it('sessions: pg_stat_activity with blocking pids, ages, isSelf and max_connections', async () => {
    const other = await db.admin();
    try {
      const otherPid = await pidOf(other);
      await session.runQuery('select 1', { qid: 'q', tabId: 'tab', pageSize: 10 });
      const result = await session.stats('sessions');
      expect(StatsResult.parse(result)).toEqual(result);
      expect(result.maxConnections).toBe(100);
      const mine = result.sessions.filter((s) => s.isSelf);
      expect(mine.length).toBeGreaterThanOrEqual(2);
      expect(mine.every((s) => s.application === 'Kleos')).toBe(true);
      const foreign = result.sessions.find((s) => s.pid === otherPid)!;
      expect(foreign).toMatchObject({ isSelf: false, application: 'kleos-test', state: 'idle', blockedBy: [] });
      expect(foreign.backendStart).toMatch(/^\d{4}-\d{2}-\d{2} /);
      expect(typeof foreign.queryAgeSec).toBe('number');
      expect(result.sessions.some((s) => s.backendType === 'checkpointer')).toBe(true);
    } finally {
      await other.end();
    }
  });

  it('locks: a blocked query shows its blocker, with the lock it waits for', async () => {
    const blocker = await db.admin();
    const waiter = await db.admin();
    try {
      const blockerPid = await pidOf(blocker);
      const waiterPid = await pidOf(waiter);
      await blocker.query('begin');
      await blocker.query('lock table shop.accounts in access exclusive mode');
      const waiting = waiter.query('select * from shop.accounts');

      let result = await session.stats('locks');
      await waitUntil(async () => {
        result = await session.stats('locks');
        return result.blocked.some((b) => b.pid === waiterPid);
      });
      expect(StatsResult.parse(result)).toEqual(result);
      const blocked = result.blocked.find((b) => b.pid === waiterPid)!;
      expect(blocked).toMatchObject({
        blockedBy: [blockerPid],
        waitingFor: 'AccessShareLock on shop.accounts',
        query: 'select * from shop.accounts',
        application: 'kleos-test',
      });
      expect(blocked.waitingSec).toBeGreaterThanOrEqual(0);
      const holder = result.blockers.find((b) => b.pid === blockerPid)!;
      expect(holder).toMatchObject({ query: 'lock table shop.accounts in access exclusive mode', waitingFor: null });
      expect(holder.state).toBe('idle in transaction');

      await blocker.query('rollback');
      await waiting;
      expect((await session.stats('locks')).blocked).toEqual([]);
    } finally {
      await blocker.end();
      await waiter.end();
    }
  });

  it('locks: a row lock wait names the transaction it waits for', async () => {
    const blocker = await db.admin();
    const waiter = await db.admin();
    try {
      const waiterPid = await pidOf(waiter);
      await blocker.query('begin');
      await blocker.query('update shop.accounts set balance = balance + 1 where id = 1');
      const waiting = waiter.query('update shop.accounts set balance = balance - 1 where id = 1');
      let blocked: { waitingFor: string | null } | undefined;
      await waitUntil(async () => {
        blocked = (await session.stats('locks')).blocked.find((b) => b.pid === waiterPid);
        return blocked !== undefined;
      });
      expect(blocked!.waitingFor).toMatch(/^ShareLock on transaction \d+$/);
      await blocker.query('rollback');
      await waiting;
    } finally {
      await blocker.end();
      await waiter.end();
    }
  });

  it('throughput: per-second deltas between snapshots, empty until two exist', async () => {
    const first = await session.stats('throughput');
    expect(first.samples).toEqual([]);
    expect(first.numBackends).toBeGreaterThan(0);
    expect(first.cacheHitRatioTotal).toBeGreaterThan(0);
    for (let i = 0; i < 20; i += 1) await session.count({ table: { schema: 'shop', name: 'paging' }, filters: [] });
    await new Promise((resolve) => setTimeout(resolve, 1200));
    const second = await session.stats('throughput');
    expect(StatsResult.parse(second)).toEqual(second);
    expect(second.samples).toHaveLength(1);
    const sample = second.samples[0]!;
    expect(sample.commitsPerSec).toBeGreaterThan(0);
    expect(sample.xactPerSec).toBeCloseTo(sample.commitsPerSec + sample.rollbacksPerSec);
    expect(sample.tuplesReturnedPerSec).toBeGreaterThan(0);
    expect(Date.parse(sample.t)).toBeGreaterThan(Date.now() - 60_000);
    const third = await session.stats('throughput');
    expect(third.samples).toHaveLength(2);
    expect(Date.parse(third.samples[0]!.t)).toBeLessThanOrEqual(Date.parse(third.samples[1]!.t));
  });

  it('tables: size, tuples and maintenance times', async () => {
    const result = await session.stats('tables');
    expect(StatsResult.parse(result)).toEqual(result);
    const pagingTable = result.tables.find((t) => t.schema === 'shop' && t.name === 'paging')!;
    expect(pagingTable.totalBytes).toBeGreaterThan(0);
    expect(pagingTable.lastAnalyze).toMatch(/^\d{4}-\d{2}-\d{2} /);
    expect(result.tables.some((t) => t.name === 'pg_class')).toBe(false);
  });

  it('indexes: usage, size and uniqueness', async () => {
    const result = await session.stats('indexes');
    expect(StatsResult.parse(result)).toEqual(result);
    expect(result.indexes.find((i) => i.name === 'orders_customer_idx')).toMatchObject({
      schema: 'shop',
      table: 'orders',
      unique: false,
    });
    expect(result.indexes.find((i) => i.name === 'customers_email_key')!.unique).toBe(true);
    expect(result.indexes.every((i) => i.bytes > 0)).toBe(true);
  });

  it('statements: top statements by total time when pg_stat_statements is loaded', async () => {
    await session.runQuery('select count(*) from shop.paging where grp = 3', { qid: 's', tabId: 'tab', pageSize: 10 });
    const result = await session.stats('statements');
    expect(StatsResult.parse(result)).toEqual(result);
    expect(result).toMatchObject({ available: true, installHint: null });
    expect(result.statements.length).toBeGreaterThan(0);
    const totals = result.statements.map((s) => s.totalMs);
    expect([...totals].sort((a, b) => b - a)).toEqual(totals);
    expect(result.statements.some((s) => s.query.includes('shop.paging'))).toBe(true);
  });
});

describe('backendAction', () => {
  it('cancels a running backend and terminates another', async () => {
    const sleeper = await db.admin();
    const idle = await db.admin();
    try {
      const sleeperPid = await pidOf(sleeper);
      const idlePid = await pidOf(idle);
      const sleeping = sleeper.query('select pg_sleep(30)').catch((err: unknown) => err);
      await waitUntil(async () =>
        (await session.stats('sessions')).sessions.some((s) => s.pid === sleeperPid && s.state === 'active'),
      );
      expect(await session.backendAction(sleeperPid, 'cancel')).toEqual({ ok: true });
      expect(((await sleeping) as { code?: string }).code).toBe('57014');

      expect(await session.backendAction(idlePid, 'terminate')).toEqual({ ok: true });
      await waitUntil(async () => !(await session.stats('sessions')).sessions.some((s) => s.pid === idlePid));
    } finally {
      await sleeper.end();
      await idle.end().catch(() => undefined);
    }
  });

  it('answers ok: false for a pid that is not a backend', async () => {
    expect(await session.backendAction(1, 'cancel')).toEqual({ ok: false });
  });
});
