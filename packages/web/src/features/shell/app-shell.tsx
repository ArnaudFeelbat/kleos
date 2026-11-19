import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Database, Lock, Plus, Search, X } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { connectionColorSwatch } from '@/features/connections/colors';
import { ConnectProvider } from '@/features/connections/connect-context';
import { ConnectionsScreen } from '@/features/connections/connections-screen';
import { WorkspaceScreen } from '@/features/workspace/workspace-screen';
import { api, errorText, queryKeys } from '@/lib/api';
import { cn } from '@/lib/utils';
import { CommandPalette } from './command-palette';
import { RestoredTab } from './restored-tab';
import { HOME, tabsStore, useTabs, type ConnectionTab } from './tabs-store';
import { useWindowRestore } from './use-window-restore';
import { dropRestore } from './window-state';

const isMac = typeof navigator !== 'undefined' && /Mac/.test(navigator.platform);
const mod = isMac ? '⌘' : 'Ctrl+';

/**
 * The single Kleos window: a title bar holding the Connections tab and one tab per
 * connected server, and below it every workspace — all stay mounted, only the front one
 * is shown, so each keeps its query tabs, staged edits and diagram while hidden.
 */
export function AppShell() {
  const { tabs, active } = useTabs();
  const queryClient = useQueryClient();
  const favorites = useQuery({ queryKey: queryKeys.connections, queryFn: api.listConnections });
  const [paletteOpen, setPaletteOpen] = useState(false);

  useWindowRestore(favorites.data, favorites.isError);

  useEffect(() => {
    if (favorites.data) tabsStore.syncConnections(favorites.data);
  }, [favorites.data]);

  const front = tabs.find((t) => t.sid === active);
  useEffect(() => {
    window.kleos?.setTitle(front ? `${front.nickname} — Kleos` : 'Kleos');
  }, [front]);

  const closeTab = useCallback(
    (sid: string) => {
      const tab = tabsStore.get().tabs.find((t) => t.sid === sid);
      if (!tab || !tabsStore.close(sid)) return;
      // A restored tab that never connected has no session, only the tabs it was keeping.
      if (tab.restore) {
        dropRestore(tab.connectionId);
        return;
      }
      void api.closeSession(sid).catch(() => undefined);
      queryClient.removeQueries({ predicate: (q) => q.queryKey.includes(sid) });
    },
    [queryClient],
  );

  // Menu shortcuts arrive from the main process (⌘K, ⌘T, ⌘W, ⌘1…9, ⌘⇧[ and ⌘⇧]).
  useEffect(() => {
    return window.kleos?.onCommand((command) => {
      const state = tabsStore.get();
      if (command === 'palette') setPaletteOpen((open) => !open);
      else if (command === 'new-tab') tabsStore.activate(HOME);
      else if (command === 'close-tab') {
        if (state.active === HOME) window.kleos?.closeWindow();
        else closeTab(state.active);
      } else if (command === 'next-tab') tabsStore.activateRelative(1);
      else if (command === 'prev-tab') tabsStore.activateRelative(-1);
      else if (command.startsWith('select-tab-')) tabsStore.activateIndex(Number(command.slice(11)));
    });
  }, [closeTab]);

  return (
    <ConnectProvider>
      <div className="bg-pane text-foreground flex h-full flex-col">
        <header className="app-drag flex h-10 shrink-0 items-center gap-1 pr-3 pl-[78px]">
          <nav
            aria-label="Open connections"
            className="flex min-w-0 flex-1 items-center gap-1 overflow-x-auto [scrollbar-width:none]"
          >
            <Tooltip>
              <TooltipTrigger asChild>
                <button
                  type="button"
                  aria-label="Connections"
                  aria-current={active === HOME ? 'page' : undefined}
                  onClick={() => tabsStore.activate(HOME)}
                  className={cn(
                    'flex h-7 shrink-0 items-center gap-1.5 rounded-md px-2 text-[12.5px] font-medium',
                    active === HOME
                      ? 'bg-background text-foreground shadow-[0_0_0_1px_var(--edge),var(--elev-1)]'
                      : 'text-muted-foreground hover:text-foreground hover:bg-black/[0.05] dark:hover:bg-white/[0.06]',
                  )}
                >
                  <Database className={cn('size-3.5', active === HOME && 'text-brand-text')} aria-hidden="true" />
                  {tabs.length === 0 && <span>Connections</span>}
                </button>
              </TooltipTrigger>
              <TooltipContent>Connections ({mod}T)</TooltipContent>
            </Tooltip>
            {tabs.length > 0 && <span className="bg-foreground/10 mx-1 h-4 w-px shrink-0" aria-hidden="true" />}
            {tabs.map((tab, i) => (
              <ConnectionTabButton
                key={tab.sid}
                tab={tab}
                index={i}
                active={tab.sid === active}
                onSelect={() => tabsStore.activate(tab.sid)}
                onClose={() => closeTab(tab.sid)}
              />
            ))}
            <Tooltip>
              <TooltipTrigger asChild>
                <button
                  type="button"
                  aria-label="Open another connection"
                  onClick={() => tabsStore.activate(HOME)}
                  className="text-muted-foreground hover:text-foreground flex size-7 shrink-0 items-center justify-center rounded-md hover:bg-black/[0.05] dark:hover:bg-white/[0.06]"
                >
                  <Plus className="size-4" aria-hidden="true" />
                </button>
              </TooltipTrigger>
              <TooltipContent>Open another connection ({mod}T)</TooltipContent>
            </Tooltip>
          </nav>
          <button
            type="button"
            onClick={() => setPaletteOpen(true)}
            aria-label="Open the command palette"
            className="text-muted-foreground hover:text-foreground mr-1 flex h-7 shrink-0 items-center gap-2 rounded-md bg-black/[0.035] pr-1.5 pl-2.5 text-[12px] shadow-[inset_0_0_0_1px_var(--edge)] hover:bg-black/[0.06] dark:bg-white/[0.05] dark:hover:bg-white/[0.08]"
          >
            <Search className="size-3.5" aria-hidden="true" />
            <span>Search</span>
            <kbd className="bg-background/70 text-muted-foreground rounded-[4px] px-1.5 py-px font-mono text-[10.5px] shadow-[0_0_0_1px_var(--edge)]">
              {mod}K
            </kbd>
          </button>
          <HealthIndicator />
        </header>

        <div className={cn('min-h-0 flex-1', active === HOME ? 'flex' : 'hidden')}>
          <ConnectionsScreen />
        </div>
        {tabs.map((tab) => (
          <div key={tab.sid} className={cn('min-h-0 flex-1', active === tab.sid ? 'flex' : 'hidden')}>
            {tab.restore ? (
              <RestoredTab
                tab={tab}
                favorite={favorites.data?.find((f) => f.id === tab.connectionId)}
                onClose={() => closeTab(tab.sid)}
              />
            ) : (
              <WorkspaceScreen sid={tab.sid} visible={active === tab.sid} onClose={() => closeTab(tab.sid)} />
            )}
          </div>
        ))}
      </div>
      <CommandPalette open={paletteOpen} onOpenChange={setPaletteOpen} onCloseTab={closeTab} />
    </ConnectProvider>
  );
}

function ConnectionTabButton({
  tab,
  index,
  active,
  onSelect,
  onClose,
}: {
  tab: ConnectionTab;
  index: number;
  active: boolean;
  onSelect: () => void;
  onClose: () => void;
}) {
  const dot = tab.color === 'none' ? null : connectionColorSwatch[tab.color];
  return (
    <div
      className={cn(
        'group relative flex h-7 max-w-[220px] min-w-[96px] shrink items-center rounded-md',
        active
          ? 'bg-background text-foreground shadow-[0_0_0_1px_var(--edge),var(--elev-1)]'
          : 'text-muted-foreground hover:text-foreground hover:bg-black/[0.05] dark:hover:bg-white/[0.06]',
      )}
    >
      <button
        type="button"
        aria-current={active ? 'page' : undefined}
        title={index < 9 ? `${tab.nickname} (${mod}${index + 1})` : tab.nickname}
        onClick={onSelect}
        onAuxClick={(e) => {
          if (e.button === 1) onClose();
        }}
        className="flex h-full min-w-0 flex-1 items-center gap-2 rounded-md pr-7 pl-2.5 text-left text-[12.5px] font-medium"
      >
        <span
          aria-hidden="true"
          className={cn(
            'size-2 shrink-0 rounded-full',
            !dot && 'border-muted-foreground/60 border border-dashed',
            // A restored tab without a session yet: the dot fades until it connects.
            tab.restore && 'opacity-40',
          )}
          style={dot ? { background: dot, boxShadow: `0 0 0 3px ${dot}22` } : undefined}
        />
        <span className="truncate">{tab.nickname}</span>
        {tab.readOnly && <Lock className="text-muted-foreground size-3 shrink-0" aria-label="Read-only" />}
      </button>
      <button
        type="button"
        aria-label={`Close ${tab.nickname}`}
        onClick={onClose}
        className={cn(
          'text-muted-foreground hover:text-foreground absolute right-1 flex size-5 items-center justify-center rounded-[4px] hover:bg-black/[0.07] dark:hover:bg-white/[0.1]',
          active ? 'opacity-100' : 'opacity-0 group-hover:opacity-100 focus-visible:opacity-100',
        )}
      >
        <X className="size-3" aria-hidden="true" />
      </button>
    </div>
  );
}

/** A quiet dot for the local server; its text (read by the smoke test) is for screen readers and the tooltip. */
function HealthIndicator() {
  const health = useQuery({ queryKey: queryKeys.health, queryFn: api.health });
  const label = health.isPending
    ? 'Checking the local server…'
    : health.isError
      ? `Server unreachable: ${errorText(health.error)}`
      : `Server ok · v${health.data.version}`;
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span data-testid="health" role="status" className="flex size-6 shrink-0 items-center justify-center">
          <span
            aria-hidden="true"
            className={cn(
              'size-1.5 rounded-full',
              health.isSuccess && 'bg-success shadow-[0_0_0_3px_color-mix(in_srgb,var(--success)_20%,transparent)]',
              health.isError && 'bg-destructive',
              health.isPending && 'bg-muted-foreground',
            )}
          />
          <span className="sr-only">{label}</span>
        </span>
      </TooltipTrigger>
      <TooltipContent>{label}</TooltipContent>
    </Tooltip>
  );
}
