import { describe, expect, it } from 'vitest';
import { parseConnectionUrl } from './connection';

describe('parseConnectionUrl', () => {
  it('fills every field from a full URL', () => {
    expect(parseConnectionUrl('postgres://kleos:s3cr%40t@db.example.com:6432/shop?sslmode=require')).toEqual({
      host: 'db.example.com',
      nickname: 'db.example.com',
      port: '6432',
      user: 'kleos',
      password: 's3cr@t',
      database: 'shop',
      sslMode: 'require',
    });
  });

  it('accepts postgresql:// and defaults the port', () => {
    expect(parseConnectionUrl('postgresql://me@localhost/app')).toMatchObject({
      host: 'localhost',
      port: '5432',
      user: 'me',
      database: 'app',
    });
  });

  it('maps verify-ca to verify-full', () => {
    expect(parseConnectionUrl('postgres://h/db?sslmode=verify-ca')?.sslMode).toBe('verify-full');
  });

  it('returns null for text that is not a postgres URL', () => {
    expect(parseConnectionUrl('localhost')).toBeNull();
    expect(parseConnectionUrl('https://example.com')).toBeNull();
  });
});
