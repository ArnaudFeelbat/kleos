import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type * as apiModule from '@/lib/api';
import { api, ApiError } from '@/lib/api';
import {
  addTab,
  cancelRunning,
  closeTab,
  getQueryWorkspace,
  getTab,
  historyLoadsDirectly,
  isDirty,
  loadMore,
  openDraft,
  openSavedQuery,
  peekQueryWorkspace,
  persistedQueryTabs,
  relinkSavedQueries,
  resetQueryWorkspaces,
  requestTabAction,
  restoreQueryTabs,
  runExplain,
  runQuery,
  runScript,
  selectScriptStep,
  shownRun,
  takeTabAction,
  updateTab,
} from './store';
import { splitScript } from './sql-script';

vi.mock('@/lib/api', async (importOriginal) => {
  const actual = await importOriginal<typeof apiModule>();
  return {
    ...actual,
    api: {
      startQuery: vi.fn(),
      nextPage: vi.fn(),
      cancelQuery: vi.fn(),
      closeQuery: vi.fn(),
      closeTab: vi.fn(),
      explain: vi.fn(),
    },
  };
});

const mocked = vi.mocked(api);
const sid = 's1';
const col = { name: 'n', type: 'integer', typeName: 'int4', typeOid: 23, typeCategory: 'N' };

beforeEach(() => {
  resetQueryWorkspaces();
  mocked.cancelQuery.mockResolvedValue(undefined);
  mocked.closeQuery.mockResolvedValue(undefined);
  mocked.closeTab.mockResolvedValue(undefined);
});
afterEach(() => vi.clearAllMocks());

describe('query tabs', () => {
  it('starts with one tab and adds numbered tabs with their own ids', () => {
    const first = getQueryWorkspace(sid).tabs[0]!;
    expect(first.title).toBe('Query 1');
    const id = addTab(sid);
    const ws = getQueryWorkspace(sid);
    expect(ws.tabs.map((t) => t.title)).toEqual(['Query 1', 'Query 2']);
    expect(ws.activeId).toBe(id);
    expect(id).not.toBe(first.id);
  });

  it('closing a tab releases its server client and keeps one tab open', () => {
    const only = getQueryWorkspace(sid).tabs[0]!;
    closeTab(sid, only.id);
    expect(mocked.closeTab).toHaveBeenCalledWith(sid, only.id);
    const ws = getQueryWorkspace(sid);
    expect(ws.tabs).toHaveLength(1);
    expect(ws.tabs[0]!.id).not.toBe(only.id);
    expect(ws.activeId).toBe(ws.tabs[0]!.id);
  });

  it('marks unsaved tabs dirty', () => {
    const tab = getQueryWorkspace(sid).tabs[0]!;
    expect(isDirty(tab)).toBe(false);
    updateTab(sid, tab.id, (t) => ({ ...t, sql: 'select 1' }));
    expect(isDirty(getTab(sid, tab.id)!)).toBe(true);
    updateTab(sid, tab.id, (t) => ({ ...t, saved: { id: 'q', name: 'one', sql: 'select 1', chart: null } }));
    expect(isDirty(getTab(sid, tab.id)!)).toBe(false);
  });

  it('opens a query draft once per nonce, reusing an empty tab', () => {
    openDraft(sid, { sql: 'select 42', nonce: 7 });
    openDraft(sid, { sql: 'select 42', nonce: 7 });
    let ws = getQueryWorkspace(sid);
    expect(ws.tabs.map((t) => t.sql)).toEqual(['select 42']);
    openDraft(sid, { sql: 'select 43', nonce: 8 });
    ws = getQueryWorkspace(sid);
    expect(ws.tabs.map((t) => t.sql)).toEqual(['select 42', 'select 43']);
    expect(ws.activeId).toBe(ws.tabs[1]!.id);
  });
});

describe('restoring query tabs', () => {
  const chart = { type: 'line' as const, x: 'day', y: ['n'] };

  it('round-trips titles, SQL, charts, saved links and the active tab — and nothing else', () => {
    const restoredSid = 'restored';
    expect(peekQueryWorkspace(restoredSid)).toBeUndefined();
    restoreQueryTabs(
      restoredSid,
      [
        { title: 'Query 2', sql: 'select 2', chart: null, savedQueryId: null },
        { title: 'Daily', sql: 'select day, n from t', chart, savedQueryId: 'q1' },
      ],
      1,
    );
    const ws = getQueryWorkspace(restoredSid);
    expect(ws.tabs.map((t) => [t.title, t.view, t.run, t.saved?.id ?? null])).toEqual([
      ['Query 2', 'results', null, null],
      ['Daily', 'chart', null, 'q1'],
    ]);
    expect(ws.activeId).toBe(ws.tabs[1]!.id);
    // The next new tab doesn't reuse a restored number.
    addTab(restoredSid);
    expect(getQueryWorkspace(restoredSid).tabs.at(-1)!.title).toBe('Query 3');

    const back = persistedQueryTabs(getQueryWorkspace(restoredSid));
    expect(back.tabs.slice(0, 2)).toEqual([
      { title: 'Query 2', sql: 'select 2', chart: null, savedQueryId: null },
      { title: 'Daily', sql: 'select day, n from t', chart, savedQueryId: 'q1' },
    ]);
    expect(back.active).toBe(2);
  });

  it('clamps a stale active index and ignores an empty list', () => {
    restoreQueryTabs(sid, [], 0);
    expect(getQueryWorkspace(sid).tabs.map((t) => t.title)).toEqual(['Query 1']);
    restoreQueryTabs(sid, [{ title: 'Only', sql: '', chart: null, savedQueryId: null }], 5);
    expect(getQueryWorkspace(sid).activeId).toBe(getQueryWorkspace(sid).tabs[0]!.id);
  });

  it('relinks tabs to their saved queries as they are now', () => {
    restoreQueryTabs(sid, [{ title: 'Daily', sql: 'select 2', chart: null, savedQueryId: 'q1' }], 0);
    relinkSavedQueries(sid, [
      { id: 'q1', connectionId: 'c1', name: 'Daily', sql: 'select 1', chart: null, createdAt: '', updatedAt: '' },
    ]);
    const tab = getQueryWorkspace(sid).tabs[0]!;
    expect(tab.saved?.sql).toBe('select 1');
    expect(isDirty(tab)).toBe(true);
    relinkSavedQueries(sid, []);
    expect(getQueryWorkspace(sid).tabs[0]!.saved).toBeNull();
  });
});

describe('running a query', () => {
  it('sends a client-generated qid so Cancel works while the first page is in flight', async () => {
    let resolve!: (v: Awaited<ReturnType<typeof api.startQuery>>) => void;
    mocked.startQuery.mockReturnValue(new Promise((r) => (resolve = r)));
    const tab = getQueryWorkspace(sid).tabs[0]!;
    const running = runQuery(sid, tab.id, { sql: 'select pg_sleep(60)', from: 0, to: 19 });

    const sent = mocked.startQuery.mock.calls[0]![1];
    expect(sent).toMatchObject({ sql: 'select pg_sleep(60)', tabId: tab.id, pageSize: 500 });
    expect(getTab(sid, tab.id)!.run).toMatchObject({ status: 'running', qid: sent.qid });

    await cancelRunning(sid, tab.id);
    expect(mocked.cancelQuery).toHaveBeenCalledWith(sid, sent.qid);

    resolve({ qid: sent.qid, columns: [col], rows: [['1']], hasMore: false, command: null, rowCount: 1, elapsedMs: 3 });
    await running;
    expect(getTab(sid, tab.id)!.run).toMatchObject({ status: 'done', rows: [['1']], elapsedMs: 3 });
  });

  it('shows a cancelled statement as cancelled, not as an error', async () => {
    mocked.startQuery.mockRejectedValue(
      new ApiError(400, { code: '57014', message: 'canceling statement due to user request' }),
    );
    const tab = getQueryWorkspace(sid).tabs[0]!;
    await runQuery(sid, tab.id, { sql: 'select pg_sleep(60)', from: 0, to: 19 });
    expect(getTab(sid, tab.id)!.run?.status).toBe('cancelled');
  });

  it('keeps the error body with its position', async () => {
    mocked.startQuery.mockRejectedValue(
      new ApiError(400, { code: '42703', message: 'column o.stauts does not exist', position: 8, hint: 'Perhaps…' }),
    );
    const tab = getQueryWorkspace(sid).tabs[0]!;
    const settled = vi.fn();
    await runQuery(sid, tab.id, { sql: 'select o.stauts from orders o', from: 0, to: 29 }, settled);
    expect(getTab(sid, tab.id)!.run).toMatchObject({ status: 'error', error: { code: '42703', position: 8 } });
    expect(settled).toHaveBeenCalled();
  });

  it('pages 500 rows at a time and appends them', async () => {
    mocked.startQuery.mockResolvedValue({
      qid: 'x',
      columns: [col],
      rows: [['1']],
      hasMore: true,
      command: null,
      rowCount: 1,
      elapsedMs: 1,
    });
    mocked.nextPage.mockResolvedValue({ rows: [['2'], ['3']], hasMore: false, elapsedMs: 1 });
    const tab = getQueryWorkspace(sid).tabs[0]!;
    await runQuery(sid, tab.id, { sql: 'select n from t', from: 0, to: 15 });
    const qid = getTab(sid, tab.id)!.run!.qid;
    await loadMore(sid, tab.id);
    expect(mocked.nextPage).toHaveBeenCalledWith(sid, qid, 500);
    expect(getTab(sid, tab.id)!.run).toMatchObject({ rows: [['1'], ['2'], ['3']], hasMore: false, rowCount: 3 });
    await loadMore(sid, tab.id);
    expect(mocked.nextPage).toHaveBeenCalledTimes(1);
  });
});

describe('historyLoadsDirectly', () => {
  it('loads into an empty tab or one that already holds the same SQL, and asks otherwise', () => {
    expect(historyLoadsDirectly('', 'select 1')).toBe(true);
    expect(historyLoadsDirectly('  \n', 'select 1')).toBe(true);
    expect(historyLoadsDirectly('select 1\n', 'select 1')).toBe(true);
    expect(historyLoadsDirectly('select 2', 'select 1')).toBe(false);
  });
});

const started = (over: Partial<Awaited<ReturnType<typeof api.startQuery>>> = {}) => ({
  qid: 'x',
  columns: [],
  rows: [],
  hasMore: false,
  command: 'INSERT 0 1',
  rowCount: 1,
  elapsedMs: 2,
  ...over,
});

describe('run all', () => {
  const script = 'begin;\ninsert into t values (1);\n\nselect n from t;\ncommit;';

  it('runs every statement in order on the tab, one result each, and shows the last', async () => {
    mocked.startQuery
      .mockResolvedValueOnce(started({ command: 'BEGIN', rowCount: null }))
      .mockResolvedValueOnce(started())
      .mockResolvedValueOnce(started({ columns: [col], rows: [['1']], command: null }))
      .mockResolvedValueOnce(started({ command: 'COMMIT', rowCount: null }));
    const tab = getQueryWorkspace(sid).tabs[0]!;
    const onStep = vi.fn();
    const done = await runScript(sid, tab.id, splitScript(script), {}, onStep);

    expect(mocked.startQuery.mock.calls.map(([, req]) => [req.sql, req.tabId, req.params])).toEqual([
      ['begin', tab.id, undefined],
      ['insert into t values (1)', tab.id, undefined],
      ['select n from t', tab.id, undefined],
      ['commit', tab.id, undefined],
    ]);
    expect(new Set(mocked.startQuery.mock.calls.map(([, req]) => req.qid)).size).toBe(4);
    expect(onStep).toHaveBeenCalledTimes(4);
    expect(done).toMatchObject({ status: 'done', current: 3, selected: null });
    expect(done!.steps.map((s) => [s.line, s.run?.status, s.run?.command])).toEqual([
      [1, 'done', 'BEGIN'],
      [2, 'done', 'INSERT 0 1'],
      [4, 'done', null],
      [5, 'done', 'COMMIT'],
    ]);
    const t = getTab(sid, tab.id)!;
    expect(t.run).toBeNull();
    expect(shownRun(t)?.command).toBe('COMMIT');
    selectScriptStep(sid, tab.id, 2);
    expect(shownRun(getTab(sid, tab.id)!)?.rows).toEqual([['1']]);
  });

  it('stops at the first error and leaves the rest unrun', async () => {
    mocked.startQuery
      .mockResolvedValueOnce(started({ command: 'BEGIN', rowCount: null }))
      .mockRejectedValueOnce(new ApiError(400, { code: '23505', message: 'duplicate key value' }));
    const tab = getQueryWorkspace(sid).tabs[0]!;
    const done = await runScript(sid, tab.id, splitScript(script));
    expect(mocked.startQuery).toHaveBeenCalledTimes(2);
    expect(done).toMatchObject({ status: 'error', current: 1 });
    expect(done!.steps.map((s) => s.run?.status ?? null)).toEqual(['done', 'error', null, null]);
    expect(shownRun(getTab(sid, tab.id)!)?.error).toMatchObject({ code: '23505' });
    // A statement that never ran cannot be picked.
    selectScriptStep(sid, tab.id, 3);
    expect(getTab(sid, tab.id)!.script!.selected).toBeNull();
  });

  it('cancels the running statement and stops there', async () => {
    let reject!: (err: unknown) => void;
    mocked.startQuery
      .mockResolvedValueOnce(started({ command: 'BEGIN', rowCount: null }))
      .mockReturnValueOnce(new Promise((_, r) => (reject = r)));
    const tab = getQueryWorkspace(sid).tabs[0]!;
    const running = runScript(sid, tab.id, splitScript(script));
    await vi.waitFor(() => expect(mocked.startQuery).toHaveBeenCalledTimes(2));
    expect(getTab(sid, tab.id)!.script).toMatchObject({ status: 'running', current: 1 });

    await cancelRunning(sid, tab.id);
    const qid = mocked.startQuery.mock.calls[1]![1].qid;
    expect(mocked.cancelQuery).toHaveBeenCalledWith(sid, qid);
    reject(new ApiError(400, { code: '57014', message: 'canceling statement due to user request' }));
    const done = await running;
    expect(done).toMatchObject({ status: 'cancelled', current: 1 });
    expect(done!.steps.map((s) => s.run?.status ?? null)).toEqual(['done', 'cancelled', null, null]);
    expect(mocked.startQuery).toHaveBeenCalledTimes(2);
  });

  it('stops before the next statement when Cancel lands between two', async () => {
    let resolve!: (v: ReturnType<typeof started>) => void;
    mocked.startQuery.mockReturnValueOnce(new Promise((r) => (resolve = r)));
    const tab = getQueryWorkspace(sid).tabs[0]!;
    const running = runScript(sid, tab.id, splitScript(script));
    await cancelRunning(sid, tab.id);
    // The statement finished on the server before the cancel reached it.
    resolve(started({ command: 'BEGIN', rowCount: null }));
    expect(await running).toMatchObject({ status: 'cancelled', current: 0 });
    expect(mocked.startQuery).toHaveBeenCalledTimes(1);
  });

  it('keeps the rows of a result whose cursor the next statement closed', async () => {
    mocked.startQuery
      .mockResolvedValueOnce(started({ columns: [col], rows: [['1']], hasMore: true, command: null }))
      .mockResolvedValueOnce(started({ command: 'SELECT 1' }));
    const tab = getQueryWorkspace(sid).tabs[0]!;
    const done = await runScript(sid, tab.id, splitScript('select n from big; select 1'));
    expect(done!.steps[0]!.run).toMatchObject({ hasMore: false, truncated: true, rows: [['1']] });
  });

  it('passes each statement only its own parameters, renumbered', async () => {
    mocked.startQuery.mockResolvedValue(started());
    const tab = getQueryWorkspace(sid).tabs[0]!;
    const sql = 'delete from t where d < :day;\nselect 1;\ninsert into log values ($2, :day, :who)';
    await runScript(sid, tab.id, splitScript(sql), { ':day': '2026-11-01', $2: 'x', ':who': null });
    expect(mocked.startQuery.mock.calls.map(([, req]) => [req.sql, req.params])).toEqual([
      ['delete from t where d < $1', ['2026-11-01']],
      ['select 1', undefined],
      ['insert into log values ($1, $2, $3)', ['x', '2026-11-01', null]],
    ]);
  });
});

describe('parameters', () => {
  it('binds placeholders as params on a run and maps the error position back', async () => {
    mocked.startQuery.mockRejectedValue(
      new ApiError(400, { code: '42703', message: 'column "stauts" does not exist', position: 12 }),
    );
    const tab = getQueryWorkspace(sid).tabs[0]!;
    const sql = 'select :customer_name, stauts from t';
    await runQuery(sid, tab.id, { sql, from: 0, to: sql.length }, undefined, { ':customer_name': 'Ada' });
    expect(mocked.startQuery).toHaveBeenCalledWith(
      sid,
      expect.objectContaining({ sql: 'select $1, stauts from t', params: ['Ada'] }),
    );
    // "stauts" is character 12 of the SQL sent and 24 of the SQL as written.
    expect(getTab(sid, tab.id)!.run!.error!.position).toBe(sql.indexOf('stauts') + 1);
  });

  it('binds placeholders on explain too', async () => {
    mocked.explain.mockResolvedValue({ plan: { 'Node Type': 'Result' }, planningMs: 0, executionMs: 0 });
    const tab = getQueryWorkspace(sid).tabs[0]!;
    await runExplain(sid, tab.id, { sql: 'select $1::int', from: 0, to: 14 }, undefined, { $1: '7' });
    expect(mocked.explain).toHaveBeenCalledWith(sid, expect.objectContaining({ sql: 'select $1::int', params: ['7'] }));
  });

  it('seeds a tab opened from a saved query with its remembered values', () => {
    const q = {
      id: 'q1',
      connectionId: 'c1',
      name: 'By customer',
      sql: 'select * from orders where customer_id = :customer',
      chart: null,
      paramValues: { ':customer': '42' },
      createdAt: '',
      updatedAt: '',
    };
    const id = openSavedQuery(sid, q);
    expect(getTab(sid, id)!.paramValues).toEqual({ ':customer': '42' });
    // Values typed in the open tab win when the query is opened again.
    updateTab(sid, id, (t) => ({ ...t, paramValues: { ':customer': '7' } }));
    expect(openSavedQuery(sid, { ...q, paramValues: { ':customer': '42', ':other': 'x' } })).toBe(id);
    expect(getTab(sid, id)!.paramValues).toEqual({ ':customer': '7', ':other': 'x' });
  });
});

describe('pending tab actions', () => {
  it('are taken once', () => {
    const tab = getQueryWorkspace(sid).tabs[0]!;
    requestTabAction(sid, tab.id, { kind: 'insert', text: 'now()' });
    expect(takeTabAction(sid, tab.id)).toEqual({ kind: 'insert', text: 'now()' });
    expect(takeTabAction(sid, tab.id)).toBeNull();
  });
});
