import type { GridLayout } from '@kleos/shared';

/** Bounds of a remembered column width (the server refuses anything outside). */
export const LAYOUT_MIN_WIDTH = 40;
export const LAYOUT_MAX_WIDTH = 2000;

export function clampWidth(width: number): number {
  return Math.min(LAYOUT_MAX_WIDTH, Math.max(LAYOUT_MIN_WIDTH, Math.round(width)));
}

/**
 * Display order of columns as indexes into `names` (their natural order): the names listed
 * in `order` first, in that order, then every other column in its natural order. Unknown
 * names (dropped columns) and repeats are ignored.
 */
export function displayOrder(names: readonly string[], order: readonly string[]): number[] {
  const index = new Map<string, number>();
  names.forEach((n, i) => {
    if (!index.has(n)) index.set(n, i);
  });
  const placed = new Set<number>();
  const result: number[] = [];
  for (const name of order) {
    const i = index.get(name);
    if (i === undefined || placed.has(i)) continue;
    placed.add(i);
    result.push(i);
  }
  names.forEach((_, i) => {
    if (!placed.has(i)) result.push(i);
  });
  return result;
}

/** `items` with the item at `from` moved to index `to` (both clamped to the array). */
export function moveItem<T>(items: readonly T[], from: number, to: number): T[] {
  const next = [...items];
  if (from < 0 || from >= items.length) return next;
  const target = Math.max(0, Math.min(items.length - 1, to));
  const [item] = next.splice(from, 1);
  next.splice(target, 0, item!);
  return next;
}

/** Where the item at index `i` ends up when the item at `from` moves to `to`. */
export function indexAfterMove(i: number, from: number, to: number): number {
  if (i === from) return to;
  if (from < i && i <= to) return i - 1;
  if (to <= i && i < from) return i + 1;
  return i;
}

/**
 * A stored layout merged with the table's current columns (after a schema change):
 * unknown names are dropped from the order and the widths, repeats are dropped, widths are
 * clamped, and an order that only restates the natural order is emptied.
 */
export function normalizeLayout(layout: GridLayout, names: readonly string[]): GridLayout {
  const known = new Set(names);
  const listed = [...new Set(layout.order.filter((n) => known.has(n)))];
  const natural = displayOrder(names, listed).every((n, i) => n === i);
  const order = natural ? [] : listed;
  const widths: Record<string, number> = {};
  for (const [name, width] of Object.entries(layout.widths)) {
    if (known.has(name) && Number.isFinite(width)) widths[name] = clampWidth(width);
  }
  return { order, widths };
}

/**
 * The layout after moving the column shown at display index `from` to display index `to`.
 * The whole current display order is stored, so later-added columns land at the end.
 */
export function moveInLayout(layout: GridLayout, names: readonly string[], from: number, to: number): GridLayout {
  const display = displayOrder(names, layout.order).map((i) => names[i]!);
  return normalizeLayout({ ...layout, order: moveItem(display, from, to) }, names);
}

/** The layout with one column's width set, or reset to its default when `width` is null. */
export function resizeInLayout(layout: GridLayout, name: string, width: number | null): GridLayout {
  const { [name]: _old, ...rest } = layout.widths;
  return { ...layout, widths: width === null ? rest : { ...rest, [name]: clampWidth(width) } };
}

export function isEmptyLayout(layout: GridLayout): boolean {
  return layout.order.length === 0 && Object.keys(layout.widths).length === 0;
}

/**
 * Insertion slot (0..n) for a dragged column: the column boundary nearest to `x`.
 * `edges` are the n+1 boundaries, left edge of the first column to right edge of the last.
 */
export function dropSlot(edges: readonly number[], x: number): number {
  let best = 0;
  let bestDist = Infinity;
  edges.forEach((edge, i) => {
    const dist = Math.abs(edge - x);
    if (dist < bestDist) {
      best = i;
      bestDist = dist;
    }
  });
  return best;
}

/** Target index of a column taken from `from` and dropped at insertion slot `slot`. */
export function slotTarget(from: number, slot: number): number {
  return slot > from ? slot - 1 : slot;
}
