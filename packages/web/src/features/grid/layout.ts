import type { CellKind } from '@/features/cells/classify';
import type { GridColumn } from './types';

export const ROW_HEIGHT = 30;
export const HEADER_HEIGHT = 44;
export const MIN_COL_WIDTH = 56;
export const MAX_DEFAULT_WIDTH = 420;

const widthByKind: Record<CellKind, number> = {
  integer: 96,
  number: 112,
  text: 220,
  bool: 72,
  date: 108,
  timestamp: 176,
  timestamptz: 196,
  json: 280,
  array: 180,
  uuid: 304,
  enum: 120,
  bytea: 200,
  other: 160,
};

/** Starting width from the type, widened so the header name and type label fit. */
export function defaultColumnWidth(col: GridColumn): number {
  const nameWidth = col.name.length * 7.2 + 24 + (col.primaryKey ? 16 : 0) + (col.sort ? 24 : 0);
  const typeWidth = col.typeLabel.length * 6.4 + 24;
  return Math.round(Math.min(MAX_DEFAULT_WIDTH, Math.max(widthByKind[col.kind], nameWidth, typeWidth)));
}

/** Gutter wide enough for the largest row label and its state icon. */
export function gutterWidth(maxLabel: string): number {
  return Math.max(52, Math.round(maxLabel.length * 7 + 34));
}
