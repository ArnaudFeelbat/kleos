import { describe, expect, it } from 'vitest';
import type { AppStore } from '../store/types';
import { createMemorySecretStore } from '../store/keychain';
import { SessionRegistry } from '../sessions/registry';
import { createPostgresAdapter } from '../adapter/postgres';
import { createApp } from './app';

const PORT = 41234;
const TOKEN = 'a'.repeat(64);

function makeApp() {
  return createApp(
    {
      adapter: createPostgresAdapter(),
      store: {} as AppStore,
      secrets: createMemorySecretStore(),
      sessions: new SessionRegistry(),
      version: '9.9.9',
    },
    { token: TOKEN, getPort: () => PORT },
  );
}

const ok = { host: `127.0.0.1:${PORT}`, authorization: `Bearer ${TOKEN}` };

describe('api security', () => {
  it('answers health with the right token and host', async () => {
    const res = await makeApp().request('/api/health', { headers: ok });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, version: '9.9.9' });
  });

  it('rejects a missing or wrong token', async () => {
    const app = makeApp();
    expect((await app.request('/api/health', { headers: { host: ok.host } })).status).toBe(401);
    const wrong = await app.request('/api/health', { headers: { host: ok.host, authorization: 'Bearer nope' } });
    expect(wrong.status).toBe(401);
  });

  it('rejects a foreign Host header even with the token', async () => {
    const res = await makeApp().request('/api/health', {
      headers: { ...ok, host: `evil.example:${PORT}` },
    });
    expect(res.status).toBe(403);
  });

  it('answers unknown routes with the error shape', async () => {
    const res = await makeApp().request('/api/nope', { headers: ok });
    expect(res.status).toBe(404);
    expect(await res.json()).toMatchObject({ code: 'KLEOS_NOT_FOUND' });
  });
});
