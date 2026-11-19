import { type SshConfig, kleosErrorCodes } from '@kleos/shared';
import { utils } from 'ssh2';
import { KleosError } from '../errors';
import { readUserFile } from '../user-files';

/** The part of ssh2's ConnectConfig that authenticates. */
export type SshCredentials = { agent: string } | { privateKey: Buffer; passphrase?: string };

/** Every KLEOS_SSH is a 502, like KLEOS_CONNECTION: the way to the database failed. */
export function sshError(message: string, detail?: string): KleosError {
  return new KleosError(502, { code: kleosErrorCodes.ssh, message, ...(detail ? { detail } : {}) });
}

/**
 * Resolves how the tunnel authenticates, before any network traffic, so a missing agent, an
 * unreadable key file or a missing or wrong passphrase is reported as such instead of as a
 * generic "authentication failed":
 * - agent: the ssh-agent socket (SSH_AUTH_SOCK), KLEOS_SSH when there is none;
 * - key: the file at keyPath (a leading ~ expanded), KLEOS_FILE when unreadable,
 *   KLEOS_SSH_PASSPHRASE_REQUIRED when it is encrypted and no passphrase was given,
 *   KLEOS_SSH when the passphrase is wrong or the file is not a private key.
 */
export async function resolveSshCredentials(
  ssh: SshConfig,
  passphrase: string | null,
  agentSocket: string | undefined,
): Promise<SshCredentials> {
  if (ssh.auth === 'agent') {
    if (!agentSocket) {
      throw sshError('No SSH agent is available (SSH_AUTH_SOCK is not set). Start ssh-agent or choose a key file.');
    }
    return { agent: agentSocket };
  }

  if (!ssh.keyPath?.trim()) throw KleosError.validation('Choose the private key file for the SSH tunnel');
  const privateKey = await readUserFile(ssh.keyPath, 'SSH key file');
  const parsed = utils.parseKey(privateKey, passphrase || undefined);
  if (parsed instanceof Error) {
    if (/no passphrase given/i.test(parsed.message)) {
      throw new KleosError(401, {
        code: kleosErrorCodes.sshPassphraseRequired,
        message: `The SSH key ${ssh.keyPath} is protected by a passphrase`,
      });
    }
    if (passphrase && /passphrase|decrypt|integrity check/i.test(parsed.message)) {
      throw sshError(`The passphrase for the SSH key ${ssh.keyPath} is wrong`, parsed.message);
    }
    throw sshError(`${ssh.keyPath} is not a private key Kleos can read`, parsed.message);
  }
  // A file holding several keys parses to an array; the first is the one ssh2 would use.
  const key = Array.isArray(parsed) ? (parsed[0] as typeof parsed) : parsed;
  if (!key.isPrivateKey()) {
    throw sshError(`${ssh.keyPath} is a public key; choose the private key file (without .pub)`);
  }
  return passphrase ? { privateKey, passphrase } : { privateKey };
}
