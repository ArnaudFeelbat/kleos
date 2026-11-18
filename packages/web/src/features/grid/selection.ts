import type { CellPos, GridSelection } from './types';

export type SelectionBounds = { top: number; bottom: number; left: number; right: number };

export function selectionBounds(sel: GridSelection, colCount: number): SelectionBounds {
  const top = Math.min(sel.anchor.row, sel.focus.row);
  const bottom = Math.max(sel.anchor.row, sel.focus.row);
  if (sel.rows) return { top, bottom, left: 0, right: Math.max(0, colCount - 1) };
  return {
    top,
    bottom,
    left: Math.min(sel.anchor.col, sel.focus.col),
    right: Math.max(sel.anchor.col, sel.focus.col),
  };
}

export function isCellSelected(sel: GridSelection | null, pos: CellPos, colCount: number): boolean {
  if (!sel) return false;
  const b = selectionBounds(sel, colCount);
  return pos.row >= b.top && pos.row <= b.bottom && pos.col >= b.left && pos.col <= b.right;
}

/** Row indexes covered by the selection, in order. */
export function selectedRows(sel: GridSelection | null, colCount: number): number[] {
  if (!sel) return [];
  const b = selectionBounds(sel, colCount);
  const out: number[] = [];
  for (let r = b.top; r <= b.bottom; r += 1) out.push(r);
  return out;
}

export type MoveKey = 'up' | 'down' | 'left' | 'right' | 'home' | 'end' | 'pageUp' | 'pageDown' | 'first' | 'last';

/**
 * The selection after a navigation key. `extend` (Shift) keeps the anchor and moves the
 * focus; otherwise the selection collapses to the new cell. Moves clamp at the edges.
 */
export function moveSelection(
  sel: GridSelection | null,
  key: MoveKey,
  extend: boolean,
  size: { rows: number; cols: number; pageRows: number },
): GridSelection | null {
  if (size.rows === 0 || size.cols === 0) return null;
  const from = sel?.focus ?? { row: 0, col: 0 };
  const clampRow = (r: number) => Math.max(0, Math.min(size.rows - 1, r));
  const clampCol = (c: number) => Math.max(0, Math.min(size.cols - 1, c));
  let next: CellPos;
  if (!sel) {
    next = { row: 0, col: 0 };
  } else {
    switch (key) {
      case 'up':
        next = { row: clampRow(from.row - 1), col: from.col };
        break;
      case 'down':
        next = { row: clampRow(from.row + 1), col: from.col };
        break;
      case 'left':
        next = { row: from.row, col: clampCol(from.col - 1) };
        break;
      case 'right':
        next = { row: from.row, col: clampCol(from.col + 1) };
        break;
      case 'home':
        next = { row: from.row, col: 0 };
        break;
      case 'end':
        next = { row: from.row, col: size.cols - 1 };
        break;
      case 'pageUp':
        next = { row: clampRow(from.row - size.pageRows), col: from.col };
        break;
      case 'pageDown':
        next = { row: clampRow(from.row + size.pageRows), col: from.col };
        break;
      case 'first':
        next = { row: 0, col: from.col };
        break;
      case 'last':
        next = { row: size.rows - 1, col: from.col };
        break;
    }
  }
  if (extend && sel) return { anchor: sel.anchor, focus: next, rows: sel.rows };
  return { anchor: next, focus: next };
}

/** Tab order: right along the row, wrapping to the next row (Shift+Tab goes back). */
export function tabSelection(
  sel: GridSelection | null,
  backwards: boolean,
  size: { rows: number; cols: number },
): GridSelection | null {
  if (size.rows === 0 || size.cols === 0) return null;
  const from = sel?.focus ?? { row: 0, col: -1 };
  let { row, col } = from;
  col += backwards ? -1 : 1;
  if (col >= size.cols) {
    col = 0;
    row = Math.min(size.rows - 1, row + 1);
    if (row === from.row) col = size.cols - 1;
  } else if (col < 0) {
    col = size.cols - 1;
    row = Math.max(0, row - 1);
    if (row === from.row) col = 0;
  }
  const next = { row, col };
  return { anchor: next, focus: next };
}
