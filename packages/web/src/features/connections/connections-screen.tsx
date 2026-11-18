import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { api, errorText, queryKeys } from '@/lib/api';
import { cn } from '@/lib/utils';
import { ConnectionForm } from './connection-form';
import { FavoritesList } from './favorites-list';
import { PasswordDialog } from './password-dialog';
import { useConnect } from './use-connect';

/** `undefined` = nothing picked yet: show the first favorite, or a new form when there is none. */
type Selection = { kind: 'new' } | { kind: 'saved'; id: string } | undefined;

/** Start window: favorites list on the left, login form for the selected favorite on the right. */
export function ConnectionsScreen() {
  const favorites = useQuery({ queryKey: queryKeys.connections, queryFn: api.listConnections });
  const [selection, setSelection] = useState<Selection>(undefined);
  const { connect, connectingId, prompt, submitPassword, cancelPrompt } = useConnect();

  const list = favorites.data ?? [];
  const selectedId =
    selection?.kind === 'saved' ? selection.id : selection === undefined ? (list[0]?.id ?? null) : null;
  const saved = selectedId ? (list.find((f) => f.id === selectedId) ?? null) : null;
  // A just-created favorite may not be in the refetched list yet; wait for it instead of showing a blank form.
  const waitingForList = selection?.kind === 'saved' && !saved && favorites.isFetching;

  return (
    <div className="flex h-full flex-col">
      <header className="app-drag bg-chrome flex h-10 shrink-0 items-center gap-3 border-b pr-3.5 pl-20">
        <div className="flex-1 text-center font-semibold">Kleos</div>
        <HealthIndicator />
      </header>
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
        <main className="bg-background flex min-w-0 flex-1 items-start justify-center overflow-y-auto px-6 py-10">
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
      <PasswordDialog
        prompt={prompt}
        onSubmit={(password, remember) => void submitPassword(password, remember)}
        onCancel={cancelPrompt}
      />
    </div>
  );
}

/** Small, unobtrusive local-server status; the smoke test reads its text. */
function HealthIndicator() {
  const health = useQuery({ queryKey: queryKeys.health, queryFn: api.health });
  return (
    <span data-testid="health" className="text-muted-foreground flex items-center gap-1.5 text-xs">
      <span
        aria-hidden="true"
        className={cn(
          'size-1.5 rounded-full',
          health.isSuccess && 'bg-success',
          health.isError && 'bg-destructive',
          health.isPending && 'bg-muted-foreground',
        )}
      />
      {health.isPending && 'Checking server…'}
      {health.isError && `Server unreachable: ${errorText(health.error)}`}
      {health.isSuccess && `Server ok · v${health.data.version}`}
    </span>
  );
}
