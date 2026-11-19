import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { JobStatus } from '@kleos/shared';
import { stopJobPolling } from '@/features/jobs/job-runner';
import { Providers, workspaceState } from '@/features/workspace/test-workspace';
import type * as apiModule from '@/lib/api';
import { api } from '@/lib/api';
import { ResultsExportMenu } from './results-view';
import type { RunState } from './store';

vi.mock('@/lib/api', async (importOriginal) => {
  const actual = await importOriginal<typeof apiModule>();
  return { ...actual, api: { startExport: vi.fn(), job: vi.fn(), cancelJob: vi.fn() } };
});
const mocked = vi.mocked(api);
const saveFileDialog = vi.fn();

const sql = 'select id, email from customers where active';
const run: RunState = {
  status: 'done',
  qid: 'q1',
  target: { sql, from: 0, to: sql.length },
  startedAt: 0,
  columns: [{ name: 'id', type: 'int8', typeName: 'int8', typeOid: 20, typeCategory: 'N' }],
  rows: [['1'], ['2']],
  hasMore: true,
  command: 'SELECT 2',
  rowCount: 2,
  elapsedMs: 4,
  loadingMore: false,
  pageError: null,
  error: null,
};

beforeEach(() => {
  window.kleos = { saveFileDialog, revealInFinder: vi.fn() } as unknown as typeof window.kleos;
});
afterEach(() => {
  stopJobPolling();
  vi.clearAllMocks();
  delete window.kleos;
});

describe('ResultsView export', () => {
  it('exports the statement that produced the results, run again', async () => {
    const user = userEvent.setup();
    saveFileDialog.mockResolvedValue('/Users/me/Downloads/query-results.json');
    mocked.startExport.mockResolvedValue({ state: 'done', rows: 2, path: '/x.json' } as JobStatus);
    render(
      <Providers state={workspaceState()}>
        <ResultsExportMenu sql={run.target.sql} />
      </Providers>,
    );
    await user.click(screen.getByRole('button', { name: /Export/ }));
    const menu = await screen.findByRole('menu');
    expect(menu).toHaveTextContent('Runs the statement again and exports every row it returns');
    await user.click(within(menu).getByRole('menuitem', { name: 'JSON' }));

    await waitFor(() => expect(mocked.startExport).toHaveBeenCalled());
    expect(saveFileDialog).toHaveBeenCalledWith({ defaultName: 'query-results', format: 'json' });
    expect(mocked.startExport).toHaveBeenCalledWith('s1', {
      jobId: expect.any(String),
      source: { kind: 'query', sql },
      format: 'json',
      path: '/Users/me/Downloads/query-results.json',
    });
  });
});
