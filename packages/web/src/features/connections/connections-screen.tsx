import { useQuery } from '@tanstack/react-query';
import { api, errorText, queryKeys } from '@/lib/api';

/**
 * Start window: favorites list and login form.
 * PLACEHOLDER (milestone 1): shows the health check answered through the typed client.
 */
export function ConnectionsScreen() {
  const health = useQuery({ queryKey: queryKeys.health, queryFn: api.health });
  return (
    <div className="flex h-full flex-col">
      <header className="app-drag bg-chrome flex h-10 shrink-0 items-center justify-center border-b font-semibold">
        Kleos
      </header>
      <main className="flex flex-1 items-center justify-center">
        <p data-testid="health" className="text-muted-foreground">
          {health.isPending && 'Checking the local server…'}
          {health.isError && `Server unreachable: ${errorText(health.error)}`}
          {health.isSuccess && `Server ok · v${health.data.version}`}
        </p>
      </main>
    </div>
  );
}
