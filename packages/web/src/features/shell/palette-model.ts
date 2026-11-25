import type { SavedConnection, SavedQuery, SchemaModel, Snippet, TableRef } from '@kleos/shared';
import type { WorkspaceTab } from '@/features/workspace/context';
import { firstLine } from '@/features/snippets/first-line';
import type { Appearance } from '@/lib/bridge';
import { HOME, type ActiveTab, type ConnectionTab } from './tabs-store';

export type PaletteGroup = 'servers' | 'connections' | 'saved' | 'snippets' | 'tables' | 'actions';

export type PaletteRun =
  | { kind: 'activate'; sid: string }
  | { kind: 'connect'; connectionId: string }
  | { kind: 'open-table'; sid: string; ref: TableRef }
  | { kind: 'open-saved'; sid: string; query: SavedQuery }
  | { kind: 'run-saved'; sid: string; query: SavedQuery }
  | { kind: 'insert-sql'; sid: string; text: string }
  | { kind: 'search-history'; sid: string }
  | { kind: 'tab'; sid: string; tab: WorkspaceTab }
  | { kind: 'refresh-schema'; sid: string }
  | { kind: 'home' }
  | { kind: 'close-tab'; sid: string }
  | { kind: 'appearance'; mode: Appearance }
  | { kind: 'settings' }
  | { kind: 'check-updates' };

export type PaletteIcon =
  | 'server'
  | 'connection'
  | 'table'
  | 'view'
  | 'saved'
  | 'saved-chart'
  | 'run'
  | 'snippet'
  | 'history'
  | 'schema'
  | 'data'
  | 'query'
  | 'monitor'
  | 'refresh'
  | 'home'
  | 'close'
  | 'system'
  | 'light'
  | 'dark'
  | 'settings'
  | 'update';

export type PaletteEntry = {
  /** Unique; also what cmdk filters on, together with `keywords`. */
  id: string;
  group: PaletteGroup;
  label: string;
  /**
   * What the search ranks against when it is not the label: "Run saved query: revenue" ranks
   * as "revenue", so typing a name puts its entries first. The label still matches as a keyword.
   */
  match?: string;
  /** Secondary text on the right: server, host, or shortcut context. */
  detail?: string;
  keywords: string[];
  icon: PaletteIcon;
  /** Hex dot for servers and favorites with a color. */
  dot?: string;
  shortcut?: string;
  checked?: boolean;
  /** Listed only once something is typed, so the empty palette stays a short list. */
  searchOnly?: boolean;
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
  /** Snippets (shared by every server), when loaded. */
  snippets?: Snippet[];
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

/**
 * cmdk ranking: paletteScore, with "open saved query" entries a hair below the matching "Run
 * saved query" entry. Typing a saved query's name then Enter runs it (0.7: ⌘K, name, Enter,
 * Enter), whatever cmdk's order was before; opening it without running stays one ↓ away.
 */
export function paletteFilter(value: string, search: string, keywords?: string[]): number {
  const score = paletteScore(value, search, keywords);
  return value.startsWith('saved:') ? score * 0.99 : score;
}

/** cmdk keywords of an entry: what it ranks against first (see paletteScore), then the rest. */
export function paletteKeywords(entry: PaletteEntry): string[] {
  return [entry.match ?? entry.label, entry.detail ?? '', ...entry.keywords, ...(entry.match ? [entry.label] : [])];
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
 * Everything ⌘K can jump to, in display order: open servers, favorites not yet open, saved
 * queries of open servers (run or open), snippets to insert in the front server, tables and
 * views of every open server, then actions for the front tab and the window.
 */
export function buildPaletteEntries(input: PaletteInput): PaletteEntry[] {
  const { tabs, active, favorites, schemas, saved = {}, snippets = [], appearance, colorOf, mod } = input;
  const entries: PaletteEntry[] = [];
  const front = tabs.find((t) => t.sid === active);
  // A restored tab still waiting for its session has no workspace: an intent sent to its placeholder
  // id would never apply (the tab gets a new sid once connected), so the workspace actions below
  // (snippets, Go to…, Refresh schema, Search history…) are offered only for a connected server.
  const workspace = front?.restore ? undefined : front;

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
      const detail = tabs.length > 1 ? t.nickname : q.chart ? `${q.chart.type} chart` : undefined;
      entries.push({
        id: `run-saved:${t.sid}:${q.id}`,
        group: 'saved',
        label: `Run saved query: ${q.name}`,
        match: q.name,
        detail,
        keywords: ['run', 'execute', 'saved', 'query', t.nickname],
        icon: 'run',
        searchOnly: true,
        run: { kind: 'run-saved', sid: t.sid, query: q },
      });
      entries.push({
        id: `saved:${t.sid}:${q.id}`,
        group: 'saved',
        label: q.name,
        detail,
        keywords: ['saved', 'query', q.chart ? 'chart' : 'sql', t.nickname],
        icon: q.chart ? 'saved-chart' : 'saved',
        run: { kind: 'open-saved', sid: t.sid, query: q },
      });
    }
  }

  if (workspace) {
    for (const s of snippets) {
      entries.push({
        id: `snippet:${s.id}`,
        group: 'snippets',
        label: `Insert snippet: ${s.name}`,
        match: s.name,
        detail: firstLine(s.body),
        keywords: ['insert', 'snippet', 'paste', 'sql'],
        icon: 'snippet',
        searchOnly: true,
        run: { kind: 'insert-sql', sid: workspace.sid, text: s.body },
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
          searchOnly: true,
          run: { kind: 'open-table', sid: t.sid, ref: { schema: r.schema, name: r.name } },
        });
      }
    }
  }

  if (workspace) {
    for (const w of workspaceTabs) {
      entries.push({
        id: `action:tab:${w.tab}`,
        group: 'actions',
        label: `Go to ${w.label}`,
        detail: workspace.nickname,
        keywords: [w.tab, 'tab', 'go'],
        icon: w.icon,
        run: { kind: 'tab', sid: workspace.sid, tab: w.tab },
      });
    }
    entries.push({
      id: 'action:refresh-schema',
      group: 'actions',
      label: 'Refresh schema',
      detail: workspace.nickname,
      keywords: ['reload', 'introspect', 'catalog'],
      icon: 'refresh',
      run: { kind: 'refresh-schema', sid: workspace.sid },
    });
    entries.push({
      id: 'action:search-history',
      group: 'actions',
      label: 'Search history…',
      detail: workspace.nickname,
      keywords: ['history', 'runs', 'past', 'find', 'previous'],
      icon: 'history',
      run: { kind: 'search-history', sid: workspace.sid },
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
  entries.push({
    id: 'action:settings',
    group: 'actions',
    label: 'Settings…',
    keywords: ['preferences', 'options', 'page size', 'rows per page', 'timeout', 'updates'],
    icon: 'settings',
    shortcut: `${mod},`,
    run: { kind: 'settings' },
  });
  entries.push({
    id: 'action:check-updates',
    group: 'actions',
    label: 'Check for Updates',
    keywords: ['update', 'version', 'release', 'new', 'upgrade'],
    icon: 'update',
    run: { kind: 'check-updates' },
  });
  return entries;
}
