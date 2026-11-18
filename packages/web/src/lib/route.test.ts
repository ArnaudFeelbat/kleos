import { describe, expect, it } from 'vitest';
import { parseRoute, workspaceHash } from './route';

describe('parseRoute', () => {
  it('opens the connections screen by default', () => {
    expect(parseRoute('')).toEqual({ name: 'connections' });
    expect(parseRoute('#/')).toEqual({ name: 'connections' });
  });

  it('round-trips a workspace session id', () => {
    const sid = 'a7e09b44-12cd-4f8a-b3e1-6c2d90f7a512';
    expect(parseRoute(workspaceHash(sid))).toEqual({ name: 'workspace', sid });
  });
});
