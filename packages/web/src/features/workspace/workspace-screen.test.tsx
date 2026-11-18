import { kleosErrorCodes } from '@kleos/shared';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { shopModel } from '@/features/schema/test-fixtures';
import type * as ApiModule from '@/lib/api';
import { api, ApiError } from '@/lib/api';
import { useWorkspace } from './context';
import { Providers, savedConnection, sessionInfo } from './test-workspace';
import { WorkspaceScreen } from './workspace-screen';

vi.mock('@/lib/api', async (importOriginal) => {
  const actual = await importOriginal<typeof ApiModule>();
  return { ...actual, api: { getSession: vi.fn(), schema: vi.fn() } };
});

// The tabs are other modules; stand-ins keep this test about the shell.
vi.mock('@/features/schema/schema-tab', () => ({
  SchemaTab: () => {
    const { openInQuery } = useWorkspace();
    return <button onClick={() => openInQuery('select 1;')}>schema stand-in</button>;
  },
}));
vi.mock('@/features/data/data-tab', () => ({
  DataTab: () => <p>data for {useWorkspace().selectedTable?.name ?? 'nothing'}</p>,
}));
vi.mock('@/features/query/query-tab', () => ({
  QueryTab: () => {
    const [text, setText] = useState('');
    const { queryDraft } = useWorkspace();
    return (
      <>
        <input aria-label="query stand-in" value={text} onChange={(e) => setText(e.target.value)} />
        <p>draft: {queryDraft?.sql ?? 'none'}</p>
      </>
    );
  },
}));
vi.mock('@/features/monitor/monitor-tab', () => ({ MonitorTab: () => <p>monitor stand-in</p> }));

const mocked = vi.mocked(api);
const setTitle = vi.fn();

beforeEach(() => {
  window.kleos = { apiBase: '', token: '', platform: 'darwin', openWorkspace: vi.fn(), setTitle };
  mocked.schema.mockResolvedValue(shopModel());
});
afterEach(() => {
  vi.clearAllMocks();
  delete window.kleos;
});

function renderWorkspace() {
  return render(
    <Providers>
      <WorkspaceScreen sid="s1" />
    </Providers>,
  );
}

describe('WorkspaceScreen', { timeout: 15_000 }, () => {
  it('says the session has ended when the server no longer knows it', async () => {
    mocked.getSession.mockRejectedValue(
      new ApiError(404, { code: kleosErrorCodes.sessionNotFound, message: 'Session not found or closed' }),
    );
    renderWorkspace();
    expect(await screen.findByRole('heading', { name: 'This session has ended' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Close window' })).toBeInTheDocument();
  });

  it('shows the tinted title bar, badges and window title', async () => {
    mocked.getSession.mockResolvedValue({
      ...sessionInfo,
      connection: { ...savedConnection, readOnly: true, color: 'red' },
    });
    renderWorkspace();
    const title = await screen.findByText('— kleos@localhost:5432');
    const header = title.closest('header')!;
    expect(header).toHaveAttribute('data-tint', 'red');
    expect(header).toHaveClass('app-drag');
    expect(header).toHaveTextContent('shop_dev — kleos@localhost:5432');
    expect(header).toHaveTextContent('Read-only');
    expect(header).toHaveTextContent('PG 16.4');
    expect(setTitle).toHaveBeenCalledWith('shop_dev');
    // The sidebar shows the introspected schema.
    expect(await screen.findByRole('button', { name: /^orders/ })).toBeInTheDocument();
  });

  it('keeps a visited tab mounted, opens Data on double-click and hands SQL to Query', async () => {
    const user = userEvent.setup();
    mocked.getSession.mockResolvedValue(sessionInfo);
    renderWorkspace();

    await user.click(await screen.findByRole('tab', { name: 'Query' }));
    await user.type(screen.getByLabelText('query stand-in'), 'select now()');
    await user.click(screen.getByRole('tab', { name: 'Schema' }));
    expect(screen.getByRole('tab', { name: 'Schema' })).toHaveAttribute('aria-selected', 'true');
    await user.click(screen.getByRole('tab', { name: 'Query' }));
    expect(screen.getByLabelText('query stand-in')).toHaveValue('select now()');

    await user.dblClick(await screen.findByRole('button', { name: /^orders/ }));
    expect(screen.getByRole('tab', { name: 'Data' })).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByText('data for orders')).toBeInTheDocument();

    await user.click(screen.getByRole('tab', { name: 'Schema' }));
    await user.click(screen.getByRole('button', { name: 'schema stand-in' }));
    await waitFor(() => expect(screen.getByRole('tab', { name: 'Query' })).toHaveAttribute('aria-selected', 'true'));
    expect(screen.getByText('draft: select 1;')).toBeInTheDocument();
  });
});
