import { tableKey, type Column, type Index, type Table, type TableRef } from '@kleos/shared';
import type { StagedDdl } from './store';

/** A column of the selected table as it will be once the staged changes run. */
export type ColumnView = {
  /** Stable React key: the column's name as introspected, or the id of the change adding it. */
  key: string;
  /** Name after staged renames; later changes must use it, since statements run in order. */
  name: string;
  /** The introspected column; null for a column a staged change adds. */
  original: Column | null;
  /** The staged addColumn, for added columns. */
  addedBy: StagedDdl | null;
  type: string;
  nullable: boolean;
  default: string | null;
  /** Staged changes that rename or alter it (not the one adding it). */
  changes: StagedDdl[];
  dropped: StagedDdl | null;
};

export type IndexView = {
  key: string;
  name: string | null;
  columns: string[];
  method: string;
  unique: boolean;
  original: Index | null;
  addedBy: StagedDdl | null;
  dropped: StagedDdl | null;
};

/** The selected table with every staged change that touches it laid over it. */
export type TableOverlay = {
  /** The table's name after staged renames: new changes address this one. */
  ref: TableRef;
  renamedBy: StagedDdl[];
  dropped: StagedDdl | null;
  columns: ColumnView[];
  indexes: IndexView[];
  /** Number of staged changes that touch this table. */
  touching: number;
};

const sameTable = (a: TableRef, b: TableRef) => tableKey(a) === tableKey(b);

/**
 * Replays the staged list in order against one table, following renames so that a change
 * written after "rename email to contact" (which names `contact`) lands on the right column.
 */
export function tableOverlay(table: Table, staged: readonly StagedDdl[]): TableOverlay {
  let ref: TableRef = { schema: table.schema, name: table.name };
  const renamedBy: StagedDdl[] = [];
  let dropped: StagedDdl | null = null;
  let touching = 0;
  const columns: ColumnView[] = table.columns.map((c) => ({
    key: c.name,
    name: c.name,
    original: c,
    addedBy: null,
    type: c.type,
    nullable: c.nullable,
    default: c.default,
    changes: [],
    dropped: null,
  }));
  const indexes: IndexView[] = table.indexes.map((i) => ({
    key: i.name,
    name: i.name,
    columns: i.columns,
    method: i.method,
    unique: i.unique,
    original: i,
    addedBy: null,
    dropped: null,
  }));
  const live = (name: string) => columns.find((c) => c.name === name && !c.dropped);

  for (const s of staged) {
    const c = s.change;
    if (c.op === 'createTable') continue;
    if (c.op === 'dropIndex') {
      const index = indexes.find((i) => i.original && i.name === c.name && c.schema === table.schema && !i.dropped);
      if (index) {
        index.dropped = s;
        touching++;
      }
      continue;
    }
    if (!sameTable(c.table, ref)) continue;
    touching++;
    switch (c.op) {
      case 'renameTable':
        ref = { schema: ref.schema, name: c.newName };
        renamedBy.push(s);
        break;
      case 'dropTable':
        dropped = s;
        break;
      case 'addColumn':
        columns.push({
          key: s.id,
          name: c.column.name,
          original: null,
          addedBy: s,
          type: c.column.type,
          nullable: c.column.nullable ?? true,
          default: c.column.default ?? null,
          changes: [],
          dropped: null,
        });
        break;
      case 'createIndex':
        indexes.push({
          key: s.id,
          name: c.name ?? null,
          columns: c.columns,
          method: c.method ?? 'btree',
          unique: c.unique ?? false,
          original: null,
          addedBy: s,
          dropped: null,
        });
        break;
      default: {
        const column = live(c.column);
        if (!column) break;
        if (c.op === 'renameColumn') column.name = c.newName;
        else if (c.op === 'alterColumnType') column.type = c.type;
        else if (c.op === 'setNotNull') column.nullable = !c.notNull;
        else if (c.op === 'setDefault') column.default = c.default;
        if (c.op === 'dropColumn') column.dropped = s;
        else column.changes.push(s);
      }
    }
  }
  return { ref, renamedBy, dropped, columns, indexes, touching };
}

/** The staged change of this op on a column, if any (used to undo a toggle instead of stacking it). */
export function stagedOn(column: ColumnView, op: 'setNotNull' | 'setDefault' | 'alterColumnType' | 'renameColumn') {
  return column.changes.find((s) => s.change.op === op) ?? null;
}
