import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useCallback, useEffect, useReducer, useRef } from 'react';
import { toast } from 'sonner';
import { emptyGridLayout, type GridLayout, type TableRef } from '@kleos/shared';
import { api, errorText, queryKeys } from '@/lib/api';

/** How long the grid waits for a remembered layout before drawing the natural one. */
export const LAYOUT_HOLD_MS = 300;
/** Quiet time after a reorder or resize before the layout is saved. */
export const LAYOUT_SAVE_DELAY_MS = 500;

/**
 * Which layout the grid draws, so columns never jump under the user:
 * - until the remembered layout loads (for at most LAYOUT_HOLD_MS) nothing is drawn;
 * - a layout that loads within the hold is the first paint;
 * - one that loads later replaces the natural layout only while the user has not touched
 *   the grid (scrolled, resized or reordered); otherwise the user's state stays;
 * - the user's own changes always win.
 */
export type LayoutGate = {
  /** The grid may draw. */
  ready: boolean;
  layout: GridLayout;
  /** The remembered layout is in (or failed to load): later answers change nothing. */
  settled: boolean;
  /** The user scrolled, resized or reordered since the grid was drawn. */
  touched: boolean;
};

export type LayoutGateEvent =
  /** The remembered layout loaded (null: loading failed, keep the natural layout). */
  | { type: 'loaded'; layout: GridLayout | null }
  | { type: 'holdExpired' }
  /** Scroll, or a resize or drag that started. */
  | { type: 'touched' }
  /** The user's own reorder or resize. */
  | { type: 'changed'; layout: GridLayout };

export const initialLayoutGate: LayoutGate = { ready: false, layout: emptyGridLayout, settled: false, touched: false };

export function layoutGate(state: LayoutGate, event: LayoutGateEvent): LayoutGate {
  switch (event.type) {
    case 'loaded': {
      if (state.settled) return state;
      const keep = state.touched || event.layout === null;
      return { ...state, ready: true, settled: true, layout: keep ? state.layout : event.layout! };
    }
    case 'holdExpired':
      return state.ready ? state : { ...state, ready: true };
    case 'touched':
      // Nothing is drawn before `ready`, so there is nothing to protect yet.
      return state.touched || !state.ready ? state : { ...state, touched: true };
    case 'changed':
      return { ready: true, settled: true, touched: true, layout: event.layout };
  }
}

export type PersistedGridLayout = {
  /** The layout to draw (empty when none was remembered, or loading failed). */
  layout: GridLayout;
  /** False while the remembered layout is still loading, for at most LAYOUT_HOLD_MS. */
  ready: boolean;
  /** Applies a new layout at once and saves it after LAYOUT_SAVE_DELAY_MS of quiet. */
  change(next: GridLayout): void;
  /** The user scrolled or started a resize or drag: a late remembered layout must not apply. */
  touch(): void;
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
  // A cached layout (the table was open before) is drawn at once.
  const [gate, dispatch] = useReducer(layoutGate, loaded.data, (cached) =>
    cached ? { ready: true, settled: true, touched: false, layout: cached } : initialLayoutGate,
  );

  const { settled, ready } = gate;
  useEffect(() => {
    if (settled) return;
    if (loaded.isSuccess) dispatch({ type: 'loaded', layout: loaded.data });
    else if (loaded.isError) dispatch({ type: 'loaded', layout: null });
  }, [settled, loaded.isSuccess, loaded.isError, loaded.data]);
  useEffect(() => {
    if (ready) return;
    const t = setTimeout(() => dispatch({ type: 'holdExpired' }), LAYOUT_HOLD_MS);
    return () => clearTimeout(t);
  }, [ready]);

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
      dispatch({ type: 'changed', layout: next });
      queryClient.setQueryData(queryKeys.gridLayout(connectionId, schema, name), next);
      unsaved.current = next;
      if (timer.current) clearTimeout(timer.current);
      timer.current = setTimeout(flush, LAYOUT_SAVE_DELAY_MS);
    },
    [queryClient, connectionId, schema, name, flush],
  );
  // Scroll fires often; the reducer returns the same state after the first one, so React skips the render.
  const touch = useCallback(() => dispatch({ type: 'touched' }), []);

  return { layout: gate.layout, ready: gate.ready, change, touch };
}
