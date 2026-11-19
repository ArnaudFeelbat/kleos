import { describe, expect, it } from 'vitest';
import type { RestoredServer, WindowState } from '@kleos/shared';
import { setup } from './test-utils';

const server = (connectionId: string, overrides: Partial<RestoredServer> = {}): RestoredServer => ({
  connectionId,
  queryTabs: [
    { title: 'Orders', sql: 'select * from orders', chart: null, savedQueryId: null },
    { title: 'Query 2', sql: '', chart: null, savedQueryId: 'saved-1' },
  ],
  activeQueryTab: 1,
  workspaceTab: 'query',
  ...overrides,
});

describe('window state routes', () => {
  it('answers the empty state when nothing is saved', async () => {
    const { call } = setup();
    const res = await call('GET', '/window-state');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ servers: [], activeConnectionId: null });
  });

  it('saves the state and reads it back, replacing the previous one', async () => {
    const { call, createConnection } = setup();
    const a = await createConnection({ nickname: 'A' });
    const b = await createConnection({ nickname: 'B' });
    const first: WindowState = {
      servers: [server(a.id), server(b.id, { workspaceTab: 'data' })],
      activeConnectionId: b.id,
    };
    const put = await call('PUT', '/window-state', first);
    expect(put.status).toBe(204);
    expect(put.body).toBeNull();
    expect((await call('GET', '/window-state')).body).toEqual(first);

    const second: WindowState = { servers: [server(a.id)], activeConnectionId: null };
    await call('PUT', '/window-state', second);
    expect((await call('GET', '/window-state')).body).toEqual(second);
  });

  it('leaves out servers whose favorite was deleted, and the active one if it was', async () => {
    const { call, createConnection } = setup();
    const a = await createConnection({ nickname: 'A' });
    const b = await createConnection({ nickname: 'B' });
    await call('PUT', '/window-state', { servers: [server(a.id), server(b.id)], activeConnectionId: b.id });
    await call('DELETE', `/connections/${b.id}`);
    expect((await call('GET', '/window-state')).body).toEqual({ servers: [server(a.id)], activeConnectionId: null });
  });

  it('rejects a body that is not a WindowState', async () => {
    const { call } = setup();
    const res = await call('PUT', '/window-state', { servers: [{ connectionId: 'x', queryTabs: [] }] });
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ code: 'KLEOS_VALIDATION' });
    expect((await call('GET', '/window-state')).body).toEqual({ servers: [], activeConnectionId: null });
  });

  it('forgets a trusted SSH host key so the next connection asks again', async () => {
    const { call, store } = setup();
    store.trustKnownHost('bastion.example.com', 22, 'SHA256:old');
    store.trustKnownHost('bastion.example.com', 2222, 'SHA256:other');
    const res = await call('DELETE', '/ssh-known-hosts/bastion.example.com/22');
    expect(res.status).toBe(204);
    expect(store.getKnownHost('bastion.example.com', 22)).toBeNull();
    expect(store.getKnownHost('bastion.example.com', 2222)).toBe('SHA256:other');
    expect((await call('DELETE', '/ssh-known-hosts/bastion.example.com/0')).status).toBe(400);
  });
});
