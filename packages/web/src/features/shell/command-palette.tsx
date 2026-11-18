import { useQueries, useQuery } from '@tanstack/react-query';
import {
  Activity,
  Bookmark,
  ChartLine,
  Check,
  Code,
  Database,
  Eye,
  LayoutGrid,
  Monitor,
  Moon,
  Network,
  Plug,
  RefreshCw,
  Sun,
  Table2,
  X,
  type LucideIcon,
} from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import {
  CommandDialog,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  CommandShortcut,
} from '@/components/ui/command';
import { connectionColorSwatch } from '@/features/connections/colors';
import { useConnectActions } from '@/features/connections/connect-context';
import { api, queryKeys } from '@/lib/api';
import type { Appearance } from '@/lib/bridge';
import {
  buildPaletteEntries,
  paletteScore,
  type PaletteEntry,
  type PaletteGroup,
  type PaletteIcon,
} from './palette-model';
import { HOME, tabsStore, useTabs } from './tabs-store';
import { requestWorkspace } from './workspace-intents';

const isMac = typeof navigator !== 'undefined' && /Mac/.test(navigator.platform);
const mod = isMac ? '⌘' : 'Ctrl+';

const icons: Record<PaletteIcon, LucideIcon> = {
  server: Database,
  connection: Plug,
  table: Table2,
  view: Eye,
  saved: Bookmark,
  'saved-chart': ChartLine,
  schema: Network,
  data: Table2,
  query: Code,
  monitor: Activity,
  refresh: RefreshCw,
  home: LayoutGrid,
  close: X,
  system: Monitor,
  light: Sun,
  dark: Moon,
};

const groupTitles: Record<PaletteGroup, string> = {
  servers: 'Open servers',
  connections: 'Connect',
  saved: 'Saved queries',
  tables: 'Tables & views',
  actions: 'Actions',
};

type Props = {
  open: boolean;
  onOpenChange(open: boolean): void;
  /** Closes a server tab and its session (same path as the tab's close button). */
  onCloseTab(sid: string): void;
};

/**
 * ⌘K: jump to any open server, connect a favorite, open any table or view of any open
 * server, switch workspace tab, refresh the schema, close the tab or change appearance.
 */
export function CommandPalette({ open, onOpenChange, onCloseTab }: Props) {
  const { tabs, active } = useTabs();
  const { connect } = useConnectActions();
  const [search, setSearch] = useState('');
  const [appearance, setAppearance] = useState<Appearance | null>(null);

  const favorites = useQuery({ queryKey: queryKeys.connections, queryFn: api.listConnections, enabled: open });
  // Already cached by each workspace; staleTime keeps the palette from re-introspecting.
  const schemas = useQueries({
    queries: tabs.map((t) => ({
      queryKey: queryKeys.schema(t.sid),
      queryFn: () => api.schema(t.sid),
      staleTime: Infinity,
      enabled: open,
    })),
  });

  const savedQueries = useQueries({
    queries: tabs.map((t) => ({
      queryKey: queryKeys.savedQueries(t.connectionId),
      queryFn: () => api.savedQueries(t.connectionId),
      enabled: open,
    })),
  });

  useEffect(() => {
    if (!open) return;
    let live = true;
    window.kleos
      ?.getAppearance()
      .then((mode) => {
        if (live) setAppearance(mode);
      })
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, [open]);

  const entries = useMemo(
    () =>
      buildPaletteEntries({
        tabs,
        active,
        favorites: favorites.data ?? [],
        schemas: Object.fromEntries(tabs.map((t, i) => [t.sid, schemas[i]?.data])),
        saved: Object.fromEntries(tabs.map((t, i) => [t.sid, savedQueries[i]?.data])),
        appearance,
        colorOf: (color) => (color === 'none' ? undefined : connectionColorSwatch[color]),
        mod,
      }),
    [tabs, active, favorites.data, schemas, savedQueries, appearance],
  );

  // Tables only once something is typed: an empty palette stays a short list.
  const visible = search.trim() ? entries : entries.filter((e) => e.group !== 'tables');
  const groups = (['servers', 'connections', 'saved', 'tables', 'actions'] as const)
    .map((group) => ({ group, items: visible.filter((e) => e.group === group) }))
    .filter((g) => g.items.length > 0);

  /** Closing clears the search, so the palette always reopens on the short list. */
  function close() {
    setSearch('');
    onOpenChange(false);
  }

  function run(entry: PaletteEntry) {
    close();
    const r = entry.run;
    switch (r.kind) {
      case 'activate':
        tabsStore.activate(r.sid);
        break;
      case 'connect': {
        const favorite = favorites.data?.find((f) => f.id === r.connectionId);
        if (favorite) void connect(favorite);
        break;
      }
      case 'open-table':
        tabsStore.activate(r.sid);
        requestWorkspace(r.sid, { kind: 'open-table', ref: r.ref, tab: 'data' });
        break;
      case 'open-saved':
        tabsStore.activate(r.sid);
        requestWorkspace(r.sid, { kind: 'open-saved', query: r.query });
        break;
      case 'tab':
        tabsStore.activate(r.sid);
        requestWorkspace(r.sid, { kind: 'tab', tab: r.tab });
        break;
      case 'refresh-schema':
        requestWorkspace(r.sid, { kind: 'refresh-schema' });
        break;
      case 'home':
        tabsStore.activate(HOME);
        break;
      case 'close-tab':
        onCloseTab(r.sid);
        break;
      case 'appearance':
        window.kleos?.setAppearance(r.mode);
        break;
    }
  }

  return (
    <CommandDialog
      open={open}
      onOpenChange={(next) => (next ? onOpenChange(true) : close())}
      title="Command palette"
      description="Jump to a server, a table or an action"
      filter={paletteScore}
    >
      <CommandInput
        value={search}
        onValueChange={setSearch}
        placeholder="Search servers, tables, saved queries and actions…"
      />
      <CommandList>
        <CommandEmpty>Nothing matches “{search}”.</CommandEmpty>
        {groups.map(({ group, items }) => (
          <CommandGroup key={group} heading={groupTitles[group]}>
            {items.map((entry) => {
              const Icon = icons[entry.icon];
              return (
                <CommandItem
                  key={entry.id}
                  value={entry.id}
                  keywords={[entry.label, entry.detail ?? '', ...entry.keywords]}
                  onSelect={() => run(entry)}
                >
                  {entry.dot ? (
                    <span className="flex size-4 items-center justify-center" aria-hidden="true">
                      <span className="size-2 rounded-full" style={{ background: entry.dot }} />
                    </span>
                  ) : (
                    <Icon aria-hidden="true" />
                  )}
                  <span className="truncate">{entry.label}</span>
                  {entry.detail && (
                    <span className="text-muted-foreground min-w-0 truncate font-mono text-[11.5px]">
                      {entry.detail}
                    </span>
                  )}
                  {entry.checked && <Check className="text-brand-text ml-auto" aria-label="Current" />}
                  {entry.shortcut && !entry.checked && <CommandShortcut>{entry.shortcut}</CommandShortcut>}
                </CommandItem>
              );
            })}
          </CommandGroup>
        ))}
      </CommandList>
      <div className="text-muted-foreground flex items-center gap-4 border-t px-4 py-2 text-[11.5px]">
        <span>
          <kbd className="font-mono">↑↓</kbd> navigate
        </span>
        <span>
          <kbd className="font-mono">↵</kbd> open
        </span>
        <span>
          <kbd className="font-mono">esc</kbd> close
        </span>
        <span className="ml-auto">Type a table name to search every open server</span>
      </div>
    </CommandDialog>
  );
}
