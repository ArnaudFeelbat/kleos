import { z } from 'zod';

/**
 * A table's grid layout in the Data tab, remembered per connection and table.
 * Stored by the server (app.db) — not browser storage, whose origin changes with the
 * local server's random port at every launch.
 */
export const GridLayout = z.object({
  /** Column names in display order. Columns not listed keep their natural order, after these. */
  order: z.array(z.string()),
  /** Column name -> width in px. Columns not listed use their default width. */
  widths: z.record(z.string(), z.number().int().min(40).max(2000)),
});
export type GridLayout = z.infer<typeof GridLayout>;

export const emptyGridLayout: GridLayout = { order: [], widths: {} };
