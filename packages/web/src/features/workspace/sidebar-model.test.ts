import { describe, expect, it } from 'vitest';
import { defaultSchema } from './sidebar-model';

const rel = (schema: string, name: string) => ({ schema, name }) as never;

describe('defaultSchema', () => {
  it('opens on public when it holds tables', () => {
    expect(
      defaultSchema({
        schemas: ['app', 'public'],
        tables: [rel('public', 'a'), rel('app', 'b'), rel('app', 'c')],
        views: [],
      }),
    ).toBe('public');
  });

  it('opens on the busiest schema when public is empty', () => {
    expect(
      defaultSchema({
        schemas: ['public', 'shop', 'types'],
        tables: [rel('shop', 'a'), rel('shop', 'b'), rel('types', 'c')],
        views: [],
      }),
    ).toBe('shop');
  });

  it('counts views too and breaks ties by name', () => {
    expect(defaultSchema({ schemas: ['public', 'b', 'a'], tables: [rel('b', 't')], views: [rel('a', 'v')] })).toBe('a');
  });

  it('falls back to public, then the first schema, when nothing has relations', () => {
    expect(defaultSchema({ schemas: ['x', 'public'], tables: [], views: [] })).toBe('public');
    expect(defaultSchema({ schemas: ['x'], tables: [], views: [] })).toBe('x');
    expect(defaultSchema(undefined)).toBe('public');
  });
});
