import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { utils } from 'ssh2';
import { afterAll, describe, expect, it } from 'vitest';
import type { SshConfig } from '@kleos/shared';
import { KleosError } from '../errors';
import { expandHome } from '../user-files';
import { resolveSshCredentials } from './auth';

const dir = mkdtempSync(join(tmpdir(), 'kleos-ssh-auth-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

function writeKey(name: string, passphrase?: string): { privatePath: string; publicPath: string } {
  const pair = passphrase
    ? utils.generateKeyPairSync('ed25519', { passphrase, cipher: 'aes256-ctr', rounds: 4 })
    : utils.generateKeyPairSync('ed25519');
  const privatePath = join(dir, name);
  writeFileSync(privatePath, pair.private, { mode: 0o600 });
  writeFileSync(`${privatePath}.pub`, pair.public);
  return { privatePath, publicPath: `${privatePath}.pub` };
}

const plain = writeKey('plain');
const encrypted = writeKey('encrypted', 'right horse');

const keyConfig = (keyPath: string | null): SshConfig => ({
  host: 'bastion',
  port: 22,
  user: 'me',
  auth: 'key',
  keyPath,
});

async function failure(promise: Promise<unknown>): Promise<KleosError> {
  const err = await promise.then(
    () => null,
    (caught: unknown) => caught,
  );
  expect(err).toBeInstanceOf(KleosError);
  return err as KleosError;
}

describe('SSH credentials', () => {
  it('uses the agent socket for agent auth', async () => {
    const ssh: SshConfig = { host: 'bastion', port: 22, user: 'me', auth: 'agent', keyPath: null };
    expect(await resolveSshCredentials(ssh, null, '/tmp/agent.sock')).toEqual({ agent: '/tmp/agent.sock' });
  });

  it('refuses agent auth with a clear KLEOS_SSH when no agent is running', async () => {
    const ssh: SshConfig = { host: 'bastion', port: 22, user: 'me', auth: 'agent', keyPath: null };
    const err = await failure(resolveSshCredentials(ssh, null, undefined));
    expect(err.status).toBe(502);
    expect(err.body.code).toBe('KLEOS_SSH');
    expect(err.message).toMatch(/SSH_AUTH_SOCK/);
  });

  it('reads an unencrypted key, ignoring a passphrase it does not need', async () => {
    const creds = await resolveSshCredentials(keyConfig(plain.privatePath), null, undefined);
    expect(creds).toEqual({ privateKey: expect.any(Buffer) });
    expect(await resolveSshCredentials(keyConfig(plain.privatePath), 'unused', undefined)).toMatchObject({
      privateKey: expect.any(Buffer),
    });
  });

  it('asks for the passphrase of an encrypted key with KLEOS_SSH_PASSPHRASE_REQUIRED', async () => {
    for (const passphrase of [null, '']) {
      const err = await failure(resolveSshCredentials(keyConfig(encrypted.privatePath), passphrase, undefined));
      expect(err.status).toBe(401);
      expect(err.body.code).toBe('KLEOS_SSH_PASSPHRASE_REQUIRED');
      expect(err.message).toContain(encrypted.privatePath);
    }
  });

  it('says a wrong passphrase is wrong', async () => {
    const err = await failure(resolveSshCredentials(keyConfig(encrypted.privatePath), 'wrong horse', undefined));
    expect(err.body.code).toBe('KLEOS_SSH');
    expect(err.message).toBe(`The passphrase for the SSH key ${encrypted.privatePath} is wrong`);
  });

  it('decrypts with the right passphrase', async () => {
    // Intermittent under the full suite only (2 of ~6 runs, never alone): surface ssh2's own
    // parse error, kept in the KleosError's detail, if it fails again.
    const resolved = await resolveSshCredentials(keyConfig(encrypted.privatePath), 'right horse', undefined).catch(
      (err: unknown) => {
        throw new Error(`unexpected failure: ${JSON.stringify(err instanceof KleosError ? err.body : String(err))}`);
      },
    );
    expect(resolved).toEqual({
      privateKey: expect.any(Buffer),
      passphrase: 'right horse',
    });
  });

  it('reports an unreadable key file as KLEOS_FILE, a public key and junk as KLEOS_SSH', async () => {
    const missing = await failure(resolveSshCredentials(keyConfig(join(dir, 'nope')), null, undefined));
    expect(missing.status).toBe(400);
    expect(missing.body).toMatchObject({ code: 'KLEOS_FILE', detail: 'ENOENT' });

    const pub = await failure(resolveSshCredentials(keyConfig(plain.publicPath), null, undefined));
    expect(pub.body.code).toBe('KLEOS_SSH');
    expect(pub.message).toMatch(/public key/);

    const junkPath = join(dir, 'junk');
    writeFileSync(junkPath, 'not a key');
    const junk = await failure(resolveSshCredentials(keyConfig(junkPath), null, undefined));
    expect(junk.body.code).toBe('KLEOS_SSH');

    const none = await failure(resolveSshCredentials(keyConfig(null), null, undefined));
    expect(none.body.code).toBe('KLEOS_VALIDATION');
  });

  it('expands a leading ~ to the home directory', () => {
    expect(expandHome('~/.ssh/id_ed25519')).toBe(join(homedir(), '.ssh/id_ed25519'));
    expect(expandHome('~')).toBe(homedir());
    expect(expandHome('/etc/~/x')).toBe('/etc/~/x');
    expect(expandHome('~other/x')).toBe('~other/x');
  });
});
