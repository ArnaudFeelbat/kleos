import type { StatsKind, StatsResult } from '@kleos/shared';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { WorkspaceTab } from '@/features/workspace/context';
import { Providers, workspaceState } from '@/features/workspace/test-workspace';
import type * as ApiModule from '@/lib/api';
import { api } from '@/lib/api';
import { MonitorTab } from './monitor-tab';
import { SlowQueriesPanel } from './slow-queries-panel';

vi.mock('@/lib/api', async (importOriginal) => {
  const actual = await importOriginal<typeof ApiModule>();
  return { ...actual, api: { stats: vi.fn(), backendAction: vi.fn() } };
});

const mocked = vi.mocked(api);

function snapshot(kind: StatsKind): StatsResult {
  switch (kind) {
    case 'sessions':
      return { kind, maxConnections: 100, sessions: [] };
    case 'locks':
      return { kind, blocked: [], blockers: [] };
    case 'throughput':
      return { kind, samples: [], cacheHitRatioTotal: 0.992, numBackends: 3 };
    case 'tables':
      return { kind, tables: [] };
    case 'indexes':
      return { kind, indexes: [] };
    case 'statements':
      return { kind, available: false, installHint: 'CREATE EXTENSION pg_stat_statements;', statements: [] };
  }
}

function renderMonitor(activeTab: WorkspaceTab) {
  return render(
    <Providers state={workspaceState({ activeTab })}>
      <MonitorTab />
    </Providers>,
  );
}

function setVisibility(state: DocumentVisibilityState) {
  Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => state });
  document.dispatchEvent(new Event('visibilitychange'));
}

beforeEach(() => {
  mocked.stats.mockImplementation(async (_sid: string, kind: StatsKind) => snapshot(kind) as never);
});
afterEach(() => {
  vi.clearAllMocks();
  setVisibility('visible');
});

describe('MonitorTab polling', { timeout: 15_000 }, () => {
  it('polls every panel while it is the active tab and the window is visible', async () => {
    renderMonitor('monitor');
    await waitFor(() => expect(mocked.stats).toHaveBeenCalledTimes(6));
    expect(new Set(mocked.stats.mock.calls.map((c) => c[1]))).toEqual(
      new Set(['sessions', 'locks', 'throughput', 'tables', 'indexes', 'statements']),
    );
    expect(await screen.findByText('99.2%')).toBeInTheDocument();
    expect(screen.getByText('Slow queries need pg_stat_statements')).toBeInTheDocument();
  });

  it('fetches nothing while another tab is active', async () => {
    renderMonitor('query');
    await new Promise((r) => setTimeout(r, 50));
    expect(mocked.stats).not.toHaveBeenCalled();
  });

  it('fetches nothing while the window is hidden', async () => {
    setVisibility('hidden');
    renderMonitor('monitor');
    await new Promise((r) => setTimeout(r, 50));
    expect(mocked.stats).not.toHaveBeenCalled();
  });
});

describe('SlowQueriesPanel', { timeout: 15_000 }, () => {
  it('explains how to install pg_stat_statements instead of showing an error', async () => {
    const user = userEvent.setup();
    const writeText = vi.spyOn(navigator.clipboard, 'writeText').mockResolvedValue();
    render(
      <Providers>
        <SlowQueriesPanel
          stats={{ kind: 'statements', available: false, installHint: null, statements: [] }}
          error={null}
          poll="30 s"
        />
      </Providers>,
    );
    expect(screen.getByText('Slow queries need pg_stat_statements')).toBeInTheDocument();
    expect(screen.getByText('CREATE EXTENSION pg_stat_statements;')).toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Copy' }));
    expect(writeText).toHaveBeenCalledWith('CREATE EXTENSION pg_stat_statements;');
  });

  it('ranks statements by total time', () => {
    render(
      <Providers>
        <SlowQueriesPanel
          stats={{
            kind: 'statements',
            available: true,
            installHint: null,
            statements: [
              { query: 'select fast', calls: 412_880, meanMs: 3.1, totalMs: 1_278_000, rows: 1 },
              { query: 'select slow', calls: 1204, meanMs: 2840, totalMs: 3_420_000, rows: 1 },
            ],
          }}
          error={null}
          poll="30 s"
        />
      </Providers>,
    );
    const rows = screen.getAllByRole('row').slice(1);
    expect(rows[0]).toHaveTextContent('select slow1,2042.84 s57.0 min');
    expect(rows[1]).toHaveTextContent('select fast412,8803.1 ms21.3 min');
  });
});
