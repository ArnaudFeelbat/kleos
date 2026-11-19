import { describe, expect, it } from 'vitest';
import type { SavedConnection, SchemaModel } from '@kleos/shared';
import { buildPaletteEntries, type PaletteInput } from './palette-model';
import { HOME, type ConnectionTab } from './tabs-store';

const favorite = (id: string, nickname: string): SavedConnection => ({
  id,
  nickname,
  host: 'localhost',
  port: 5432,
  user: 'kleos',
  database: 'shop',
  sslMode: 'prefer',
  color: 'blue',
  readOnly: false,
  hasPassword: true,
  createdAt: '',
  updatedAt: '',
});
const tab = (sid: string, connectionId: string, nickname: string): ConnectionTab => ({
  sid,
  connectionId,
  nickname,
  color: 'blue',
  readOnly: false,
});
const model = (tables: string[], views: string[] = []) =>
  ({
    schemas: ['public'],
    tables: tables.map((name) => ({ schema: 'public', name })),
    views: views.map((name) => ({ schema: 'public', name })),
    foreignKeys: [],
    enums: [],
    introspectedAt: '',
  }) as unknown as SchemaModel;

function input(patch: Partial<PaletteInput> = {}): PaletteInput {
  return {
    tabs: [],
    active: HOME,
    favorites: [],
    schemas: {},
    appearance: 'system',
    colorOf: () => '#3e63dd',
    mod: '⌘',
    ...patch,
  };
}

describe('buildPaletteEntries', () => {
  it('lists open servers with ⌘N, then favorites that are not open yet', () => {
    const entries = buildPaletteEntries(
      input({
        tabs: [tab('s1', 'c1', 'dev'), tab('s2', 'c2', 'prod')],
        active: 's2',
        favorites: [favorite('c1', 'dev'), favorite('c2', 'prod'), favorite('c3', 'staging')],
      }),
    );
    const servers = entries.filter((e) => e.group === 'servers');
    expect(servers.map((e) => [e.label, e.shortcut])).toEqual([
      ['dev', '⌘1'],
      ['prod', '⌘2'],
    ]);
    expect(servers[1]?.detail).toBe('Current tab');
    expect(entries.filter((e) => e.group === 'connections').map((e) => e.label)).toEqual(['staging']);
  });

  it('lists tables and views of every open server, the front one first', () => {
    const entries = buildPaletteEntries(
      input({
        tabs: [tab('s1', 'c1', 'dev'), tab('s2', 'c2', 'prod')],
        active: 's2',
        schemas: { s1: model(['orders']), s2: model(['events'], ['daily']) },
      }),
    );
    const relations = entries.filter((e) => e.group === 'tables');
    expect(relations.map((e) => [e.label, e.icon, e.detail])).toEqual([
      ['events', 'table', 'public · prod'],
      ['daily', 'view', 'public · prod'],
      ['orders', 'table', 'public · dev'],
    ]);
    expect(relations[2]?.run).toEqual({ kind: 'open-table', sid: 's1', ref: { schema: 'public', name: 'orders' } });
  });

  it('offers workspace actions only when a server tab is in front', () => {
    const home = buildPaletteEntries(input({ tabs: [tab('s1', 'c1', 'dev')], active: HOME }));
    expect(home.some((e) => e.id === 'action:tab:data')).toBe(false);
    expect(home.some((e) => e.id === 'action:home')).toBe(false);
    const front = buildPaletteEntries(input({ tabs: [tab('s1', 'c1', 'dev')], active: 's1' }));
    expect(front.find((e) => e.id === 'action:tab:data')?.run).toEqual({ kind: 'tab', sid: 's1', tab: 'data' });
    expect(front.find((e) => e.id === 'action:close-tab')?.label).toBe('Close dev');
    expect(front.some((e) => e.id === 'action:home')).toBe(true);
  });

  it('lists saved queries of open servers, with their chart type', () => {
    const query = {
      id: 'q1',
      connectionId: 'c1',
      name: 'revenue by channel',
      sql: 'select 1',
      chart: { type: 'line' as const, x: 'day', y: ['web'] },
      createdAt: '',
      updatedAt: '',
    };
    const entries = buildPaletteEntries(
      input({ tabs: [tab('s1', 'c1', 'dev')], active: 's1', saved: { s1: [query] } }),
    );
    const saved = entries.filter((e) => e.group === 'saved');
    expect(saved.map((e) => [e.label, e.icon, e.detail])).toEqual([
      ['revenue by channel', 'saved-chart', 'line chart'],
    ]);
    expect(saved[0]?.run).toEqual({ kind: 'open-saved', sid: 's1', query });
  });

  it('marks the current appearance', () => {
    const entries = buildPaletteEntries(input({ appearance: 'dark' }));
    const appearance = entries.filter((e) => e.id.startsWith('action:appearance:'));
    expect(appearance.map((e) => [e.id, e.checked])).toEqual([
      ['action:appearance:system', false],
      ['action:appearance:light', false],
      ['action:appearance:dark', true],
    ]);
  });

  it('always offers Settings… (⌘,) and Check for Updates, last', () => {
    const entries = buildPaletteEntries(input());
    expect(entries.slice(-2).map((e) => [e.label, e.shortcut, e.run])).toEqual([
      ['Settings…', '⌘,', { kind: 'settings' }],
      ['Check for Updates', undefined, { kind: 'check-updates' }],
    ]);
  });
});
