import type { SavedConnection } from '@kleos/shared';
import { useEffect, useState } from 'react';
import { api } from '@/lib/api';
import { loadSettings } from '@/lib/settings';
import { persistWindowState, placeRestoredTabs, reconnectRestored } from './window-state';

/** Once per page load: StrictMode and remounts must not restore the window twice. */
let started = false;

/**
 * On launch, reopens the servers of the last window (once the favorites are known) and from
 * then on saves the window state as it changes. Saving starts only after the restore has
 * placed its tabs, so an empty window at launch never overwrites the saved one.
 */
export function useWindowRestore(favorites: SavedConnection[] | undefined, favoritesFailed: boolean): void {
  const [ready, setReady] = useState(false);

  useEffect(() => {
    if (started || (!favorites && !favoritesFailed)) return;
    started = true;
    Promise.resolve()
      .then(() => api.getWindowState())
      .then((state) => {
        if (!favorites) return;
        const servers = placeRestoredTabs(state, favorites);
        void reconnectRestored(
          servers,
          state.activeConnectionId,
          async (connectionId) =>
            api.openSession({ connectionId, statementTimeoutSeconds: (await loadSettings()).queryTimeoutSeconds }),
          (sid) => void api.closeSession(sid).catch(() => undefined),
        );
      })
      .catch(() => undefined)
      .finally(() => setReady(true));
  }, [favorites, favoritesFailed]);

  useEffect(() => {
    if (!ready) return;
    return persistWindowState((state) => api.saveWindowState(state));
  }, [ready]);
}

/** Tests only. */
export function resetWindowRestore(): void {
  started = false;
}
