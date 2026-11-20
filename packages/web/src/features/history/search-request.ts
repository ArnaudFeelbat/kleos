import { useSyncExternalStore } from 'react';

/**
 * "Search history…" from ⌘K: asks the Query tab of one server to show its side panel on History
 * with the search field focused. A pending request waits here until the side panel takes it, so
 * it also works when the panel was hidden: the Query tab shows the panel while a request is
 * pending, and the panel takes it once mounted.
 */
const pending = new Map<string, number>();
const listeners = new Set<() => void>();
let counter = 0;

function notify() {
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function requestHistorySearch(sid: string): void {
  counter += 1;
  pending.set(sid, counter);
  notify();
}

/** The pending request for `sid` (a nonce), if any. */
export function useHistorySearchRequest(sid: string): number | undefined {
  return useSyncExternalStore(subscribe, () => pending.get(sid));
}

/** Marks the request handled (only that one: a newer request stays pending). */
export function takeHistorySearchRequest(sid: string, nonce: number): void {
  if (pending.get(sid) !== nonce) return;
  pending.delete(sid);
  notify();
}

/** Tests only. */
export function resetHistorySearchRequests(): void {
  pending.clear();
  counter = 0;
}
