import { describe, expect, it } from 'vitest';
import type { Snippet } from '@kleos/shared';
import { setup } from './test-utils';

describe('snippet routes', () => {
  it('creates, lists by name ignoring case, updates and deletes', async () => {
    const { call } = setup();
    expect((await call('GET', '/snippets')).body).toEqual([]);

    const created = await call('POST', '/snippets', { name: '  locks  ', body: 'select * from pg_locks' });
    expect(created.status).toBe(200);
    const locks = created.body as Snippet;
    expect(locks).toMatchObject({ id: expect.any(String), name: 'locks', body: 'select * from pg_locks' });
    expect(locks.updatedAt).toBe(locks.createdAt);
    await call('POST', '/snippets', { name: 'Active sessions', body: 'select * from pg_stat_activity' });
    await call('POST', '/snippets', { name: 'bloat', body: '' });
    const names = async () => ((await call('GET', '/snippets')).body as Snippet[]).map((s) => s.name);
    expect(await names()).toEqual(['Active sessions', 'bloat', 'locks']);

    const updated = await call('PUT', `/snippets/${locks.id}`, { name: 'Locks', body: 'select 1' });
    expect(updated.status).toBe(200);
    expect(updated.body).toMatchObject({ id: locks.id, name: 'Locks', body: 'select 1', createdAt: locks.createdAt });

    expect((await call('DELETE', `/snippets/${locks.id}`)).status).toBe(204);
    expect((await call('DELETE', `/snippets/${locks.id}`)).status).toBe(204);
    expect(await names()).toEqual(['Active sessions', 'bloat']);
  });

  it('refuses a name already taken, whatever its case, with a 409', async () => {
    const { call } = setup();
    await call('POST', '/snippets', { name: 'Top 10', body: 'select 1' });
    const other = (await call('POST', '/snippets', { name: 'other', body: '' })).body as Snippet;

    const dup = await call('POST', '/snippets', { name: 'top 10', body: 'select 2' });
    expect(dup.status).toBe(409);
    expect(dup.body).toEqual({
      code: 'KLEOS_VALIDATION',
      message: 'A snippet named "Top 10" already exists',
      hint: 'Choose another name, or edit that snippet instead.',
    });
    const rename = await call('PUT', `/snippets/${other.id}`, { name: 'TOP 10', body: '' });
    expect(rename.status).toBe(409);
    expect(((await call('GET', '/snippets')).body as Snippet[]).map((s) => s.name)).toEqual(['other', 'Top 10']);
  });

  it('validates input and answers 404 for an unknown id', async () => {
    const { call } = setup();
    expect((await call('POST', '/snippets', { name: '   ', body: '' })).status).toBe(400);
    expect((await call('POST', '/snippets', { name: 'x' })).status).toBe(400);
    expect((await call('POST', '/snippets', { name: 'x'.repeat(201), body: '' })).status).toBe(400);
    expect((await call('POST', '/snippets', { name: 'big', body: 'x'.repeat(100_001) })).status).toBe(400);
    const missing = await call('PUT', '/snippets/nope', { name: 'x', body: '' });
    expect(missing.status).toBe(404);
    expect(missing.body).toEqual({ code: 'KLEOS_NOT_FOUND', message: 'Snippet not found' });
  });
});
