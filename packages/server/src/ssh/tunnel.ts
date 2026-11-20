import { type AddressInfo, type Server, type Socket, createServer } from 'node:net';
// ssh2 is CommonJS and stays external to the Electron main bundle: Node's ESM loader only
// exposes its default export there, so destructure instead of importing names.
import ssh2, { type Client as SshClient, type ClientChannel, type ConnectConfig } from 'ssh2';
import { type SshConfig, kleosErrorCodes } from '@kleos/shared';
import { KleosError, isPgError } from '../errors';
import { resolveSshCredentials, sshError } from './auth';
import { type KnownHosts, checkHostKey, sshFingerprint } from './host-key';

const { Client } = ssh2;

/** Same budget as a direct Postgres connect. */
const READY_TIMEOUT_MS = 15_000;
/** A bastion that stops answering is declared gone after about 30 s, instead of hanging queries. */
const KEEPALIVE_INTERVAL_MS = 10_000;
const KEEPALIVE_COUNT_MAX = 3;

export type TunnelOptions = {
  ssh: SshConfig;
  /** The database as seen from the SSH host: the favorite's own host and port. */
  target: { host: string; port: number };
  /** Key passphrase (from the request or the Keychain), if any. */
  passphrase: string | null;
  /** Fingerprint the user accepted after KLEOS_SSH_HOST_UNKNOWN. */
  trustFingerprint?: string;
  knownHosts: KnownHosts;
  /** ssh-agent socket; defaults to SSH_AUTH_SOCK. */
  agentSocket?: string;
};

/**
 * An open SSH connection plus a local forwarder: every TCP connection accepted on
 * 127.0.0.1:localPort is carried to target through its own SSH channel, so node-postgres (and
 * TLS on top of it) works unchanged, only pointed at the local port.
 */
export type SshTunnel = {
  readonly localPort: number;
  /** Set once the SSH connection is gone; every later connection through the tunnel fails at once. */
  readonly lost: KleosError | null;
  /**
   * Replaces a driver error caused by the tunnel (SSH connection lost, or the SSH host unable
   * to reach the database) with one that says so. Any other error is returned unchanged.
   * A forwarded channel can close (and the driver fail) a moment before ssh2 reports the SSH
   * connection gone, so a non-Postgres error waits briefly for that verdict.
   */
  explain(err: unknown): Promise<unknown>;
  /** Stops the forwarder and ends the SSH connection. Idempotent; never throws. */
  close(): Promise<void>;
};

const where = (ssh: SshConfig) => `${ssh.host}:${ssh.port}`;

/** How long explain() waits for ssh2 to report a lost connection after a driver error. */
const LOSS_GRACE_MS = 1000;
/**
 * If ssh2 still hasn't reported anything, explain() opens a test channel: a live SSH connection
 * answers in milliseconds, a dead one never does (or errors at once).
 */
const PROBE_TIMEOUT_MS = 3000;

/** ssh2's errors, as the person setting up the favorite needs to read them. */
function sshFailure(err: Error & { level?: string; code?: unknown }, ssh: SshConfig): KleosError {
  if (err.level === 'client-authentication') {
    const how =
      ssh.auth === 'agent'
        ? 'none of the keys in the SSH agent was accepted'
        : `the key ${ssh.keyPath} was not accepted`;
    return sshError(`SSH authentication failed for ${ssh.user}@${where(ssh)}: ${how}`, err.message);
  }
  if (err.level === 'client-timeout') return sshError(`Timed out connecting to the SSH host ${where(ssh)}`);
  if (err.level === 'agent') return sshError(`The SSH agent could not be used: ${err.message}`);
  if (typeof err.code === 'string') {
    return sshError(`Could not connect to the SSH host ${where(ssh)}: ${err.message}`, err.code);
  }
  return sshError(`The SSH connection to ${where(ssh)} failed: ${err.message}`);
}

/** Connects and authenticates; resolves once the SSH session is ready. */
function connectSsh(options: TunnelOptions, credentials: ConnectConfig): Promise<SshClient> {
  const { ssh } = options;
  return new Promise((resolve, reject) => {
    const client = new Client();
    // Set by the host key check, reported in place of ssh2's generic "verification failed".
    let hostKeyProblem: KleosError | null = null;
    let settled = false;
    const fail = (err: KleosError) => {
      if (settled) return;
      settled = true;
      client.end();
      reject(err);
    };
    // Stays attached for the life of the client: an 'error' without a listener would crash the app.
    client.on('error', (err) => fail(hostKeyProblem ?? sshFailure(err, ssh)));
    client.on('close', () => fail(hostKeyProblem ?? sshError(`The SSH host ${where(ssh)} closed the connection`)));
    client.once('ready', () => {
      settled = true;
      resolve(client);
    });
    client.connect({
      ...credentials,
      host: ssh.host,
      port: ssh.port,
      username: ssh.user,
      hostVerifier: (key: Buffer): boolean => {
        hostKeyProblem = checkHostKey(
          options.knownHosts,
          ssh.host,
          ssh.port,
          sshFingerprint(key),
          options.trustFingerprint,
        );
        return hostKeyProblem === null;
      },
      readyTimeout: READY_TIMEOUT_MS,
      keepaliveInterval: KEEPALIVE_INTERVAL_MS,
      keepaliveCountMax: KEEPALIVE_COUNT_MAX,
    });
  });
}

function listen(server: Server): Promise<number> {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.removeListener('error', reject);
      resolve((server.address() as AddressInfo).port);
    });
  });
}

/**
 * Opens the SSH connection, checking the host key against the trusted ones, then a forwarder on
 * a free local port. Problems are reported in the order the user can fix them: credentials
 * (agent, key file, passphrase) first, then the host key, then authentication.
 */
export async function openTunnel(options: TunnelOptions): Promise<SshTunnel> {
  const { ssh, target } = options;
  const credentials = await resolveSshCredentials(
    ssh,
    options.passphrase,
    options.agentSocket ?? process.env.SSH_AUTH_SOCK,
  );
  const client = await connectSsh(options, credentials);

  const sockets = new Set<Socket>();
  let lost: KleosError | null = null;
  let closing: Promise<void> | null = null;
  let signalLost: () => void = () => undefined;
  const lostSignal = new Promise<void>((resolve) => (signalLost = resolve));
  // The last channel the SSH host refused to open (database unreachable from there), until one opens.
  let forwardError: Error | null = null;

  const server = createServer((socket) => {
    socket.on('error', () => undefined);
    if (lost || closing) {
      socket.destroy();
      return;
    }
    sockets.add(socket);
    socket.once('close', () => sockets.delete(socket));
    client.forwardOut('127.0.0.1', socket.remotePort ?? 0, target.host, target.port, (err, channel: ClientChannel) => {
      if (err) {
        forwardError = err;
        socket.destroy();
        return;
      }
      forwardError = null;
      if (socket.destroyed) {
        channel.close();
        return;
      }
      channel.on('error', () => socket.destroy());
      channel.once('close', () => socket.destroy());
      socket.once('close', () => channel.close());
      socket.pipe(channel).pipe(socket);
    });
  });
  server.on('error', () => undefined);

  const onLost = (reason?: Error) => {
    if (lost || closing) return;
    lost = new KleosError(502, {
      code: kleosErrorCodes.connection,
      message: `The SSH tunnel through ${where(ssh)} closed`,
      ...(reason?.message ? { detail: reason.message } : {}),
    });
    // Open connections fail now rather than wait on a channel that will never answer.
    for (const socket of sockets) socket.destroy();
    signalLost();
  };
  client.on('error', onLost);
  client.on('end', () => onLost());
  client.on('close', () => onLost());

  /** True when the SSH connection still opens a channel to the database within the timeout. */
  const probe = () =>
    new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => resolve(false), PROBE_TIMEOUT_MS);
      const done = (alive: boolean) => {
        clearTimeout(timer);
        resolve(alive);
      };
      try {
        client.forwardOut('127.0.0.1', 0, target.host, target.port, (err, channel: ClientChannel) => {
          if (err) {
            // ssh2 fails pending channels with this when the connection dies under them;
            // any other refusal came from the SSH host, so the connection itself is alive.
            done(err.message !== 'No response from server');
            return;
          }
          channel.on('error', () => undefined);
          channel.close();
          done(true);
        });
      } catch {
        done(false);
      }
    });

  let localPort: number;
  try {
    localPort = await listen(server);
  } catch (err) {
    client.end();
    throw err;
  }

  return {
    localPort,
    get lost() {
      return lost;
    },
    async explain(err) {
      if (isPgError(err)) return err;
      if (err instanceof KleosError && err.body.code !== kleosErrorCodes.connection) return err;
      if (!lost && !forwardError && !closing) {
        let timer: NodeJS.Timeout | undefined;
        await Promise.race([lostSignal, new Promise((resolve) => (timer = setTimeout(resolve, LOSS_GRACE_MS)))]);
        clearTimeout(timer);
        // ssh2 may report a dead connection late (or, behind some proxies, only on the next
        // write): ask it directly before passing the driver's raw error on.
        if (!lost && !closing && !(await probe())) onLost(new Error('The SSH connection stopped answering'));
      }
      if (lost) return lost;
      if (forwardError) {
        return new KleosError(502, {
          code: kleosErrorCodes.connection,
          message: `The SSH host ${where(ssh)} could not reach ${target.host}:${target.port}`,
          detail: forwardError.message,
        });
      }
      return err;
    },
    close() {
      closing ??= (async () => {
        for (const socket of sockets) socket.destroy();
        await new Promise<void>((resolve) => server.close(() => resolve()));
        client.end();
      })();
      return closing;
    },
  };
}
