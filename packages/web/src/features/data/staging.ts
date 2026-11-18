import type { ApiErrorBody, CellValue, RowEdit, TableRef } from '@kleos/shared';

/** Primary-key column -> value of the row as loaded. */
export type RowKeyValues = Record<string, CellValue>;

export type StagedUpdate = {
  /** Identity of the row: its primary-key values, serialized (see rowKeyOf). */
  rowKey: string;
  key: RowKeyValues;
  /** Column -> new value, in the order the user changed them. */
  set: Record<string, CellValue>;
  /** Column -> value before the change, for "was" hints and the review SQL. */
  was: Record<string, CellValue>;
};

export type StagedInsert = {
  id: string;
  /** Only the columns given are inserted; absent columns take their DEFAULT. */
  values: Record<string, CellValue>;
};

export type StagedDelete = { rowKey: string; key: RowKeyValues };

/** The staged item an edit (and so a failing editIndex) came from. */
export type StageTarget =
  | { type: 'update'; rowKey: string; column: string }
  | { type: 'insert'; id: string }
  | { type: 'delete'; rowKey: string };

export type StageError = {
  target: StageTarget | null;
  /** Column at fault, when the server or the edit names one. */
  column: string | null;
  code: string;
  message: string;
  detail?: string;
  hint?: string;
};

export type StageState = {
  updates: StagedUpdate[];
  inserts: StagedInsert[];
  deletes: StagedDelete[];
  error: StageError | null;
};

export const emptyStage: StageState = { updates: [], inserts: [], deletes: [], error: null };

export type StageAction =
  | { type: 'setCell'; rowKey: string; key: RowKeyValues; column: string; value: CellValue; original: CellValue }
  | { type: 'revertCell'; rowKey: string; column: string }
  | { type: 'addInsert'; id: string }
  | { type: 'setInsertCell'; id: string; column: string; value: CellValue | undefined }
  | { type: 'removeInserts'; ids: string[] }
  | { type: 'deleteRows'; rows: { rowKey: string; key: RowKeyValues }[] }
  | { type: 'restoreRows'; rowKeys: string[] }
  | { type: 'discard' }
  | { type: 'commitFailed'; error: ApiErrorBody; targets: StageTarget[] }
  | { type: 'clearError' };

/** Stable identity of a row from its primary-key values, in key order. */
export function rowKeyOf(primaryKey: readonly string[], row: Record<string, CellValue>): string {
  return JSON.stringify(primaryKey.map((c) => row[c] ?? null));
}

function withoutColumn(update: StagedUpdate, column: string): StagedUpdate | null {
  const { [column]: _set, ...set } = update.set;
  const { [column]: _was, ...was } = update.was;
  return Object.keys(set).length === 0 ? null : { ...update, set, was };
}

/**
 * Staged edits of one table. Every change clears a previous commit error, since the
 * batch the error described no longer exists.
 */
export function stageReducer(state: StageState, action: StageAction): StageState {
  switch (action.type) {
    case 'setCell': {
      const existing = state.updates.find((u) => u.rowKey === action.rowKey);
      const original = existing && action.column in existing.was ? existing.was[action.column]! : action.original;
      let updates: StagedUpdate[];
      if (action.value === original) {
        // Typing the original value back is a revert.
        updates = state.updates.flatMap((u) => {
          if (u.rowKey !== action.rowKey) return [u];
          const next = withoutColumn(u, action.column);
          return next ? [next] : [];
        });
      } else if (existing) {
        updates = state.updates.map((u) =>
          u.rowKey === action.rowKey
            ? {
                ...u,
                set: { ...u.set, [action.column]: action.value },
                was: { ...u.was, [action.column]: original },
              }
            : u,
        );
      } else {
        updates = [
          ...state.updates,
          {
            rowKey: action.rowKey,
            key: action.key,
            set: { [action.column]: action.value },
            was: { [action.column]: original },
          },
        ];
      }
      return { ...state, updates, error: null };
    }
    case 'revertCell':
      return {
        ...state,
        updates: state.updates.flatMap((u) => {
          if (u.rowKey !== action.rowKey) return [u];
          const next = withoutColumn(u, action.column);
          return next ? [next] : [];
        }),
        error: null,
      };
    case 'addInsert':
      return { ...state, inserts: [...state.inserts, { id: action.id, values: {} }], error: null };
    case 'setInsertCell':
      return {
        ...state,
        inserts: state.inserts.map((ins) => {
          if (ins.id !== action.id) return ins;
          const { [action.column]: _old, ...rest } = ins.values;
          return {
            ...ins,
            values: action.value === undefined ? rest : { ...ins.values, [action.column]: action.value },
          };
        }),
        error: null,
      };
    case 'removeInserts':
      return { ...state, inserts: state.inserts.filter((i) => !action.ids.includes(i.id)), error: null };
    case 'deleteRows': {
      const known = new Set(state.deletes.map((d) => d.rowKey));
      const added = action.rows.filter((r) => !known.has(r.rowKey));
      const deleting = new Set(action.rows.map((r) => r.rowKey));
      return {
        ...state,
        // A deleted row's pending updates would never run; drop them.
        updates: state.updates.filter((u) => !deleting.has(u.rowKey)),
        deletes: [...state.deletes, ...added.map((r) => ({ rowKey: r.rowKey, key: r.key }))],
        error: null,
      };
    }
    case 'restoreRows':
      return { ...state, deletes: state.deletes.filter((d) => !action.rowKeys.includes(d.rowKey)), error: null };
    case 'discard':
      return emptyStage;
    case 'commitFailed': {
      const target = action.error.editIndex === undefined ? null : (action.targets[action.error.editIndex] ?? null);
      const column = action.error.column ?? (target?.type === 'update' ? target.column : null);
      return {
        ...state,
        error: {
          target,
          column,
          code: action.error.code,
          message: action.error.message,
          detail: action.error.detail,
          hint: action.error.hint,
        },
      };
    }
    case 'clearError':
      return { ...state, error: null };
  }
}

export function stageSize(state: StageState): { updated: number; inserted: number; deleted: number; total: number } {
  const updated = state.updates.reduce((n, u) => n + Object.keys(u.set).length, 0);
  return {
    updated,
    inserted: state.inserts.length,
    deleted: state.deletes.length,
    total: updated + state.inserts.length + state.deletes.length,
  };
}

/**
 * The request body for POST /edits, and for each edit the staged item it came from so a
 * failing editIndex maps back to a cell. Updates are sent one column per edit, so the
 * server runs one UPDATE per changed cell and an error names exactly one cell. Order:
 * updates, deletes, inserts (a deleted key can then be inserted again in the same batch).
 */
export function buildEdits(state: StageState, table: TableRef): { edits: RowEdit[]; targets: StageTarget[] } {
  const edits: RowEdit[] = [];
  const targets: StageTarget[] = [];
  for (const u of state.updates) {
    for (const [column, value] of Object.entries(u.set)) {
      edits.push({ kind: 'update', table, key: u.key, set: { [column]: value } });
      targets.push({ type: 'update', rowKey: u.rowKey, column });
    }
  }
  for (const d of state.deletes) {
    edits.push({ kind: 'delete', table, key: d.key });
    targets.push({ type: 'delete', rowKey: d.rowKey });
  }
  for (const ins of state.inserts) {
    edits.push({ kind: 'insert', table, values: ins.values });
    targets.push({ type: 'insert', id: ins.id });
  }
  return { edits, targets };
}
