import type { SavedConnection, SavedQuery, SchemaModel, TableRef } from '@kleos/shared';
import type { WorkspaceTab } from '@/features/workspace/context';
import type { Appearance } from '@/lib/bridge';
import { HOME, type ActiveTab, type ConnectionTab } from './tabs-store';

export type PaletteGroup = 'servers' | 'connections' | 'saved' | 'tables' | 'actions';

export type PaletteRun =
  | { kind: 'activate'; sid: string }
  | { kind: 'connect'; connectionId: string }
  | { kind: 'open-table'; sid: string; ref: TableRef }
  | { kind: 'open-saved'; sid: string; query: SavedQuery }
  | { kind: 'tab'; sid: string; tab: WorkspaceTab }
  | { kind: 'refresh-schema'; sid: string }
  | { kind: 'home' }
  | { kind: 'close-tab'; sid: string }
  | { kind: 'appearance'; mode: Appearance };

export type PaletteIcon =
  | 'server'
  | 'connection'
  | 'table'
  | 'view'
  | 'saved'
  | 'saved-chart'
  | 'schema'
  | 'data'
  | 'query'
  | 'monitor'
  | 'refresh'
  | 'home'
  | 'close'
  | 'system'
  | 'light'
  | 'dark';

export type PaletteEntry = {
  /** Unique; also what cmdk filters on, together with `keywords`. */
  id: string;
  group: PaletteGroup;
  label: string;
  /** Secondary text on the right: server, host, or shortcut context. */
  detail?: string;
  keywords: string[];
  icon: PaletteIcon;
  /** Hex dot for servers and favorites with a color. */
  dot?: string;
  shortcut?: string;
  checked?: boolean;
  run: PaletteRun;
};

export type PaletteInput = {
  tabs: ConnectionTab[];
  active: ActiveTab;
  favorites: SavedConnection[];
  /** Introspected schema per open tab (sid), when loaded. */
  schemas: Record<string, SchemaModel | undefined>;
  /** Saved queries per open tab (sid), when loaded. */
  saved?: Record<string, SavedQuery[] | undefined>;
  appearance: Appearance | null;
  colorOf: (color: SavedConnection['color']) => string | undefined;
  mod: string;
};

/**
 * Ranks a palette item for cmdk. `keywords[0]` is the label, then the detail and extra keywords;
 * the item's value is its id and never matched. Every typed word must appear as a substring
 * (no loose letter-sequence matches, so "appearance" doesn't hit "accounts"). Labels that start
 * with the search rank first, then labels containing it, then keyword-only matches.
 */
export function paletteScore(_value: string, search: string, keywords?: string[]): number {
  const words = search.toLowerCase().split(/\s+/).filter(Boolean);
  if (words.length === 0) return 1;
  const label = (keywords?.[0] ?? '').toLowerCase();
  const haystack = (keywords ?? []).join(' ').toLowerCase();
  if (!words.every((w) => haystack.includes(w))) return 0;
  const phrase = words.join(' ');
  if (label.startsWith(phrase)) return 1;
  if (label.includes(phrase)) return 0.8;
  if (words.every((w) => label.includes(w))) return 0.6;
  return 0.3;
}

/** Table and view entries above this count are left out; a typed search narrows first. */
export const MAX_RELATIONS = 3000;

const workspaceTabs: { tab: WorkspaceTab; label: string; icon: PaletteIcon }[] = [
  { tab: 'schema', label: 'Schema', icon: 'schema' },
  { tab: 'data', label: 'Data', icon: 'data' },
  { tab: 'query', label: 'Query', icon: 'query' },
  { tab: 'monitor', label: 'Monitor', icon: 'monitor' },
];

/**
 * Everything ⌘K can jump to, in display order: open servers, favorites not yet open, tables
 * and views of every open server, then actions for the front tab and the window.
 */
export function buildPaletteEntries(input: PaletteInput): PaletteEntry[] {
  const { tabs, active, favorites, schemas, saved = {}, appearance, colorOf, mod } = input;
  const entries: PaletteEntry[] = [];
  const front = tabs.find((t) => t.sid === active);

  tabs.forEach((t, i) => {
    entries.push({
      id: `server:${t.sid}`,
      group: 'servers',
      label: t.nickname,
      detail: t.sid === active ? 'Current tab' : undefined,
      keywords: ['server', 'tab', 'switch'],
      icon: 'server',
      dot: colorOf(t.color),
      shortcut: i < 9 ? `${mod}${i + 1}` : undefined,
      run: { kind: 'activate', sid: t.sid },
    });
  });

  const open = new Set(tabs.map((t) => t.connectionId));
  for (const f of favorites) {
    if (open.has(f.id)) continue;
    entries.push({
      id: `connection:${f.id}`,
      group: 'connections',
      label: f.nickname,
      detail: `${f.user}@${f.host}:${f.port}/${f.database}`,
      keywords: ['connect', 'open', f.host, f.database],
      icon: 'connection',
      dot: colorOf(f.color),
      run: { kind: 'connect', connectionId: f.id },
    });
  }

  for (const t of tabs) {
    for (const q of saved[t.sid] ?? []) {
      entries.push({
        id: `saved:${t.sid}:${q.id}`,
        group: 'saved',
        label: q.name,
        detail: tabs.length > 1 ? t.nickname : q.chart ? `${q.chart.type} chart` : undefined,
        keywords: ['saved', 'query', q.chart ? 'chart' : 'sql', t.nickname],
        icon: q.chart ? 'saved-chart' : 'saved',
        run: { kind: 'open-saved', sid: t.sid, query: q },
      });
    }
  }

  let relations = 0;
  // The front server first, so its tables win ties.
  const ordered = front ? [front, ...tabs.filter((t) => t !== front)] : tabs;
  outer: for (const t of ordered) {
    const model = schemas[t.sid];
    if (!model) continue;
    for (const [list, icon] of [
      [model.tables, 'table'],
      [model.views, 'view'],
    ] as const) {
      for (const r of list) {
        if (relations >= MAX_RELATIONS) break outer;
        relations += 1;
        entries.push({
          id: `relation:${t.sid}:${r.schema}.${r.name}`,
          group: 'tables',
          label: r.name,
          detail: tabs.length > 1 ? `${r.schema} · ${t.nickname}` : r.schema,
          keywords: [r.schema, `${r.schema}.${r.name}`, icon, t.nickname],
          icon,
          run: { kind: 'open-table', sid: t.sid, ref: { schema: r.schema, name: r.name } },
        });
      }
    }
  }

  if (front) {
    for (const w of workspaceTabs) {
      entries.push({
        id: `action:tab:${w.tab}`,
        group: 'actions',
        label: `Go to ${w.label}`,
        detail: front.nickname,
        keywords: [w.tab, 'tab', 'go'],
        icon: w.icon,
        run: { kind: 'tab', sid: front.sid, tab: w.tab },
      });
    }
    entries.push({
      id: 'action:refresh-schema',
      group: 'actions',
      label: 'Refresh schema',
      detail: front.nickname,
      keywords: ['reload', 'introspect', 'catalog'],
      icon: 'refresh',
      run: { kind: 'refresh-schema', sid: front.sid },
    });
  }
  if (active !== HOME) {
    entries.push({
      id: 'action:home',
      group: 'actions',
      label: 'Show connections',
      keywords: ['favorites', 'new', 'connect', 'home'],
      icon: 'home',
      shortcut: `${mod}T`,
      run: { kind: 'home' },
    });
  }
  if (front) {
    entries.push({
      id: 'action:close-tab',
      group: 'actions',
      label: `Close ${front.nickname}`,
      keywords: ['close', 'tab', 'disconnect'],
      icon: 'close',
      shortcut: `${mod}W`,
      run: { kind: 'close-tab', sid: front.sid },
    });
  }
  for (const [mode, label] of [
    ['system', 'Appearance: Use system setting'],
    ['light', 'Appearance: Light'],
    ['dark', 'Appearance: Dark'],
  ] as const) {
    entries.push({
      id: `action:appearance:${mode}`,
      group: 'actions',
      label,
      keywords: ['theme', 'mode', 'appearance', mode, mode === 'dark' ? 'night' : 'day'],
      icon: mode,
      checked: appearance === mode,
      run: { kind: 'appearance', mode },
    });
  }
  return entries;
}
