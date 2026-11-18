import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { api, errorText, queryKeys } from '@/lib/api';
import { ConnectionForm } from './connection-form';
import { FavoritesList } from './favorites-list';
import { useConnectActions } from './connect-context';

/** `undefined` = nothing picked yet: show the first favorite, or a new form when there is none. */
type Selection = { kind: 'new' } | { kind: 'saved'; id: string } | undefined;

/**
 * The Connections tab: favorites on the translucent pane, the login form for the selected
 * favorite in a raised panel. Connecting opens the server in its own window tab.
 */
export function ConnectionsScreen() {
  const favorites = useQuery({ queryKey: queryKeys.connections, queryFn: api.listConnections });
  const [selection, setSelection] = useState<Selection>(undefined);
  const { connect, connectingId } = useConnectActions();

  const list = favorites.data ?? [];
  const selectedId =
    selection?.kind === 'saved' ? selection.id : selection === undefined ? (list[0]?.id ?? null) : null;
  const saved = selectedId ? (list.find((f) => f.id === selectedId) ?? null) : null;
  // A just-created favorite may not be in the refetched list yet; wait for it instead of showing a blank form.
  const waitingForList = selection?.kind === 'saved' && !saved && favorites.isFetching;

  return (
    <div className="flex min-h-0 flex-1">
      <FavoritesList
        favorites={favorites.data}
        loading={favorites.isPending}
        error={favorites.isError ? `Could not load favorites: ${errorText(favorites.error)}` : null}
        selectedId={selectedId}
        onSelect={(id) => setSelection({ kind: 'saved', id })}
        onConnect={(id) => {
          const target = list.find((f) => f.id === id);
          if (target) void connect(target);
        }}
        onNew={() => setSelection({ kind: 'new' })}
      />
      <main className="bg-sidebar dark:bg-background flex min-w-0 flex-1 items-start justify-center overflow-y-auto rounded-tl-[10px] px-6 py-12 shadow-[0_0_0_1px_var(--edge),var(--elev-1)]">
        {favorites.isPending || waitingForList ? null : (
          <ConnectionForm
            key={saved?.id ?? 'new'}
            saved={saved}
            connecting={saved !== null && connectingId === saved.id}
            onSaved={(s) => setSelection({ kind: 'saved', id: s.id })}
            onDeleted={() => setSelection(undefined)}
            onConnect={connect}
          />
        )}
      </main>
    </div>
  );
}
