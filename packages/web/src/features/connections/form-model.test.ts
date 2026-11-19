import { describe, expect, it } from 'vitest';
import { savedConnection } from '@/features/workspace/test-workspace';
import {
  applyConnectionUrl,
  connectionSubtitle,
  emptyForm,
  formFromSaved,
  toConnectionInput,
  toTestRequest,
  validateForm,
} from './form-model';

describe('applyConnectionUrl', () => {
  it('fills every connection field from a URL', () => {
    const next = applyConnectionUrl(emptyForm, 'postgres://alice:s%40cret@db.example.com:6543/shop?sslmode=require');
    expect(next).toMatchObject({
      nickname: 'db.example.com',
      host: 'db.example.com',
      port: '6543',
      user: 'alice',
      password: 's@cret',
      database: 'shop',
      sslMode: 'require',
    });
  });

  it('resets fields the URL leaves out and keeps color and read-only', () => {
    const form = { ...emptyForm, user: 'old', database: 'olddb', color: 'red' as const, readOnly: true };
    const next = applyConnectionUrl(form, 'postgresql://example.org');
    expect(next).toMatchObject({
      host: 'example.org',
      port: '5432',
      user: '',
      database: '',
      color: 'red',
      readOnly: true,
    });
  });

  it('keeps a nickname the user chose', () => {
    const form = { ...emptyForm, nickname: 'Production', host: 'db1' };
    expect(applyConnectionUrl(form, 'postgres://u@db2/x')?.nickname).toBe('Production');
    expect(applyConnectionUrl({ ...form, nickname: 'db1' }, 'postgres://u@db2/x')?.nickname).toBe('db2');
  });

  it('ignores text that is not a postgres URL', () => {
    expect(applyConnectionUrl(emptyForm, 'hello')).toBeNull();
    expect(applyConnectionUrl(emptyForm, 'https://example.org')).toBeNull();
  });
});

describe('form -> request', () => {
  it('defaults nickname to host and database to user', () => {
    const input = toConnectionInput({ ...emptyForm, host: 'db.local', user: 'kleos' });
    expect(input).toMatchObject({ nickname: 'db.local', database: 'kleos', port: 5432, password: null });
  });

  it('keeps the stored password when the field is empty and sends a typed one', () => {
    const form = formFromSaved(savedConnection);
    expect(form.password).toBe('');
    expect(form.savePassword).toBe(true);
    expect(toTestRequest(form, 'c1')).toMatchObject({ password: null, connectionId: 'c1' });
    expect(toTestRequest({ ...form, password: 'pw' }, null)).toMatchObject({ password: 'pw' });
    expect(toTestRequest(form, null)).not.toHaveProperty('connectionId');
  });

  it('validates host, port and user', () => {
    expect(validateForm({ ...emptyForm, port: '54x2' })).toEqual({
      port: 'Port must be a number.',
      user: 'User is required.',
    });
    expect(validateForm({ ...emptyForm, user: 'u', port: '70000' }).port).toMatch(/between/);
    expect(validateForm({ ...emptyForm, user: 'u' })).toEqual({});
  });

  it('formats the favorites subtitle', () => {
    expect(connectionSubtitle(savedConnection)).toBe('kleos@localhost:5432/shop_dev');
  });
});

describe('SSH tunnel and CA certificate', () => {
  const base = { ...emptyForm, host: 'db.internal', user: 'kleos' };
  const tunnel = { ...base, sshEnabled: true, sshHost: 'bastion.example.com', sshUser: 'deploy' };

  it('sends no tunnel while "Connect through SSH" is off, even with SSH fields filled', () => {
    const input = toConnectionInput({ ...tunnel, sshEnabled: false, sshAuth: 'key', sshKeyPath: '/k' });
    expect(input.ssh).toBeNull();
    expect(input).toMatchObject({ sshPassphrase: null, saveSshPassphrase: false });
  });

  it('sends an agent tunnel without a key path or passphrase', () => {
    const input = toConnectionInput({ ...tunnel, sshKeyPath: '/Users/me/.ssh/id_ed25519', sshPassphrase: 'x' });
    expect(input.ssh).toEqual({ host: 'bastion.example.com', port: 22, user: 'deploy', auth: 'agent', keyPath: null });
    expect(input).toMatchObject({ sshPassphrase: null, saveSshPassphrase: false });
  });

  it('sends a key file with its passphrase, or null to keep the stored one', () => {
    const keyed = { ...tunnel, sshAuth: 'key' as const, sshKeyPath: '/Users/me/.ssh/id_ed25519', sshPort: '2222' };
    expect(toConnectionInput({ ...keyed, sshPassphrase: 'open sesame' })).toMatchObject({
      ssh: { port: 2222, auth: 'key', keyPath: '/Users/me/.ssh/id_ed25519' },
      sshPassphrase: 'open sesame',
      saveSshPassphrase: true,
    });
    expect(toConnectionInput(keyed)).toMatchObject({ sshPassphrase: null, saveSshPassphrase: true });
    expect(toTestRequest({ ...keyed, sshPassphrase: 'open sesame' }, 'c1')).toMatchObject({
      sshPassphrase: 'open sesame',
      connectionId: 'c1',
    });
    expect(toTestRequest(keyed, 'c1')).not.toHaveProperty('sshPassphrase');
  });

  it('validates the SSH fields only when the tunnel is on', () => {
    const empty = { ...base, sshEnabled: true, sshPort: 'x', sshAuth: 'key' as const };
    expect(validateForm(empty)).toEqual({
      sshHost: 'SSH host is required.',
      sshPort: 'Port must be a number.',
      sshUser: 'SSH user is required.',
      sshKeyPath: 'Choose a private key file.',
    });
    expect(validateForm({ ...empty, sshEnabled: false })).toEqual({});
    expect(validateForm({ ...tunnel, sshPort: '0' }).sshPort).toMatch(/between/);
    expect(validateForm(tunnel)).toEqual({});
  });

  it('reads a saved tunnel back, showing a stored passphrase as saved', () => {
    const form = formFromSaved({
      ...savedConnection,
      ssh: { host: 'bastion', port: 2200, user: 'deploy', auth: 'key', keyPath: '/k' },
      hasSshPassphrase: true,
      sslMode: 'verify-full',
      sslRootCertPath: '/ca.pem',
    });
    expect(form).toMatchObject({
      sshEnabled: true,
      sshHost: 'bastion',
      sshPort: '2200',
      sshUser: 'deploy',
      sshAuth: 'key',
      sshKeyPath: '/k',
      sshPassphrase: '',
      saveSshPassphrase: true,
      sslRootCertPath: '/ca.pem',
    });
    expect(formFromSaved(savedConnection)).toMatchObject({ sshEnabled: false, sshPort: '22', sslRootCertPath: '' });
  });

  it('sends the CA certificate only when the SSL mode requires TLS', () => {
    const withCa = { ...base, sslRootCertPath: '/Users/me/ca.pem' };
    expect(toConnectionInput({ ...withCa, sslMode: 'verify-full' }).sslRootCertPath).toBe('/Users/me/ca.pem');
    expect(toConnectionInput({ ...withCa, sslMode: 'require' }).sslRootCertPath).toBe('/Users/me/ca.pem');
    expect(toConnectionInput({ ...withCa, sslMode: 'prefer' }).sslRootCertPath).toBeNull();
    expect(toTestRequest({ ...base, sslMode: 'require' }, null).sslRootCertPath).toBeNull();
  });
});
