import { kleosErrorCodes, type SavedConnection } from '@kleos/shared';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Providers, savedConnection, sessionInfo } from '@/features/workspace/test-workspace';
import type * as ApiModule from '@/lib/api';
import { api, ApiError } from '@/lib/api';
import type { KleosBridge } from '@/lib/bridge';
import { ConnectionsScreen } from './connections-screen';

vi.mock('@/lib/api', async (importOriginal) => {
  const actual = await importOriginal<typeof ApiModule>();
  return {
    ...actual,
    api: {
      health: vi.fn(),
      listConnections: vi.fn(),
      createConnection: vi.fn(),
      updateConnection: vi.fn(),
      deleteConnection: vi.fn(),
      testConnection: vi.fn(),
      openSession: vi.fn(),
    },
  };
});

const mocked = vi.mocked(api);
const bridge = {
  apiBase: 'http://127.0.0.1:1',
  token: 't',
  platform: 'darwin',
  openWorkspace: vi.fn(async () => {}),
  setTitle: vi.fn(),
} satisfies KleosBridge;

function renderScreen(favorites: SavedConnection[]) {
  mocked.listConnections.mockResolvedValue(favorites);
  return render(
    <Providers>
      <ConnectionsScreen />
    </Providers>,
  );
}

beforeEach(() => {
  window.kleos = bridge;
  mocked.health.mockResolvedValue({ ok: true, version: '0.1.0' });
});

afterEach(() => {
  vi.clearAllMocks();
  delete window.kleos;
});

describe('ConnectionsScreen', { timeout: 15_000 }, () => {
  it('shows the server health and the favorites', async () => {
    renderScreen([{ ...savedConnection, readOnly: true }]);
    await waitFor(() => expect(screen.getByTestId('health')).toHaveTextContent('Server ok · v0.1.0'));
    const nav = screen.getByRole('navigation', { name: 'Saved connections' });
    expect(await within(nav).findByText('shop_dev')).toBeInTheDocument();
    expect(within(nav).getByText('kleos@localhost:5432/shop_dev')).toBeInTheDocument();
    expect(within(nav).getByLabelText('Read-only')).toBeInTheDocument();
  });

  it('fills the whole form when a postgres URL is pasted into any field', async () => {
    renderScreen([]);
    const nickname = await screen.findByLabelText('Nickname');
    expect(screen.getByLabelText('Host')).toHaveValue('localhost');
    expect(screen.getByLabelText('Port')).toHaveValue('5432');
    expect(screen.getByLabelText('Database')).toHaveAttribute('placeholder', 'same as user');

    fireEvent.paste(nickname, {
      clipboardData: { getData: () => 'postgres://alice:s3cret@db.example.com:6543/shop?sslmode=require' },
    });

    expect(screen.getByLabelText('Nickname')).toHaveValue('db.example.com');
    expect(screen.getByLabelText('Host')).toHaveValue('db.example.com');
    expect(screen.getByLabelText('Port')).toHaveValue('6543');
    expect(screen.getByLabelText('User')).toHaveValue('alice');
    expect(screen.getByLabelText('Password')).toHaveValue('s3cret');
    expect(screen.getByLabelText('Database')).toHaveValue('shop');
    expect(screen.getByLabelText('SSL mode')).toHaveTextContent('require');
  });

  it('lets a plain-text paste through', async () => {
    renderScreen([]);
    const host = await screen.findByLabelText('Host');
    const event = new Event('paste', { bubbles: true, cancelable: true });
    Object.assign(event, { clipboardData: { getData: () => 'just text' } });
    host.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(false);
    expect(host).toHaveValue('localhost');
  });

  it('shows the driver error when the test fails', async () => {
    const user = userEvent.setup();
    mocked.testConnection.mockRejectedValue(
      new ApiError(400, { code: '28P01', message: 'password authentication failed for user "kleos"' }),
    );
    renderScreen([savedConnection]);
    await user.click(await screen.findByRole('button', { name: 'Test connection' }));
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('Connection failed');
    expect(alert).toHaveTextContent('28P01 password authentication failed for user "kleos"');
    expect(mocked.testConnection).toHaveBeenCalledWith(
      expect.objectContaining({ host: 'localhost', user: 'kleos', password: null, connectionId: 'c1' }),
    );
  });

  it('shows the version and elapsed time when the test succeeds', async () => {
    const user = userEvent.setup();
    mocked.testConnection.mockResolvedValue({
      version: 'PostgreSQL 16.4 on aarch64-apple-darwin23',
      elapsedMs: 38.4,
    });
    renderScreen([savedConnection]);
    await user.click(await screen.findByRole('button', { name: 'Test connection' }));
    const status = await screen.findByRole('status');
    expect(status).toHaveTextContent('Connection works · 38 ms');
    expect(status).toHaveTextContent('PostgreSQL 16.4 on aarch64-apple-darwin23');
  });

  it('refuses to test without a user and says why', async () => {
    const user = userEvent.setup();
    renderScreen([]);
    await user.click(await screen.findByRole('button', { name: 'Test connection' }));
    expect(screen.getByText('User is required.')).toBeInTheDocument();
    expect(mocked.testConnection).not.toHaveBeenCalled();
  });

  it('prompts for the password when the server needs one, then opens the workspace', async () => {
    const user = userEvent.setup();
    const favorite = { ...savedConnection, hasPassword: false, color: 'blue' as const };
    mocked.openSession
      .mockRejectedValueOnce(new ApiError(401, { code: kleosErrorCodes.passwordRequired, message: 'needs a password' }))
      .mockResolvedValueOnce({ ...sessionInfo, sid: 'sid-9', connection: favorite });
    renderScreen([favorite]);

    await user.click(await screen.findByRole('button', { name: /^Connect/ }));
    const dialog = await screen.findByRole('dialog');
    expect(dialog).toHaveTextContent('Password for shop_dev');
    expect(mocked.openSession).toHaveBeenLastCalledWith({ connectionId: 'c1', password: null });

    await user.type(within(dialog).getByLabelText('Password'), 'hunter2');
    await user.click(within(dialog).getByRole('button', { name: 'Connect' }));

    await waitFor(() =>
      expect(bridge.openWorkspace).toHaveBeenCalledWith({ sid: 'sid-9', title: 'shop_dev', color: 'blue' }),
    );
    expect(mocked.openSession).toHaveBeenLastCalledWith({ connectionId: 'c1', password: 'hunter2' });
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(mocked.updateConnection).not.toHaveBeenCalled();
  });

  it('keeps the dialog open with the error when the typed password is wrong', async () => {
    const user = userEvent.setup();
    mocked.openSession
      .mockRejectedValueOnce(new ApiError(401, { code: kleosErrorCodes.passwordRequired, message: 'needs a password' }))
      .mockRejectedValueOnce(new ApiError(400, { code: '28P01', message: 'password authentication failed' }));
    renderScreen([{ ...savedConnection, hasPassword: false }]);
    await user.click(await screen.findByRole('button', { name: /^Connect/ }));
    const dialog = await screen.findByRole('dialog');
    await user.type(within(dialog).getByLabelText('Password'), 'wrong{Enter}');
    expect(await within(dialog).findByRole('alert')).toHaveTextContent('28P01 password authentication failed');
    expect(bridge.openWorkspace).not.toHaveBeenCalled();
  });

  it('connects on double-click and Enter on a favorite', async () => {
    const user = userEvent.setup();
    mocked.openSession.mockResolvedValue(sessionInfo);
    renderScreen([savedConnection]);
    const nav = screen.getByRole('navigation', { name: 'Saved connections' });
    const item = await within(nav).findByRole('button', { name: /shop_dev/ });
    await user.dblClick(item);
    await waitFor(() => expect(bridge.openWorkspace).toHaveBeenCalledTimes(1));
    item.focus();
    await user.keyboard('{Enter}');
    await waitFor(() => expect(bridge.openWorkspace).toHaveBeenCalledTimes(2));
  });

  it('saves a new connection before connecting it', async () => {
    const user = userEvent.setup();
    const created = { ...savedConnection, id: 'new-1', nickname: 'db.local', host: 'db.local', database: 'kleos' };
    mocked.createConnection.mockResolvedValue(created);
    mocked.openSession.mockResolvedValue({ ...sessionInfo, connection: created });
    renderScreen([]);
    await user.clear(await screen.findByLabelText('Host'));
    await user.type(screen.getByLabelText('Host'), 'db.local');
    await user.type(screen.getByLabelText('User'), 'kleos');
    await user.type(screen.getByLabelText('Password'), 'pw');
    await user.click(screen.getByRole('button', { name: /Save & Connect/ }));

    await waitFor(() => expect(bridge.openWorkspace).toHaveBeenCalled());
    expect(mocked.createConnection).toHaveBeenCalledWith(
      expect.objectContaining({
        nickname: 'db.local',
        host: 'db.local',
        user: 'kleos',
        database: 'kleos',
        password: 'pw',
      }),
    );
    expect(mocked.openSession).toHaveBeenCalledWith({ connectionId: 'new-1', password: 'pw' });
  });
});
