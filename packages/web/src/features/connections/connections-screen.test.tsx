import { defaultSettings } from '@kleos/shared';
import { idleUpdateState } from '@/test/bridge-defaults';
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
  writeFile: vi.fn(async () => {}),
  appVersion: '0.5.0',
  windowKind: 'main' as const,
  getSettings: vi.fn(async () => defaultSettings),
  updateSettings: vi.fn(async () => defaultSettings),
  onSettingsChanged: vi.fn(() => () => {}),
  openSettings: vi.fn(),
  getUpdateState: vi.fn(async () => idleUpdateState),
  checkForUpdates: vi.fn(async () => idleUpdateState),
  onUpdateState: vi.fn(() => () => {}),
  openReleasePage: vi.fn(),
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
    expect(mocked.openSession).toHaveBeenLastCalledWith({
      connectionId: 'c1',
      password: null,
      statementTimeoutSeconds: 0,
    });

    await user.type(within(dialog).getByLabelText('Password'), 'hunter2');
    await user.click(within(dialog).getByRole('button', { name: 'Connect' }));

    await waitFor(() =>
      expect(openTabs()).toEqual([expect.objectContaining({ sid: 'sid-9', nickname: 'shop_dev', color: 'blue' })]),
    );
    expect(tabsStore.get().active).toBe('sid-9');
    expect(mocked.openSession).toHaveBeenLastCalledWith({
      connectionId: 'c1',
      password: 'hunter2',
      statementTimeoutSeconds: 0,
    });
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

  it('opens the session with the query timeout Settings holds (0.5)', async () => {
    const user = userEvent.setup();
    bridge.getSettings.mockResolvedValueOnce({ ...defaultSettings, queryTimeoutSeconds: 300 });
    mocked.openSession.mockResolvedValue(sessionInfo);
    renderScreen([savedConnection]);
    const nav = screen.getByRole('navigation', { name: 'Saved connections' });
    await user.dblClick(await within(nav).findByRole('button', { name: /shop_dev/ }));
    await waitFor(() => expect(openTabs()).toHaveLength(1));
    expect(mocked.openSession).toHaveBeenCalledWith({
      connectionId: 'c1',
      password: null,
      statementTimeoutSeconds: 300,
    });
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
    expect(mocked.openSession).toHaveBeenCalledWith({
      connectionId: 'new-1',
      password: 'pw',
      statementTimeoutSeconds: 0,
    });
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
      statementTimeoutSeconds: 0,
    });
    const password = await screen.findByRole('dialog', { name: 'Password for shop_dev' });
    await user.type(within(password).getByLabelText('Password'), 'hunter2{Enter}');

    await waitFor(() => expect(openTabs()).toEqual([expect.objectContaining({ sid: 'sid-ssh' })]));
    expect(mocked.openSession).toHaveBeenLastCalledWith({
      connectionId: 'c1',
      password: 'hunter2',
      trustSshFingerprint: fingerprint,
      statementTimeoutSeconds: 0,
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
      statementTimeoutSeconds: 0,
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

describe('ConnectionsScreen — another server typed over a favorite (0.7.2)', { timeout: 15_000 }, () => {
  /** The form's state badge (the favorites list has a New button and a Saved heading too). */
  const badge = (text: string) =>
    within(screen.getByRole('form', { name: 'Connection' })).getByText(text, { exact: true });

  async function formFor(favorites: SavedConnection[] = [savedConnection]) {
    renderScreen(favorites);
    const database = await screen.findByLabelText('Database');
    await waitFor(() => expect(database).toHaveValue('shop_dev'));
    return database;
  }

  it('connects to another database as a new favorite and keeps the one it started from', async () => {
    const user = userEvent.setup();
    const created = { ...savedConnection, id: 'c2', nickname: 'billing on localhost', database: 'billing' };
    mocked.createConnection.mockResolvedValue(created);
    mocked.openSession.mockResolvedValue({ ...sessionInfo, sid: 's2', connection: created });
    const database = await formFor();

    await user.clear(database);
    await user.type(database, 'billing');
    expect(badge('New')).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'billing on localhost' })).toBeInTheDocument();
    expect(screen.getByText(/stays as it is/)).toBeInTheDocument();
    // Same server: the new favorite will reuse the stored password, and says so.
    expect(screen.getByLabelText('Password')).toHaveAttribute('placeholder', 'Same as shop_dev');
    expect(screen.getByRole('button', { name: 'Save as new' })).toBeEnabled();
    await user.click(screen.getByRole('button', { name: /Connect as new/ }));

    await waitFor(() => expect(openTabs()).toHaveLength(1));
    expect(mocked.updateConnection).not.toHaveBeenCalled();
    expect(mocked.createConnection).toHaveBeenCalledWith(
      expect.objectContaining({
        nickname: 'billing on localhost',
        database: 'billing',
        host: 'localhost',
        copySecretsFrom: 'c1',
      }),
    );
    expect(mocked.openSession).toHaveBeenCalledWith(expect.objectContaining({ connectionId: 'c2' }));
  });

  it('treats a new host, port or user the same way, and keeps a name the user typed', async () => {
    const user = userEvent.setup();
    mocked.createConnection.mockImplementation(async (input) => ({ ...savedConnection, ...input, id: 'c9' }));
    await formFor([savedConnection, { ...savedConnection, id: 'c3', nickname: 'shop_dev on db.example.com' }]);

    const host = screen.getByLabelText('Host');
    await user.clear(host);
    await user.type(host, 'db.example.com');
    // Another host: no stored password is offered to it.
    expect(screen.getByLabelText('Password')).toHaveAttribute('placeholder', '');
    // The generated name is never one another favorite already has.
    expect(screen.getByRole('heading', { name: 'shop_dev on db.example.com 2' })).toBeInTheDocument();

    const nickname = screen.getByLabelText('Nickname');
    await user.clear(nickname);
    await user.type(nickname, 'Prod replica');
    await user.click(screen.getByRole('button', { name: 'Save as new' }));
    await waitFor(() => expect(mocked.createConnection).toHaveBeenCalledTimes(1));
    expect(mocked.createConnection).toHaveBeenCalledWith(
      expect.objectContaining({ nickname: 'Prod replica', host: 'db.example.com' }),
    );
    expect(mocked.updateConnection).not.toHaveBeenCalled();
  });

  it('still updates the favorite for its own settings: nickname, color, read-only', async () => {
    const user = userEvent.setup();
    mocked.updateConnection.mockImplementation(async (_id, input) => ({ ...savedConnection, ...input }));
    await formFor();
    const nickname = screen.getByLabelText('Nickname');
    await user.clear(nickname);
    await user.type(nickname, 'Shop');
    await user.click(screen.getByRole('switch', { name: /Read-only/ }));
    expect(badge('Edited')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Connect as new/ })).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(mocked.updateConnection).toHaveBeenCalledTimes(1));
    expect(mocked.updateConnection).toHaveBeenCalledWith(
      'c1',
      expect.objectContaining({ nickname: 'Shop', readOnly: true }),
    );
    expect(mocked.createConnection).not.toHaveBeenCalled();
  });

  it('"Update … instead" rewrites the favorite on purpose', async () => {
    const user = userEvent.setup();
    mocked.updateConnection.mockImplementation(async (_id, input) => ({ ...savedConnection, ...input }));
    const database = await formFor();
    await user.clear(database);
    await user.type(database, 'billing');
    await user.click(screen.getByRole('button', { name: 'Update shop_dev instead' }));
    await waitFor(() => expect(mocked.updateConnection).toHaveBeenCalledTimes(1));
    expect(mocked.updateConnection).toHaveBeenCalledWith('c1', expect.objectContaining({ database: 'billing' }));
    expect(mocked.createConnection).not.toHaveBeenCalled();
    // Updated: the form is that favorite again, saved.
    await waitFor(() => expect(badge('Saved')).toBeInTheDocument());
  });

  it('asks before updating a favorite that is open in a tab', async () => {
    const user = userEvent.setup();
    mocked.updateConnection.mockImplementation(async (_id, input) => ({ ...savedConnection, ...input }));
    tabsStore.open(sessionInfo);
    tabsStore.activate(HOME);
    const database = await formFor();
    await user.clear(database);
    await user.type(database, 'billing');
    await user.click(screen.getByRole('button', { name: 'Update shop_dev instead' }));

    const dialog = await screen.findByRole('alertdialog', { name: 'Update shop_dev?' });
    expect(dialog).toHaveTextContent('kleos@localhost:5432/shop_dev');
    expect(dialog).toHaveTextContent('kleos@localhost:5432/billing');
    await user.click(within(dialog).getByRole('button', { name: 'Keep it' }));
    expect(mocked.updateConnection).not.toHaveBeenCalled();

    await user.click(screen.getByRole('button', { name: 'Update shop_dev instead' }));
    await user.click(
      within(await screen.findByRole('alertdialog', { name: 'Update shop_dev?' })).getByRole('button', {
        name: 'Update',
      }),
    );
    await waitFor(() => expect(mocked.updateConnection).toHaveBeenCalledTimes(1));
  });

  it('tests a new host without the stored password, the same server with it', async () => {
    const user = userEvent.setup();
    mocked.testConnection.mockResolvedValue({ version: 'PostgreSQL 17.2', elapsedMs: 12, tls: false });
    const database = await formFor();
    await user.clear(database);
    await user.type(database, 'billing');
    await user.click(screen.getByRole('button', { name: /Test connection/ }));
    await waitFor(() =>
      expect(mocked.testConnection).toHaveBeenLastCalledWith(expect.objectContaining({ connectionId: 'c1' })),
    );

    const host = screen.getByLabelText('Host');
    await user.clear(host);
    await user.type(host, 'db.example.com');
    await user.click(screen.getByRole('button', { name: /Test connection/ }));
    await waitFor(() => expect(mocked.testConnection).toHaveBeenCalledTimes(2));
    expect(mocked.testConnection.mock.calls[1]?.[0]).not.toHaveProperty('connectionId');
  });

  it('Duplicate starts a new favorite from this one, reusing its password on the same server', async () => {
    const user = userEvent.setup();
    const created = { ...savedConnection, id: 'c2', nickname: 'shop_dev copy' };
    mocked.createConnection.mockResolvedValue(created);
    await formFor();
    await user.click(screen.getByRole('button', { name: 'Duplicate' }));

    await waitFor(() => expect(screen.getByLabelText('Nickname')).toHaveValue('shop_dev copy'));
    expect(screen.getByText(/A copy of shop_dev/)).toBeInTheDocument();
    expect(badge('New')).toBeInTheDocument();
    expect(screen.getByLabelText('Password')).toHaveAttribute('placeholder', 'Same as shop_dev');
    await user.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(mocked.createConnection).toHaveBeenCalledTimes(1));
    expect(mocked.createConnection).toHaveBeenCalledWith(
      expect.objectContaining({ nickname: 'shop_dev copy', database: 'shop_dev', copySecretsFrom: 'c1' }),
    );
  });
});
