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
  peekQueryWorkspace,
  persistedQueryTabs,
  relinkSavedQueries,
  resetQueryWorkspaces,
  restoreQueryTabs,
  runQuery,
  updateTab,
} from './store';

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
