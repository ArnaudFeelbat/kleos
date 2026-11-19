import { describe, expect, it } from 'vitest';
import { KleosError } from '../errors';
import { createSqliteStore } from '../store/sqlite';
import { checkHostKey, sshFingerprint } from './host-key';

describe('sshFingerprint', () => {
  it('matches OpenSSH: SHA256 of the key blob, base64 without padding', () => {
    // Blob of an ed25519 public key; ssh-keygen -lf prints this fingerprint for it.
    const blob = Buffer.from('AAAAC3NzaC1lZDI1NTE5AAAAIIDmJTCNsKElHuGvjRha9FaQs1h9B7xqdZSstkigVekn', 'base64');
    expect(sshFingerprint(blob)).toBe('SHA256:ahgRsIPvbMRmduq4Q1PkANXq7NEBR5cnDUTIF5t38v8');
  });
});

describe('checkHostKey (trust on first use)', () => {
  it('refuses an unknown host with its fingerprint, then trusts it when asked with that fingerprint', () => {
    const store = createSqliteStore(':memory:');
    const unknown = checkHostKey(store, 'bastion', 22, 'SHA256:aaa', undefined);
    expect(unknown).toBeInstanceOf(KleosError);
    expect(unknown?.status).toBe(409);
    expect(unknown?.body).toMatchObject({ code: 'KLEOS_SSH_HOST_UNKNOWN', detail: 'SHA256:aaa' });
    expect(unknown?.message).toContain('bastion:22');
    expect(store.getKnownHost('bastion', 22)).toBeNull();

    // A fingerprint other than the presented one trusts nothing.
    expect(checkHostKey(store, 'bastion', 22, 'SHA256:aaa', 'SHA256:zzz')?.body.code).toBe('KLEOS_SSH_HOST_UNKNOWN');
    expect(store.getKnownHost('bastion', 22)).toBeNull();

    expect(checkHostKey(store, 'bastion', 22, 'SHA256:aaa', 'SHA256:aaa')).toBeNull();
    expect(store.getKnownHost('bastion', 22)).toBe('SHA256:aaa');
    expect(checkHostKey(store, 'bastion', 22, 'SHA256:aaa', undefined)).toBeNull();
    store.close();
  });

  it('refuses a changed key, even when told to trust it, and keeps the stored one', () => {
    const store = createSqliteStore(':memory:');
    store.trustKnownHost('bastion', 22, 'SHA256:old');
    for (const trust of [undefined, 'SHA256:new']) {
      const changed = checkHostKey(store, 'bastion', 22, 'SHA256:new', trust);
      expect(changed?.status).toBe(409);
      expect(changed?.body).toMatchObject({ code: 'KLEOS_SSH_HOST_CHANGED', detail: 'SHA256:new' });
    }
    expect(store.getKnownHost('bastion', 22)).toBe('SHA256:old');
    // Another port of the same host is another server.
    expect(checkHostKey(store, 'bastion', 2222, 'SHA256:new', undefined)?.body.code).toBe('KLEOS_SSH_HOST_UNKNOWN');
    store.close();
  });
});
