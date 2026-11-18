import type { CellValue } from '@kleos/shared';
import type { CellKind } from '@/features/cells/classify';

export type GridColumn = {
  /** Unique within the grid (query results may repeat a name, so callers pass index-based keys). */
  key: string;
  name: string;
  kind: CellKind;
  /** Second header line, e.g. "int8", "uuid → customers". */
  typeLabel: string;
  primaryKey?: boolean;
  /** Server-side sort applied to this column, with its position for multi-sort. */
  sort?: { dir: 'asc' | 'desc'; position: number; of: number } | null;
};

/** Row states are always shown with a gutter icon as well as a color. */
export type GridRowStatus = 'insert' | 'delete' | 'update' | null;

export type GridRowMeta = {
  /** Stable key for React; survives paging and staging. */
  key: string;
  /** Gutter text: the row number, or "new". */
  label: string;
  status: GridRowStatus;
};

export type GridCell = {
  /** undefined renders DEFAULT (a new row's column that takes its default). */
  value: CellValue | undefined;
  /** Staged change; `was` is the original value shown in the tooltip. */
  changed?: boolean;
  was?: CellValue;
  /** Message of a failed commit that names this cell. */
  error?: string;
  /** Foreign-key link to the referenced row. */
  link?: { label: string; onOpen(): void };
};

export type CellPos = { row: number; col: number };

/**
 * Rectangular selection. `focus` is the active cell; `rows` marks a whole-row selection
 * made from the gutter, which every column belongs to.
 */
export type GridSelection = { anchor: CellPos; focus: CellPos; rows?: boolean };
