import { type ChildProcess, execFileSync, spawn } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { connect } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { utils } from 'ssh2';
import type { StartedNetwork, StartedTestContainer } from 'testcontainers';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { ConnectionConfig, SshConfig } from '@kleos/shared';
import { createPostgresAdapter } from '../../src/adapter/postgres';
import type { ConnectOptions } from '../../src/adapter/types';
import type { KleosError } from '../../src/errors';
import { openTunnel } from '../../src/ssh/tunnel';
import { createSqliteStore } from '../../src/store/sqlite';
import type { AppStore } from '../../src/store/types';
import { type TestDatabase, rejectionOf, startPostgres, waitUntil } from '../helpers/postgres';

/**
 * SSH tunnels against a real OpenSSH server (testcontainers' own sshd image) that shares a
 * Docker network with Postgres: the database is reachable as db:5432 from the SSH host only.
 */
const SSHD_IMAGE = 'testcontainers/sshd:1.4.0';
const PASSPHRASE = 'correct horse';

const adapter = createPostgresAdapter();
const dir = mkdtempSync(join(tmpdir(), 'kleos-ssh-'));
let network: StartedNetwork | undefined;
let sshd: StartedTestContainer | undefined;
let db: TestDatabase;
let store: AppStore;
let fingerprint: string;

function writeKey(name: string, passphrase?: string): { path: string; publicKey: string } {
  const pair = passphrase
    ? utils.generateKeyPairSync('ed25519', { passphrase, cipher: 'aes256-ctr', rounds: 4 })
    : utils.generateKeyPairSync('ed25519');
  const path = join(dir, name);
  // ssh-add refuses a key readable by others.
  writeFileSync(path, pair.private, { mode: 0o600 });
  return { path, publicKey: pair.public };
}

const plainKey = writeKey('id_plain');
const encryptedKey = writeKey('id_encrypted', PASSPHRASE);
const strangerKey = writeKey('id_stranger');

function sshConfig(overrides: Partial<SshConfig> = {}): SshConfig {
  return {
    host: sshd!.getHost(),
    port: sshd!.getMappedPort(22),
    user: 'root',
    auth: 'key',
    keyPath: plainKey.path,
    ...overrides,
  };
}

/** The favorite: Postgres as the SSH host sees it, behind the tunnel. */
function tunneled(ssh: Partial<SshConfig> = {}, overrides: Partial<ConnectionConfig> = {}): ConnectionConfig {
  return { ...db.config, host: 'db', port: 5432, ssh: sshConfig(ssh), ...overrides };
}

const options = (extra: Partial<ConnectOptions> = {}): ConnectOptions => ({ knownHosts: store, ...extra });
const sshdSessions = async () => {
  // [s] keeps the pattern from matching this very sh -c command line.
  const { output } = await sshd!.exec(['sh', '-c', 'pgrep -f "[s]shd-session" | wc -l']);
  return Number.parseInt(output.trim(), 10);
};

beforeAll(async () => {
  db = await startPostgres({
    seeds: ['shop.sql'],
    customize: async (builder) => {
      const { Network } = await import('testcontainers');
      network = await new Network().start();
      return builder.withNetwork(network).withNetworkAliases('db');
    },
  });
  const { GenericContainer, Wait } = await import('testcontainers');
  sshd = await new GenericContainer(SSHD_IMAGE)
    .withNetwork(network!)
    .withExposedPorts(22)
    .withEnvironment({ AUTHORIZED_KEYS: `${plainKey.publicKey}\n${encryptedKey.publicKey}` })
    // The image's entrypoint is `sh -c`; key auth only, forwarding on, logs on stderr for the wait.
    .withCommand([
      [
        'ssh-keygen -A',
        'mkdir -p /root/.ssh',
        'printf "%s\\n" "$AUTHORIZED_KEYS" > /root/.ssh/authorized_keys',
        'chmod 700 /root/.ssh',
        'chmod 600 /root/.ssh/authorized_keys',
        // A locked account (no password) is refused even with a valid key.
        'echo root:root | chpasswd',
        'exec /usr/sbin/sshd -D -e -o PermitRootLogin=yes -o AllowTcpForwarding=yes -o PasswordAuthentication=no',
      ].join(' && '),
    ])
    .withWaitStrategy(Wait.forLogMessage(/Server listening on/))
    .withStartupTimeout(120_000)
    .start();
  const { output } = await sshd.exec(['ssh-keygen', '-lf', '/etc/ssh/ssh_host_ed25519_key.pub']);
  fingerprint = output.split(' ')[1]!;
}, 240_000);

afterAll(async () => {
  store?.close();
  await sshd?.stop({ timeout: 1000 });
  await db?.stop();
  await network?.stop();
  rmSync(dir, { recursive: true, force: true });
});

// Each test starts with no trusted host key unless it trusts one itself.
function freshStore(): AppStore {
  store?.close();
  store = createSqliteStore(':memory:');
  return store;
}

const asKleos = (err: unknown) => err as KleosError;

describe('trust on first use', () => {
  it('refuses an unknown SSH host with its fingerprint, then connects once that fingerprint is trusted', async () => {
    freshStore();
    const ssh = sshConfig();
    const first = asKleos(await rejectionOf(adapter.test(tunneled(), db.password, options())));
    expect(first.status).toBe(409);
    expect(first.body.code).toBe('KLEOS_SSH_HOST_UNKNOWN');
    // The same fingerprint ssh-keygen prints on the server for its ed25519 host key.
    expect(first.body.detail).toBe(fingerprint);
    expect(first.message).toContain(`${ssh.host}:${ssh.port}`);
    expect(store.getKnownHost(ssh.host, ssh.port)).toBeNull();

    const trusted = await adapter.test(tunneled(), db.password, options({ trustSshFingerprint: fingerprint }));
    expect(trusted.version).toMatch(/^PostgreSQL 17\./);
    expect(trusted.tls).toBe(false);
    expect(store.getKnownHost(ssh.host, ssh.port)).toBe(fingerprint);

    // Known from now on: no fingerprint needed.
    expect((await adapter.test(tunneled(), db.password, options())).version).toMatch(/^PostgreSQL/);
  });

  it('refuses a host whose key changed, even when told to trust the new key, and keeps the old one', async () => {
    freshStore();
    const ssh = sshConfig();
    store.trustKnownHost(ssh.host, ssh.port, 'SHA256:somethingElseEntirely');
    for (const trust of [undefined, fingerprint]) {
      const err = asKleos(
        await rejectionOf(adapter.connect(tunneled(), db.password, options({ trustSshFingerprint: trust }))),
      );
      expect(err.status).toBe(409);
      expect(err.body.code).toBe('KLEOS_SSH_HOST_CHANGED');
      expect(err.body.detail).toBe(fingerprint);
    }
    expect(store.getKnownHost(ssh.host, ssh.port)).toBe('SHA256:somethingElseEntirely');
  });
});

describe('a session through the tunnel', () => {
  it('opens a session with key auth, runs queries on the pool and on tab clients, and closes the tunnel', async () => {
    freshStore();
    const before = await sshdSessions();
    const session = await adapter.connect(tunneled(), db.password, options({ trustSshFingerprint: fingerprint }));
    try {
      expect(session.serverVersion).toMatch(/^PostgreSQL 17\./);
      const rows = await session.fetchRows({
        table: { schema: 'shop', name: 'customers' },
        limit: 10,
        offset: 0,
        sort: [],
        filters: [],
      });
      expect(rows.rows).toHaveLength(3);
      const started = await session.runQuery(`select inet_server_addr() is not null as tcp, current_user`, {
        qid: 'q1',
        tabId: 'tab',
        pageSize: 10,
      });
      expect(started.rows).toEqual([['t', db.config.user]]);
      expect(await sshdSessions()).toBeGreaterThan(before);
    } finally {
      await session.close();
    }
    await waitUntil(async () => (await sshdSessions()) === before);
  });

  it('reports a dropped SSH connection as a connection error on the next query, without hanging', async () => {
    freshStore();
    const session = await adapter.connect(tunneled(), db.password, options({ trustSshFingerprint: fingerprint }));
    try {
      await session.runQuery('select 1', { qid: 'a', tabId: 'kept', pageSize: 10 });
      await sshd!.exec(['pkill', '-f', '[s]shd-session']);
      // The tab client and the pool both lost their sockets with the tunnel.
      for (const attempt of [
        () => session.runQuery('select 1', { qid: 'b', tabId: 'kept', pageSize: 10 }),
        () => session.runQuery('select 1', { qid: 'c', tabId: 'new tab', pageSize: 10 }),
        () => session.introspect(),
      ]) {
        const started = Date.now();
        const err = asKleos(await rejectionOf(attempt()));
        expect(Date.now() - started).toBeLessThan(5000);
        expect(err.status).toBe(502);
        expect(err.body.code).toBe('KLEOS_CONNECTION');
        expect(err.message).toMatch(/^The SSH tunnel through .+ closed$/);
      }
    } finally {
      await session.close();
    }
  });

  it('says when the SSH host cannot reach the database', async () => {
    freshStore();
    const err = asKleos(
      await rejectionOf(
        adapter.test(tunneled({}, { port: 1 }), db.password, options({ trustSshFingerprint: fingerprint })),
      ),
    );
    expect(err.body.code).toBe('KLEOS_CONNECTION');
    expect(err.message).toBe(`The SSH host ${sshConfig().host}:${sshConfig().port} could not reach db:1`);
  });

  it('closes the local forwarder with the tunnel', async () => {
    freshStore();
    store.trustKnownHost(sshConfig().host, sshConfig().port, fingerprint);
    const tunnel = await openTunnel({
      ssh: sshConfig(),
      target: { host: 'db', port: 5432 },
      passphrase: null,
      knownHosts: store,
    });
    await tunnel.close();
    const refused = await new Promise<string>((resolve) => {
      const socket = connect(tunnel.localPort, '127.0.0.1');
      socket.once('connect', () => resolve('connected'));
      socket.once('error', (err: NodeJS.ErrnoException) => resolve(err.code ?? 'error'));
    });
    expect(refused).toBe('ECONNREFUSED');
  });
});

describe('SSH authentication', () => {
  it('asks for the passphrase of an encrypted key before anything else', async () => {
    freshStore();
    // No password either: the SSH prompt comes first.
    const err = asKleos(await rejectionOf(adapter.connect(tunneled({ keyPath: encryptedKey.path }), null, options())));
    expect(err.status).toBe(401);
    expect(err.body.code).toBe('KLEOS_SSH_PASSPHRASE_REQUIRED');
  });

  it('says a wrong passphrase is wrong, and connects with the right one', async () => {
    freshStore();
    const wrong = asKleos(
      await rejectionOf(
        adapter.test(tunneled({ keyPath: encryptedKey.path }), db.password, options({ sshPassphrase: 'nope' })),
      ),
    );
    expect(wrong.body.code).toBe('KLEOS_SSH');
    expect(wrong.message).toMatch(/passphrase .* is wrong/);

    // Failed once under load, never alone: keep the server's own error if it does again.
    const ok = await adapter
      .test(
        tunneled({ keyPath: encryptedKey.path }),
        db.password,
        options({ sshPassphrase: PASSPHRASE, trustSshFingerprint: fingerprint }),
      )
      .catch((err: unknown) => {
        const body = (err as { body?: unknown }).body ?? String(err);
        throw new Error(`unexpected failure: ${JSON.stringify(body)}`);
      });
    expect(ok.version).toMatch(/^PostgreSQL/);
  });

  it('reports a key the server does not accept as KLEOS_SSH', async () => {
    freshStore();
    const err = asKleos(
      await rejectionOf(
        adapter.test(
          tunneled({ keyPath: strangerKey.path }),
          db.password,
          options({ trustSshFingerprint: fingerprint }),
        ),
      ),
    );
    expect(err.status).toBe(502);
    expect(err.body.code).toBe('KLEOS_SSH');
    expect(err.message).toBe(
      `SSH authentication failed for root@${sshConfig().host}:${sshConfig().port}: the key ${strangerKey.path} was not accepted`,
    );
  });

  it('reports an unreachable SSH host as KLEOS_SSH', async () => {
    freshStore();
    const err = asKleos(
      await rejectionOf(adapter.test(tunneled({ host: '127.0.0.1', port: 1 }), db.password, options())),
    );
    expect(err.body.code).toBe('KLEOS_SSH');
    expect(err.body.detail).toBe('ECONNREFUSED');
  });

  describe('with ssh-agent', () => {
    let agent: ChildProcess | undefined;
    let socket = '';
    const savedSock = process.env.SSH_AUTH_SOCK;
    let hasAgent = true;
    try {
      execFileSync('ssh-agent', ['-h'], { stdio: 'ignore' });
    } catch (err) {
      // ssh-agent -h exits non-zero but exists; ENOENT means it is not installed.
      hasAgent = (err as NodeJS.ErrnoException).code !== 'ENOENT';
    }

    beforeAll(async () => {
      if (!hasAgent) return;
      socket = join(dir, 'agent.sock');
      agent = spawn('ssh-agent', ['-D', '-a', socket], { stdio: 'ignore' });
      await waitUntil(async () => {
        try {
          execFileSync('ssh-add', ['-l'], { env: { ...process.env, SSH_AUTH_SOCK: socket }, stdio: 'ignore' });
          return true;
        } catch (err) {
          // Exit status 1: the agent answers and holds no key yet.
          return (err as { status?: number }).status === 1;
        }
      });
      execFileSync('ssh-add', [plainKey.path], { env: { ...process.env, SSH_AUTH_SOCK: socket }, stdio: 'ignore' });
    });

    afterAll(() => {
      agent?.kill();
      if (savedSock === undefined) delete process.env.SSH_AUTH_SOCK;
      else process.env.SSH_AUTH_SOCK = savedSock;
    });

    it.skipIf(!hasAgent)('authenticates with a key held by the agent (SSH_AUTH_SOCK)', async () => {
      freshStore();
      process.env.SSH_AUTH_SOCK = socket;
      const ok = await adapter.test(
        tunneled({ auth: 'agent', keyPath: null }),
        db.password,
        options({ trustSshFingerprint: fingerprint }),
      );
      expect(ok.version).toMatch(/^PostgreSQL/);
    });

    it('needs an agent for agent auth', async () => {
      freshStore();
      delete process.env.SSH_AUTH_SOCK;
      const err = asKleos(
        await rejectionOf(adapter.test(tunneled({ auth: 'agent', keyPath: null }), db.password, options())),
      );
      expect(err.body.code).toBe('KLEOS_SSH');
      expect(err.message).toMatch(/No SSH agent/);
    });
  });
});
