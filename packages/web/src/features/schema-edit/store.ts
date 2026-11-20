import { useMemo, useSyncExternalStore } from 'react';
import { tableKey, type DdlChange } from '@kleos/shared';

/** One staged schema change; `id` survives edits so the list and the panel can address it. */
export type StagedDdl = { id: string; change: DdlChange };

/** Why the last apply failed. Nothing was applied; the changes stay staged. */
export type DdlFailure = {
  /** The staged change whose statement failed, when the server named it (statementIndex). */
  changeId: string | null;
  /** The SQL of that statement, from the preview of the same list. */
  statement: string | null;
  code: string;
  message: string;
  detail?: string;
  hint?: string;
};

export type SchemaEditState = { changes: StagedDdl[]; failure: DdlFailure | null };

export const emptySchemaEdit: SchemaEditState = { changes: [], failure: null };

export type SchemaEditAction =
  /** Appends a change; a later setting of the same column (NULL, default, type) replaces the earlier one. */
  | { type: 'stage'; id: string; change: DdlChange }
  | { type: 'update'; id: string; change: DdlChange }
  | { type: 'remove'; id: string }
  | { type: 'discard' }
  | { type: 'failed'; failure: DdlFailure };

/** Changes that set one property of one column: staging the same setting again replaces it. */
function settingKey(change: DdlChange): string | null {
  switch (change.op) {
    case 'setNotNull':
    case 'setDefault':
    case 'alterColumnType':
      return `${change.op}\u0000${tableKey(change.table)}\u0000${change.column}`;
    default:
      return null;
  }
}

/**
 * Staged schema changes of one session. Every change to the list clears a previous failure,
 * since the batch it described no longer exists.
 */
export function schemaEditReducer(state: SchemaEditState, action: SchemaEditAction): SchemaEditState {
  switch (action.type) {
    case 'stage': {
      const key = settingKey(action.change);
      // The newer setting goes last, after anything staged in between (a rename, a type change).
      const kept = key === null ? state.changes : state.changes.filter((c) => settingKey(c.change) !== key);
      return { changes: [...kept, { id: action.id, change: action.change }], failure: null };
    }
    case 'update':
      return {
        changes: state.changes.map((c) => (c.id === action.id ? { ...c, change: action.change } : c)),
        failure: null,
      };
    case 'remove':
      return { changes: state.changes.filter((c) => c.id !== action.id), failure: null };
    case 'discard':
      return emptySchemaEdit;
    case 'failed':
      return { ...state, failure: action.failure };
  }
}

/**
 * Module-level store keyed by session, so staged schema changes survive switching workspace
 * tabs (and connection tabs) until they are applied or discarded.
 */
const states = new Map<string, SchemaEditState>();
const listeners = new Set<() => void>();
let nextId = 0;

export function getSchemaEdit(sid: string): SchemaEditState {
  return states.get(sid) ?? emptySchemaEdit;
}

export function dispatchSchemaEdit(sid: string, action: SchemaEditAction): void {
  const prev = getSchemaEdit(sid);
  const next = schemaEditReducer(prev, action);
  if (next === prev) return;
  states.set(sid, next);
  for (const l of listeners) l();
}

/** Drops the staged changes of a session, or of every session (tests, disconnect). */
export function resetSchemaEdits(sid?: string): void {
  if (sid === undefined) states.clear();
  else states.delete(sid);
  for (const l of listeners) l();
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export type SchemaEditActions = {
  stage(change: DdlChange): void;
  update(id: string, change: DdlChange): void;
  remove(id: string): void;
  discard(): void;
  fail(failure: DdlFailure): void;
};

export function useSchemaEdit(sid: string): [SchemaEditState, SchemaEditActions] {
  const state = useSyncExternalStore(subscribe, () => getSchemaEdit(sid));
  const actions = useMemo<SchemaEditActions>(() => {
    const send = (action: SchemaEditAction) => dispatchSchemaEdit(sid, action);
    return {
      stage: (change) => send({ type: 'stage', id: `ddl-${++nextId}`, change }),
      update: (id, change) => send({ type: 'update', id, change }),
      remove: (id) => send({ type: 'remove', id }),
      discard: () => send({ type: 'discard' }),
      fail: (failure) => send({ type: 'failed', failure }),
    };
  }, [sid]);
  return [state, actions];
}
