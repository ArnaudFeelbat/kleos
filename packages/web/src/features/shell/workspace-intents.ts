import { useSyncExternalStore } from 'react';
import type { SavedQuery, TableRef } from '@kleos/shared';
import type { WorkspaceTab } from '@/features/workspace/context';

/** Something the window (⌘K palette) asks one server's workspace to do. */
export type WorkspaceIntent =
  | { kind: 'open-table'; ref: TableRef; tab: 'data' | 'schema' }
  | { kind: 'tab'; tab: WorkspaceTab }
  | { kind: 'refresh-schema' }
  | { kind: 'open-saved'; query: SavedQuery }
  /**
   * Opens the saved query in a tab (as open-saved) and runs it at once; when it has parameters,
   * the parameter prompt opens prefilled with its paramValues so Enter runs it. (0.7)
   */
  | { kind: 'run-saved'; query: SavedQuery }
  /** Inserts text at the cursor of the query tab in front (switching to Query first). (0.7) */
  | { kind: 'insert-sql'; text: string };

export type PendingIntent = { intent: WorkspaceIntent; nonce: number };

const pending = new Map<string, PendingIntent>();
const listeners = new Set<() => void>();
let counter = 0;

/** Queues an intent for the workspace of `sid`; it applies it once (by nonce). */
export function requestWorkspace(sid: string, intent: WorkspaceIntent): void {
  counter += 1;
  pending.set(sid, { intent, nonce: counter });
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function useWorkspaceIntent(sid: string): PendingIntent | undefined {
  return useSyncExternalStore(subscribe, () => pending.get(sid));
}

/** Tests only. */
export function resetWorkspaceIntents(): void {
  pending.clear();
  counter = 0;
}
