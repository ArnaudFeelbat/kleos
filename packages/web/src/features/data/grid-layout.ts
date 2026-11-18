import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useCallback, useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';
import { emptyGridLayout, type GridLayout, type TableRef } from '@kleos/shared';
import { api, errorText, queryKeys } from '@/lib/api';

/** How long the grid waits for a remembered layout before drawing the natural one. */
export const LAYOUT_HOLD_MS = 400;
/** Quiet time after a reorder or resize before the layout is saved. */
export const LAYOUT_SAVE_DELAY_MS = 500;

export type PersistedGridLayout = {
  /** The remembered layout (empty when none, or when loading failed). */
  layout: GridLayout;
  /** False while the remembered layout is still loading, for at most LAYOUT_HOLD_MS. */
  ready: boolean;
  /** Applies a new layout at once and saves it after LAYOUT_SAVE_DELAY_MS of quiet. */
  change(next: GridLayout): void;
};

/**
 * Column order and widths of one table, remembered per connection by the server. Loading
 * failures fall back to the natural layout silently; a failed save says so once.
 */
export function usePersistedGridLayout(connectionId: string, table: TableRef): PersistedGridLayout {
  const queryClient = useQueryClient();
  const { schema, name } = table;
  const loaded = useQuery({
    queryKey: queryKeys.gridLayout(connectionId, schema, name),
    queryFn: () => api.getGridLayout(connectionId, schema, name),
    staleTime: Infinity,
    retry: false,
  });
  const [local, setLocal] = useState<GridLayout | null>(null);
  const [waited, setWaited] = useState(false);
  const pending = loaded.isPending;
  useEffect(() => {
    if (!pending) return;
    const t = setTimeout(() => setWaited(true), LAYOUT_HOLD_MS);
    return () => clearTimeout(t);
  }, [pending]);

  const unsaved = useRef<GridLayout | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const flush = useCallback(() => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
    const next = unsaved.current;
    unsaved.current = null;
    if (!next) return;
    api.saveGridLayout(connectionId, schema, name, next).catch((err: unknown) => {
      toast.error(`Couldn’t remember the column layout: ${errorText(err)}`, { id: 'grid-layout-save' });
    });
  }, [connectionId, schema, name]);
  // Leaving the table (or the app tab) saves what is still waiting.
  useEffect(() => flush, [flush]);

  const change = useCallback(
    (next: GridLayout) => {
      setLocal(next);
      queryClient.setQueryData(queryKeys.gridLayout(connectionId, schema, name), next);
      unsaved.current = next;
      if (timer.current) clearTimeout(timer.current);
      timer.current = setTimeout(flush, LAYOUT_SAVE_DELAY_MS);
    },
    [queryClient, connectionId, schema, name, flush],
  );

  return { layout: local ?? loaded.data ?? emptyGridLayout, ready: !pending || waited, change };
}
