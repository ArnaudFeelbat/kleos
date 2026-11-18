import { describe, expect, it, vi } from 'vitest';
import type { SavedConnection } from '@kleos/shared';
import { connectionInput, pgError, setup } from './test-utils';

describe('connection routes', () => {
  it('creates a favorite without a password and lists it', async () => {
    const { call, secrets } = setup();
    const created = await call('POST', '/connections', connectionInput());
    expect(created.status).toBe(200);
    expect(created.body).toMatchObject({ nickname: 'Local', hasPassword: false });
    expect(created.body).not.toHaveProperty('password');
    expect(secrets.entries.size).toBe(0);

    const list = await call('GET', '/connections');
    expect(list.status).toBe(200);
    expect(list.body).toEqual([created.body]);
  });

  it('stores the password in the Keychain only when savePassword is ticked', async () => {
    const { createConnection, secrets } = setup();
    const saved = await createConnection({ nickname: 'A', password: 'pw', savePassword: true });
    expect(saved.hasPassword).toBe(true);
    expect(secrets.entries.get(saved.id)).toBe('pw');

    const unsaved = await createConnection({ nickname: 'B', password: 'pw', savePassword: false });
    expect(unsaved.hasPassword).toBe(false);
    expect(secrets.entries.has(unsaved.id)).toBe(false);
  });

  it('rolls the favorite back when the Keychain write fails', async () => {
    const { call, secrets, store } = setup();
    secrets.set = async () => {
      throw new Error('Keychain locked');
    };
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const res = await call('POST', '/connections', connectionInput({ password: 'pw', savePassword: true }));
      expect(res.status).toBe(500);
      expect(res.body).toMatchObject({ code: 'KLEOS_INTERNAL', message: 'Keychain locked' });
      expect(store.listConnections()).toEqual([]);
    } finally {
      log.mockRestore();
    }
  });

  it('keeps the stored password when an update sends password null', async () => {
    const { call, createConnection, secrets } = setup();
    const c = await createConnection({ password: 'pw', savePassword: true });
    const res = await call(
      'PUT',
      `/connections/${c.id}`,
      connectionInput({ nickname: 'Renamed', password: null, savePassword: true }),
    );
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ id: c.id, nickname: 'Renamed', hasPassword: true });
    expect(secrets.entries.get(c.id)).toBe('pw');
  });

  it('replaces the stored password when an update sends a new one', async () => {
    const { call, createConnection, secrets } = setup();
    const c = await createConnection({ password: 'old', savePassword: true });
    const res = await call('PUT', `/connections/${c.id}`, connectionInput({ password: 'new', savePassword: true }));
    expect(res.body).toMatchObject({ hasPassword: true });
    expect(secrets.entries.get(c.id)).toBe('new');
  });

  it('saves a password on update for a favorite that had none', async () => {
    const { call, createConnection, secrets } = setup();
    const c = await createConnection();
    const res = await call('PUT', `/connections/${c.id}`, connectionInput({ password: 'pw', savePassword: true }));
    expect(res.body).toMatchObject({ hasPassword: true });
    expect(secrets.entries.get(c.id)).toBe('pw');
  });

  it('removes the Keychain entry when an update unticks savePassword', async () => {
    const { call, createConnection, secrets } = setup();
    const c = await createConnection({ password: 'pw', savePassword: true });
    const res = await call('PUT', `/connections/${c.id}`, connectionInput({ password: 'pw', savePassword: false }));
    expect(res.body).toMatchObject({ hasPassword: false });
    expect(secrets.entries.has(c.id)).toBe(false);
  });

  it('answers 404 when updating an unknown favorite', async () => {
    const { call } = setup();
    const res = await call('PUT', '/connections/nope', connectionInput());
    expect(res.status).toBe(404);
    expect(res.body).toMatchObject({ code: 'KLEOS_NOT_FOUND' });
  });

  it('deletes a favorite, its Keychain entry and its open sessions', async () => {
    const { call, openSession, secrets, sessions } = setup();
    const { connection, sid, session } = await openSession();
    const res = await call('DELETE', `/connections/${connection.id}`);
    expect(res.status).toBe(204);
    expect(res.body).toBeNull();
    expect(secrets.entries.has(connection.id)).toBe(false);
    expect(session.closed).toBe(true);
    expect(sessions.forConnection(connection.id)).toEqual([]);
    expect((await call('GET', '/connections')).body).toEqual([]);
    expect((await call('GET', `/sessions/${sid}`)).status).toBe(404);
  });

  it('still deletes the favorite when closing one of its sessions fails', async () => {
    const { call, openSession } = setup();
    const { connection, session } = await openSession();
    session.errors.set('close', new Error('socket gone'));
    expect((await call('DELETE', `/connections/${connection.id}`)).status).toBe(204);
    expect((await call('GET', '/connections')).body).toEqual([]);
  });

  it('rejects an invalid body with 400 KLEOS_VALIDATION', async () => {
    const { call } = setup();
    const bad = await call('POST', '/connections', { ...connectionInput(), port: 70000, nickname: '' });
    expect(bad.status).toBe(400);
    expect(bad.body).toMatchObject({ code: 'KLEOS_VALIDATION' });
    expect((bad.body as { detail: string }).detail).toMatch(/port/);

    const notJson = await call('POST', '/connections', '{oops');
    expect(notJson.status).toBe(400);
    expect(notJson.body).toMatchObject({ code: 'KLEOS_VALIDATION' });
  });
});

describe('POST /connections/test', () => {
  const form = () => {
    const { password: _p, savePassword: _s, ...config } = connectionInput();
    return config;
  };

  it('tests form values with the typed password, saving nothing', async () => {
    const { call, adapter, store } = setup();
    const res = await call('POST', '/connections/test', { ...form(), password: 'typed' });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ version: 'PostgreSQL 16.4', elapsedMs: 4 });
    expect(adapter.testCalls).toEqual([
      {
        config: {
          nickname: 'Local',
          host: 'localhost',
          port: 5432,
          user: 'postgres',
          database: 'shop',
          sslMode: 'prefer',
          color: 'none',
          readOnly: false,
        },
        password: 'typed',
      },
    ]);
    expect(store.listConnections()).toEqual([]);
  });

  it("uses the favorite's stored password when password is null and connectionId is given", async () => {
    const { call, adapter, createConnection } = setup();
    const c: SavedConnection = await createConnection({ password: 'stored', savePassword: true });
    await call('POST', '/connections/test', { ...form(), password: null, connectionId: c.id });
    expect(adapter.testCalls[0]?.password).toBe('stored');

    await call('POST', '/connections/test', { ...form(), password: 'typed', connectionId: c.id });
    expect(adapter.testCalls[1]?.password).toBe('typed');

    await call('POST', '/connections/test', { ...form(), password: null });
    expect(adapter.testCalls[2]?.password).toBeNull();
  });

  it("passes the driver's Postgres error through as a 400 with its SQLSTATE", async () => {
    const { call, adapter } = setup();
    adapter.testError = pgError('28P01', 'password authentication failed for user "postgres"');
    const res = await call('POST', '/connections/test', { ...form(), password: 'bad' });
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ code: '28P01', message: 'password authentication failed for user "postgres"' });
  });

  it('reports network failures as KLEOS_CONNECTION with the driver message', async () => {
    const { call, adapter } = setup();
    adapter.testError = Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:5432'), { code: 'ECONNREFUSED' });
    const res = await call('POST', '/connections/test', { ...form(), password: null });
    expect(res.status).toBe(400);
    expect(res.body).toEqual({
      code: 'KLEOS_CONNECTION',
      message: 'connect ECONNREFUSED 127.0.0.1:5432',
      detail: 'ECONNREFUSED',
    });
  });
});
