import { describe, expect, it } from 'vitest';
import { emptyGridLayout } from '@kleos/shared';
import {
  clampWidth,
  displayOrder,
  dropSlot,
  indexAfterMove,
  isEmptyLayout,
  moveInLayout,
  moveItem,
  normalizeLayout,
  resizeInLayout,
  slotTarget,
} from './column-layout';

const names = ['id', 'customer_id', 'status', 'total', 'note'];
const shown = (order: string[]) => displayOrder(names, order).map((i) => names[i]);

describe('displayOrder', () => {
  it('keeps the natural order when nothing is listed', () => {
    expect(displayOrder(names, [])).toEqual([0, 1, 2, 3, 4]);
  });

  it('puts listed columns first and the others after them in natural order', () => {
    expect(shown(['total', 'id'])).toEqual(['total', 'id', 'customer_id', 'status', 'note']);
  });

  it('ignores unknown names (dropped columns) and repeats', () => {
    expect(shown(['gone', 'note', 'note', 'status'])).toEqual(['note', 'status', 'id', 'customer_id', 'total']);
  });
});

describe('moveItem and indexAfterMove', () => {
  it('moves an item forward and backward', () => {
    expect(moveItem(['a', 'b', 'c', 'd'], 0, 2)).toEqual(['b', 'c', 'a', 'd']);
    expect(moveItem(['a', 'b', 'c', 'd'], 3, 1)).toEqual(['a', 'd', 'b', 'c']);
  });

  it('clamps the target and ignores an unknown source', () => {
    expect(moveItem(['a', 'b', 'c'], 0, 9)).toEqual(['b', 'c', 'a']);
    expect(moveItem(['a', 'b'], 5, 0)).toEqual(['a', 'b']);
  });

  it('tells where each other index lands', () => {
    // a b c d, move a (0) to 2 -> b c a d
    expect([0, 1, 2, 3].map((i) => indexAfterMove(i, 0, 2))).toEqual([2, 0, 1, 3]);
    // a b c d, move d (3) to 1 -> a d b c
    expect([0, 1, 2, 3].map((i) => indexAfterMove(i, 3, 1))).toEqual([0, 2, 3, 1]);
  });
});

describe('normalizeLayout (merge after a schema change)', () => {
  it('drops dropped columns from the order and the widths', () => {
    expect(normalizeLayout({ order: ['total', 'legacy', 'id'], widths: { legacy: 90, note: 300 } }, names)).toEqual({
      order: ['total', 'id'],
      widths: { note: 300 },
    });
  });

  it('empties an order that only restates the natural order', () => {
    expect(normalizeLayout({ order: ['id', 'customer_id'], widths: {} }, names)).toEqual(emptyGridLayout);
    expect(normalizeLayout({ order: [...names, 'legacy'], widths: {} }, names)).toEqual(emptyGridLayout);
  });

  it('clamps widths to 40..2000 and rounds them', () => {
    expect(normalizeLayout({ order: [], widths: { id: 12, note: 9000, total: 120.6 } }, names).widths).toEqual({
      id: 40,
      note: 2000,
      total: 121,
    });
  });

  it('places a column added since the layout was saved after the listed ones', () => {
    const saved = moveInLayout(emptyGridLayout, names, 4, 0);
    expect(saved.order).toEqual(['note', 'id', 'customer_id', 'status', 'total']);
    expect(shown(normalizeLayout(saved, [...names, 'placed_at']).order)).toEqual([
      'note',
      'id',
      'customer_id',
      'status',
      'total',
    ]);
    expect(displayOrder([...names, 'placed_at'], saved.order).at(-1)).toBe(5);
  });
});

describe('moveInLayout and resizeInLayout', () => {
  it('stores the whole display order after a move and keeps widths', () => {
    const layout = moveInLayout({ order: ['total'], widths: { note: 250 } }, names, 0, 2);
    expect(layout).toEqual({ order: ['id', 'customer_id', 'total', 'status', 'note'], widths: { note: 250 } });
  });

  it('returns to the empty order when a move restores the natural order', () => {
    const moved = moveInLayout(emptyGridLayout, names, 1, 3);
    expect(moveInLayout(moved, names, 3, 1)).toEqual(emptyGridLayout);
  });

  it('sets, clamps and resets one width', () => {
    const wide = resizeInLayout(emptyGridLayout, 'note', 3000);
    expect(wide.widths).toEqual({ note: 2000 });
    expect(isEmptyLayout(resizeInLayout(wide, 'note', null))).toBe(true);
  });

  it('clampWidth bounds every width', () => {
    expect([clampWidth(0), clampWidth(56), clampWidth(2001)]).toEqual([40, 56, 2000]);
  });
});

describe('dropSlot and slotTarget', () => {
  const edges = [55, 155, 255, 355, 455];

  it('picks the nearest column boundary', () => {
    expect(dropSlot(edges, 0)).toBe(0);
    expect(dropSlot(edges, 190)).toBe(1);
    expect(dropSlot(edges, 220)).toBe(2);
    expect(dropSlot(edges, 9999)).toBe(4);
  });

  it('turns a slot into a target index, accounting for the column taken out', () => {
    expect(slotTarget(0, 3)).toBe(2);
    expect(slotTarget(3, 1)).toBe(1);
    expect(slotTarget(1, 1)).toBe(1);
    expect(slotTarget(1, 2)).toBe(1);
  });
});
