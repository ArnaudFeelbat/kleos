import { useCallback, useSyncExternalStore } from 'react';
import { defaultSettings, type SortKey } from '@kleos/shared';
import type { FilterChip } from './filters';
import { emptyStage, type StageState } from './staging';

/** Everything the Data tab remembers per table: view settings and staged edits. */
export type TableViewState = {
  sort: SortKey[];
  chips: FilterChip[];
  /** Applied raw WHERE condition (the box keeps its own draft until Enter). */
  where: string;
  /** Zero-based page, counted in `pageSize` rows. */
  page: number;
  /** Rows per page `page` was counted in (Settings › Rows per page); unset while on page 1. */
  pageSize?: number;
  stage: StageState;
};

export const initialTableView: TableViewState = { sort: [], chips: [], where: '', page: 0, stage: emptyStage };

/**
 * Module-level store keyed by session and table, so filters, paging and staged edits
 * survive switching tables, workspace tabs, or following a foreign key and coming back.
 */
const states = new Map<string, TableViewState>();
const listeners = new Set<() => void>();

const storeKey = (sid: string, tableKey: string) => `${sid}\u0000${tableKey}`;

export function getTableView(sid: string, tableKey: string): TableViewState {
  return states.get(storeKey(sid, tableKey)) ?? initialTableView;
}

export function updateTableView(sid: string, tableKey: string, fn: (s: TableViewState) => TableViewState): void {
  const key = storeKey(sid, tableKey);
  const prev = states.get(key) ?? initialTableView;
  const next = fn(prev);
  if (next === prev) return;
  states.set(key, next);
  for (const l of listeners) l();
}

/** Drops every table state of a session (tests, disconnect). */
export function resetTableViews(sid?: string): void {
  if (sid === undefined) states.clear();
  else for (const k of [...states.keys()]) if (k.startsWith(`${sid}\u0000`)) states.delete(k);
  for (const l of listeners) l();
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function useTableView(
  sid: string,
  tableKey: string,
): [TableViewState, (fn: (s: TableViewState) => TableViewState) => void] {
  const state = useSyncExternalStore(subscribe, () => getTableView(sid, tableKey));
  const update = useCallback(
    (fn: (s: TableViewState) => TableViewState) => updateTableView(sid, tableKey, fn),
    [sid, tableKey],
  );
  return [state, update];
}

/** Click on a header: plain click sorts by that column alone (asc, desc, off); Shift adds or cycles it in a multi-sort. */
export function nextSort(sort: readonly SortKey[], column: string, multi: boolean): SortKey[] {
  const current = sort.find((s) => s.column === column);
  const cycled: SortKey | null = !current
    ? { column, dir: 'asc' }
    : current.dir === 'asc'
      ? { column, dir: 'desc' }
      : null;
  if (!multi) return cycled ? [cycled] : [];
  if (!current) return [...sort, cycled!];
  return cycled ? sort.map((s) => (s.column === column ? cycled : s)) : sort.filter((s) => s.column !== column);
}

/** "1204380" -> "1,204,380" without converting to a JavaScript number. */
export function groupDigits(text: string): string {
  const m = /^(-?)(\d+)$/.exec(text.trim());
  if (!m) return text;
  return `${m[1]}${m[2]!.replace(/\B(?=(\d{3})+(?!\d))/g, ',')}`;
}

/** The page to show: the remembered one, or page 1 when it was counted in another page size. */
export function pageIndexFor(view: Pick<TableViewState, 'page' | 'pageSize'>, pageSize: number): number {
  return view.page > 0 && view.pageSize !== pageSize ? 0 : view.page;
}

/** Number of pages for a row count given as text; null when unknown (negative estimate). */
export function pageCount(count: string, pageSize: number = defaultSettings.pageSize): string | null {
  if (!/^\d+$/.test(count.trim())) return null;
  const n = BigInt(count.trim());
  const size = BigInt(pageSize);
  const pages = (n + size - 1n) / size;
  return (pages === 0n ? 1n : pages).toString();
}
