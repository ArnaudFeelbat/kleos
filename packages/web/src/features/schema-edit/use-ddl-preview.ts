import type { DdlChange } from '@kleos/shared';
import { useQuery } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { api, ApiError, errorText } from '@/lib/api';

export const PREVIEW_DELAY_MS = 250;

/** The value, `delay` ms after it last changed (compared by JSON, since lists are rebuilt on every edit). */
function useDebouncedJson<T>(value: T, delay: number): { value: T; key: string } {
  const key = JSON.stringify(value);
  const [settled, setSettled] = useState({ value, key });
  useEffect(() => {
    if (key === settled.key) return;
    const timer = setTimeout(() => setSettled({ value, key }), delay);
    return () => clearTimeout(timer);
    // `value` is represented by `key`.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, delay, settled.key]);
  return settled;
}

export type DdlPreviewState = {
  /** The statements of the latest successful preview, one per change, possibly of an older list. */
  statements: string[] | null;
  /** True when `statements` belong to the current list. */
  current: boolean;
  /** True while a newer preview is pending or loading (show the previous SQL dimmed). */
  loading: boolean;
  /** The preview's failure: the change it names (statementIndex) and the server's message. */
  error: { index: number | null; text: string } | null;
};

/**
 * The exact SQL of the staged list, from POST /ddl/preview: debounced, re-fetched whenever the
 * list changes. The previous statements stay available while the next preview loads.
 */
export function useDdlPreview(sid: string, changes: DdlChange[]): DdlPreviewState {
  const settled = useDebouncedJson(changes, PREVIEW_DELAY_MS);
  const currentKey = JSON.stringify(changes);
  const query = useQuery({
    queryKey: ['ddl-preview', sid, settled.key],
    queryFn: () => api.previewDdl(sid, { changes: settled.value }),
    enabled: settled.value.length > 0,
    staleTime: Infinity,
    gcTime: 60_000,
    retry: false,
  });
  // Adjusted while rendering: the latest statements outlive the query that brought them.
  const [last, setLast] = useState<{ key: string; statements: string[] } | null>(null);
  if (query.data && last?.key !== settled.key) {
    setLast({ key: settled.key, statements: query.data.statements });
  }
  const settledNow = settled.key === currentKey;
  const err = query.error;
  return {
    statements: last?.statements ?? null,
    current: !!last && last.key === currentKey,
    loading: !settledNow || query.isFetching,
    error:
      err && settledNow
        ? {
            index: err instanceof ApiError ? (err.body.statementIndex ?? null) : null,
            text: errorText(err),
          }
        : null,
  };
}
