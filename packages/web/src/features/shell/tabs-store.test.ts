import { afterEach, describe, expect, it } from 'vitest';
import type { SessionInfo } from '@kleos/shared';
import { HOME, tabsStore } from './tabs-store';

function session(sid: string, connectionId: string, nickname = connectionId): SessionInfo {
  return {
    sid,
    serverVersion: 'PostgreSQL 17.0',
    serverVersionShort: '17.0',
    connection: {
      id: connectionId,
      nickname,
      host: 'localhost',
      port: 5432,
      user: 'me',
      database: 'db',
      sslMode: 'prefer',
      color: 'none',
      readOnly: false,
      hasPassword: false,
      createdAt: '',
      updatedAt: '',
    },
  };
}

afterEach(() => tabsStore.reset());

describe('tabsStore', () => {
  it('opens tabs in order and brings each new one to front', () => {
    tabsStore.open(session('s1', 'c1'));
    tabsStore.open(session('s2', 'c2'));
    expect(tabsStore.get().tabs.map((t) => t.sid)).toEqual(['s1', 's2']);
    expect(tabsStore.get().active).toBe('s2');
    expect(tabsStore.findByConnection('c1')?.sid).toBe('s1');
  });

  it('closing the active tab fronts its right neighbour, then the left, then Connections', () => {
    tabsStore.open(session('s1', 'c1'));
    tabsStore.open(session('s2', 'c2'));
    tabsStore.open(session('s3', 'c3'));
    tabsStore.activate('s2');
    expect(tabsStore.close('s2')).toBe('s2');
    expect(tabsStore.get().active).toBe('s3');
    tabsStore.close('s3');
    expect(tabsStore.get().active).toBe('s1');
    tabsStore.close('s1');
    expect(tabsStore.get().active).toBe(HOME);
    expect(tabsStore.close('nope')).toBeNull();
  });

  it('closing a background tab keeps the front one', () => {
    tabsStore.open(session('s1', 'c1'));
    tabsStore.open(session('s2', 'c2'));
    tabsStore.close('s1');
    expect(tabsStore.get().active).toBe('s2');
  });

  it('switches by index (9 = last) and cycles through Connections', () => {
    tabsStore.open(session('s1', 'c1'));
    tabsStore.open(session('s2', 'c2'));
    tabsStore.activateIndex(1);
    expect(tabsStore.get().active).toBe('s1');
    tabsStore.activateIndex(9);
    expect(tabsStore.get().active).toBe('s2');
    tabsStore.activateRelative(1);
    expect(tabsStore.get().active).toBe(HOME);
    tabsStore.activateRelative(-1);
    expect(tabsStore.get().active).toBe('s2');
  });

  it('follows renamed or recoloured favorites', () => {
    tabsStore.open(session('s1', 'c1', 'old'));
    tabsStore.syncConnections([{ id: 'c1', nickname: 'new', color: 'red', readOnly: true }]);
    expect(tabsStore.get().tabs[0]).toMatchObject({ nickname: 'new', color: 'red', readOnly: true });
  });
});
