import { describe, expect, it } from 'vitest';
import type { GridLayout } from '@kleos/shared';
import { initialLayoutGate, layoutGate, type LayoutGate, type LayoutGateEvent } from './grid-layout';

const remembered: GridLayout = { order: ['total', 'id'], widths: { note: 300 } };
const mine: GridLayout = { order: [], widths: { id: 90 } };
const run = (...events: LayoutGateEvent[]): LayoutGate => events.reduce(layoutGate, initialLayoutGate);

describe('layoutGate', () => {
  it('holds the first paint until the remembered layout loads, then draws it', () => {
    expect(run().ready).toBe(false);
    expect(run({ type: 'loaded', layout: remembered })).toMatchObject({ ready: true, layout: remembered });
  });

  it('draws the natural layout once the hold expires', () => {
    expect(run({ type: 'holdExpired' })).toMatchObject({ ready: true, layout: { order: [], widths: {} } });
  });

  it('applies a late layout while the user has not touched the grid', () => {
    expect(run({ type: 'holdExpired' }, { type: 'loaded', layout: remembered }).layout).toEqual(remembered);
  });

  it('keeps the natural layout when the user scrolled before the late layout came', () => {
    const state = run({ type: 'holdExpired' }, { type: 'touched' }, { type: 'loaded', layout: remembered });
    expect(state.layout).toEqual({ order: [], widths: {} });
  });

  it('keeps the user’s own resize or reorder over a late layout', () => {
    const state = run(
      { type: 'holdExpired' },
      { type: 'changed', layout: mine },
      { type: 'loaded', layout: remembered },
    );
    expect(state.layout).toEqual(mine);
  });

  it('lets the user change the layout after it loaded', () => {
    const state = run({ type: 'loaded', layout: remembered }, { type: 'touched' }, { type: 'changed', layout: mine });
    expect(state.layout).toEqual(mine);
  });

  it('ignores a scroll before anything is drawn, and a failed load', () => {
    expect(run({ type: 'touched' }, { type: 'loaded', layout: remembered }).layout).toEqual(remembered);
    expect(run({ type: 'loaded', layout: null })).toMatchObject({ ready: true, layout: { order: [], widths: {} } });
  });
});
