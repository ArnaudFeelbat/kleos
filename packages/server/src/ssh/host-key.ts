import { createHash } from 'node:crypto';
import { kleosErrorCodes } from '@kleos/shared';
import { KleosError } from '../errors';
import type { AppStore } from '../store/types';

/** Trusted SSH host keys (trust on first use), kept in app.db. */
export type KnownHosts = Pick<AppStore, 'getKnownHost' | 'trustKnownHost'>;

/**
 * OpenSSH's fingerprint of a public key blob, as `ssh-keygen -lf` and the ssh prompt print it:
 * "SHA256:" + base64 of the SHA-256 digest, without padding.
 */
export function sshFingerprint(key: Buffer): string {
  return `SHA256:${createHash('sha256').update(key).digest('base64').replace(/=+$/, '')}`;
}

/**
 * Decides whether the host key presented by host:port may be used. Returns null to accept, or
 * the error to report:
 * - a known host whose key matches is accepted;
 * - a known host whose key differs is refused with KLEOS_SSH_HOST_CHANGED, whatever was sent as
 *   trusted: the stored key is never replaced from here;
 * - an unknown host is accepted and remembered only when `trust` is exactly its fingerprint
 *   (the user confirmed it after a first KLEOS_SSH_HOST_UNKNOWN), refused otherwise.
 * Both errors carry the presented fingerprint in `detail`.
 */
export function checkHostKey(
  knownHosts: KnownHosts,
  host: string,
  port: number,
  fingerprint: string,
  trust: string | undefined,
): KleosError | null {
  const stored = knownHosts.getKnownHost(host, port);
  if (stored !== null) {
    if (stored === fingerprint) return null;
    return new KleosError(409, {
      code: kleosErrorCodes.sshHostChanged,
      message:
        `The SSH host key of ${host}:${port} has changed since you trusted it. ` +
        'Kleos will not connect: this can mean someone is intercepting the connection.',
      detail: fingerprint,
      hint: `Trusted key: ${stored}`,
    });
  }
  if (trust !== undefined && trust === fingerprint) {
    knownHosts.trustKnownHost(host, port, fingerprint);
    return null;
  }
  return new KleosError(409, {
    code: kleosErrorCodes.sshHostUnknown,
    message: `Kleos has not connected to the SSH host ${host}:${port} before. Check its key fingerprint before trusting it.`,
    detail: fingerprint,
  });
}
