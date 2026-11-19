import { kleosErrorCodes, type SavedConnection } from '@kleos/shared';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Providers, savedConnection, sessionInfo } from '@/features/workspace/test-workspace';
import type * as ApiModule from '@/lib/api';
import { api, ApiError } from '@/lib/api';
import type { KleosBridge } from '@/lib/bridge';
import { HOME, tabsStore } from '@/features/shell/tabs-store';
import { ConnectProvider } from './connect-context';
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
      forgetSshHost: vi.fn(),
    },
  };
});

const mocked = vi.mocked(api);
const bridge = {
  apiBase: 'http://127.0.0.1:1',
  token: 't',
  platform: 'darwin',
  vibrancy: false,
  setTitle: vi.fn(),
  closeWindow: vi.fn(),
  getAppearance: vi.fn(async () => 'system' as const),
  setAppearance: vi.fn(),
  saveFileDialog: vi.fn(async () => null),
  openFileDialog: vi.fn<KleosBridge['openFileDialog']>(async () => null),
  revealInFinder: vi.fn(),
  onCommand: vi.fn(() => () => {}),
} satisfies KleosBridge;

function renderScreen(favorites: SavedConnection[]) {
  mocked.listConnections.mockResolvedValue(favorites);
  return render(
    <Providers>
      <ConnectProvider>
        <ConnectionsScreen />
      </ConnectProvider>
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
  tabsStore.reset();
});

const openTabs = () => tabsStore.get().tabs;

describe('ConnectionsScreen', { timeout: 15_000 }, () => {
  it('shows the favorites', async () => {
    renderScreen([{ ...savedConnection, readOnly: true }]);
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

  it('prompts for the password when the server needs one, then opens the server in a tab', async () => {
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
      expect(openTabs()).toEqual([expect.objectContaining({ sid: 'sid-9', nickname: 'shop_dev', color: 'blue' })]),
    );
    expect(tabsStore.get().active).toBe('sid-9');
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
    expect(openTabs()).toEqual([]);
  });

  it('connects on double-click; Enter on an already open server just brings its tab back', async () => {
    const user = userEvent.setup();
    mocked.openSession.mockResolvedValue(sessionInfo);
    renderScreen([savedConnection]);
    const nav = screen.getByRole('navigation', { name: 'Saved connections' });
    const item = await within(nav).findByRole('button', { name: /shop_dev/ });
    await user.dblClick(item);
    await waitFor(() => expect(openTabs()).toHaveLength(1));
    tabsStore.activate(HOME);
    item.focus();
    await user.keyboard('{Enter}');
    expect(tabsStore.get().active).toBe(sessionInfo.sid);
    expect(openTabs()).toHaveLength(1);
    expect(mocked.openSession).toHaveBeenCalledTimes(1);
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

    await waitFor(() => expect(openTabs()).toHaveLength(1));
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

describe('ConnectionsScreen — SSH and TLS', { timeout: 15_000 }, () => {
  const fingerprint = 'SHA256:nThbg6kXUpJWGl7E1IGOCspRomTxdCARLviKw6E5SY8';
  const tunneled: SavedConnection = {
    ...savedConnection,
    hasPassword: false,
    ssh: { host: 'bastion.example.com', port: 22, user: 'deploy', auth: 'key', keyPath: '/Users/me/.ssh/id_ed25519' },
    hasSshPassphrase: false,
  };
  const sshError = (code: string, message: string, detail?: string) =>
    new ApiError(code === kleosErrorCodes.sshPassphraseRequired ? 401 : 409, { code, message, detail });

  it('asks to trust an unknown SSH host, then chains to the password prompt', async () => {
    const user = userEvent.setup();
    mocked.openSession
      .mockRejectedValueOnce(sshError(kleosErrorCodes.sshHostUnknown, 'first connection', fingerprint))
      .mockRejectedValueOnce(new ApiError(401, { code: kleosErrorCodes.passwordRequired, message: 'needs a password' }))
      .mockResolvedValueOnce({ ...sessionInfo, sid: 'sid-ssh', connection: tunneled });
    renderScreen([tunneled]);

    await user.click(await screen.findByRole('button', { name: /^Connect/ }));
    const trust = await screen.findByRole('dialog', { name: 'Trust this server?' });
    expect(trust).toHaveTextContent('bastion.example.com:22');
    expect(within(trust).getByLabelText('Host key fingerprint (SHA256)')).toHaveTextContent(fingerprint);

    await user.click(within(trust).getByRole('button', { name: 'Trust and connect' }));
    expect(mocked.openSession).toHaveBeenLastCalledWith({
      connectionId: 'c1',
      password: null,
      trustSshFingerprint: fingerprint,
    });
    const password = await screen.findByRole('dialog', { name: 'Password for shop_dev' });
    await user.type(within(password).getByLabelText('Password'), 'hunter2{Enter}');

    await waitFor(() => expect(openTabs()).toEqual([expect.objectContaining({ sid: 'sid-ssh' })]));
    expect(mocked.openSession).toHaveBeenLastCalledWith({
      connectionId: 'c1',
      password: 'hunter2',
      trustSshFingerprint: fingerprint,
    });
  });

  it('refuses a changed SSH host key unless the user deliberately replaces it', async () => {
    const user = userEvent.setup();
    mocked.openSession.mockRejectedValueOnce(sshError(kleosErrorCodes.sshHostChanged, 'key changed', fingerprint));
    renderScreen([tunneled]);

    await user.click(await screen.findByRole('button', { name: /^Connect/ }));
    const alert = await screen.findByRole('alertdialog', { name: 'The SSH host key has changed' });
    expect(alert).toHaveTextContent('Kleos won’t connect.');
    expect(within(alert).getByLabelText('New fingerprint (SHA256)')).toHaveTextContent(fingerprint);
    expect(
      within(alert)
        .getAllByRole('button')
        .map((b) => b.textContent),
    ).toEqual(['Replace the trusted key…', 'Close']);
    await user.click(within(alert).getByRole('button', { name: 'Close' }));
    await waitFor(() => expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument());
    expect(mocked.openSession).toHaveBeenCalledTimes(1);
    expect(mocked.forgetSshHost).not.toHaveBeenCalled();
    expect(openTabs()).toEqual([]);
  });

  it('replaces the trusted key after a second confirmation, then connects trusting the new one', async () => {
    const user = userEvent.setup();
    mocked.forgetSshHost.mockResolvedValue(undefined);
    mocked.openSession
      .mockRejectedValueOnce(sshError(kleosErrorCodes.sshHostChanged, 'key changed', fingerprint))
      .mockResolvedValueOnce({ ...sessionInfo, sid: 'sid-new-key', connection: tunneled });
    renderScreen([tunneled]);

    await user.click(await screen.findByRole('button', { name: /^Connect/ }));
    const alert = await screen.findByRole('alertdialog', { name: 'The SSH host key has changed' });
    await user.click(within(alert).getByRole('button', { name: 'Replace the trusted key…' }));
    expect(alert).toHaveTextContent('Only if you know why it changed');
    expect(mocked.forgetSshHost).not.toHaveBeenCalled();
    await user.click(within(alert).getByRole('button', { name: 'Trust the new key and connect' }));

    await waitFor(() => expect(openTabs()).toEqual([expect.objectContaining({ sid: 'sid-new-key' })]));
    expect(mocked.forgetSshHost).toHaveBeenCalledWith('bastion.example.com', 22);
    expect(mocked.openSession).toHaveBeenLastCalledWith(
      expect.objectContaining({ connectionId: tunneled.id, trustSshFingerprint: fingerprint }),
    );
  });

  it('asks for the key passphrase, keeps a wrong one in the dialog, and remembers it when asked', async () => {
    const user = userEvent.setup();
    const withPassword = { ...tunneled, hasPassword: true };
    mocked.openSession
      .mockRejectedValueOnce(sshError(kleosErrorCodes.sshPassphraseRequired, 'protected by a passphrase'))
      .mockRejectedValueOnce(
        new ApiError(400, { code: kleosErrorCodes.ssh, message: 'The passphrase for the SSH key is wrong' }),
      )
      .mockResolvedValueOnce({ ...sessionInfo, sid: 'sid-key', connection: withPassword });
    mocked.updateConnection.mockResolvedValue({ ...withPassword, hasSshPassphrase: true });
    renderScreen([withPassword]);

    await user.click(await screen.findByRole('button', { name: /^Connect/ }));
    const dialog = await screen.findByRole('dialog', { name: 'SSH key passphrase for shop_dev' });
    expect(dialog).toHaveTextContent('/Users/me/.ssh/id_ed25519');
    await user.type(within(dialog).getByLabelText('Passphrase'), 'wrong{Enter}');
    expect(await within(dialog).findByRole('alert')).toHaveTextContent('The passphrase for the SSH key is wrong');

    await user.clear(within(dialog).getByLabelText('Passphrase'));
    await user.type(within(dialog).getByLabelText('Passphrase'), 'open sesame');
    await user.click(within(dialog).getByRole('checkbox', { name: 'Remember in Keychain' }));
    await user.click(within(dialog).getByRole('button', { name: 'Connect' }));

    await waitFor(() => expect(openTabs()).toEqual([expect.objectContaining({ sid: 'sid-key' })]));
    expect(mocked.openSession).toHaveBeenLastCalledWith({
      connectionId: 'c1',
      password: null,
      sshPassphrase: 'open sesame',
    });
    // Only the passphrase is stored; the saved password stays as it is.
    await waitFor(() =>
      expect(mocked.updateConnection).toHaveBeenCalledWith(
        'c1',
        expect.objectContaining({
          password: null,
          savePassword: true,
          sshPassphrase: 'open sesame',
          saveSshPassphrase: true,
          ssh: tunneled.ssh,
        }),
      ),
    );
  });

  it('sets up a tunnel with a key file, trusts the host during Test and reports the route', async () => {
    const user = userEvent.setup();
    bridge.openFileDialog.mockResolvedValueOnce('/Users/me/.ssh/id_ed25519');
    mocked.testConnection
      .mockRejectedValueOnce(sshError(kleosErrorCodes.sshHostUnknown, 'first connection', fingerprint))
      .mockResolvedValueOnce({ version: 'PostgreSQL 16.4', elapsedMs: 52, tls: true });
    renderScreen([]);

    await user.type(await screen.findByLabelText('User'), 'kleos');
    await user.click(screen.getByRole('switch', { name: 'Connect through SSH' }));
    await user.click(screen.getByRole('button', { name: 'Test connection' }));
    expect(screen.getByText('SSH host is required.')).toBeInTheDocument();
    expect(mocked.testConnection).not.toHaveBeenCalled();

    await user.type(screen.getByLabelText('SSH host'), 'bastion.example.com');
    await user.type(screen.getByLabelText('SSH user'), 'deploy');
    await user.click(screen.getByRole('radio', { name: 'Key file' }));
    await user.click(screen.getByRole('button', { name: 'Choose…' }));
    expect(bridge.openFileDialog).toHaveBeenCalledWith('key');
    await waitFor(() => expect(screen.getByLabelText('Private key')).toHaveValue('/Users/me/.ssh/id_ed25519'));

    await user.click(screen.getByRole('button', { name: 'Test connection' }));
    const trust = await screen.findByRole('dialog', { name: 'Trust this server?' });
    await user.click(within(trust).getByRole('button', { name: 'Trust and connect' }));

    const status = await screen.findByRole('status');
    expect(status).toHaveTextContent('Connection works · 52 ms');
    expect(status).toHaveTextContent('Connected through SSH deploy@bastion.example.com:22, over TLS.');
    expect(mocked.testConnection).toHaveBeenLastCalledWith(
      expect.objectContaining({
        ssh: {
          host: 'bastion.example.com',
          port: 22,
          user: 'deploy',
          auth: 'key',
          keyPath: '/Users/me/.ssh/id_ed25519',
        },
        trustSshFingerprint: fingerprint,
      }),
    );
  });

  it('offers a CA certificate only when the SSL mode requires TLS, and saves it', async () => {
    const user = userEvent.setup();
    const verified = { ...savedConnection, sslMode: 'verify-full' as const };
    bridge.openFileDialog.mockResolvedValueOnce('/Users/me/certs/internal-ca.pem');
    mocked.updateConnection.mockResolvedValue({ ...verified, sslRootCertPath: '/Users/me/certs/internal-ca.pem' });
    renderScreen([verified]);

    const ca = await screen.findByLabelText('CA certificate');
    expect(ca).toHaveAttribute('placeholder', 'System certificates');
    await user.click(screen.getByRole('button', { name: 'Choose…' }));
    expect(bridge.openFileDialog).toHaveBeenCalledWith('cert');
    await waitFor(() => expect(ca).toHaveValue('/Users/me/certs/internal-ca.pem'));

    await user.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() =>
      expect(mocked.updateConnection).toHaveBeenCalledWith(
        'c1',
        expect.objectContaining({ sslMode: 'verify-full', sslRootCertPath: '/Users/me/certs/internal-ca.pem' }),
      ),
    );

    await user.click(screen.getByRole('button', { name: 'Clear CA certificate' }));
    expect(ca).toHaveValue('');
  });

  it('has no CA certificate field when SSL is only preferred', async () => {
    renderScreen([savedConnection]);
    await screen.findByLabelText('Host');
    expect(screen.queryByLabelText('CA certificate')).not.toBeInTheDocument();
  });
});
