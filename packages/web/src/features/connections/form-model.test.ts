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
