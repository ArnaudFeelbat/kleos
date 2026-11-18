import type { CellValue, ChartSettings, ColumnMeta } from '@kleos/shared';
import { classifyType } from '@/features/cells/classify';

/** Charts draw from rows already loaded, never more than this. */
export const CHART_ROW_CAP = 5000;
/** The validated palette has three colors; a fourth series would have to cycle, so it is refused. */
export const MAX_SERIES = 3;
/** chart-1..3 (blue, orange, aqua), assigned by series position, never cycled. */
export const seriesColors = ['var(--chart-1)', 'var(--chart-2)', 'var(--chart-3)'] as const;

export function isNumericColumn(meta: Pick<ColumnMeta, 'type' | 'typeName' | 'typeCategory'>): boolean {
  const kind = classifyType(meta);
  return kind === 'integer' || kind === 'number';
}

/** Text from the server as a number for plotting only; null for NULL or anything non-numeric. */
export function plotNumber(value: CellValue | undefined): number | null {
  if (value === null || value === undefined || value.trim() === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

/**
 * Starting chart for a result: x is the first non-numeric column (dates, labels), else
 * the first column; y is every other numeric column, up to three. Null when nothing is
 * numeric, so there is nothing to plot.
 */
export function defaultChartSettings(
  columns: readonly ColumnMeta[],
  type: ChartSettings['type'] = 'line',
): ChartSettings | null {
  if (columns.length === 0) return null;
  const xCol = columns.find((c) => !isNumericColumn(c)) ?? columns[0]!;
  const y = columns
    .filter((c) => c !== xCol && isNumericColumn(c))
    .map((c) => c.name)
    .slice(0, MAX_SERIES);
  if (y.length === 0) return null;
  return { type, x: xCol.name, y };
}

export type ChartSeries = { column: string; dataKey: string; color: string };
export type ChartPoint = { x: string | number | null } & Record<string, string | number | null>;

export type ChartData = {
  points: ChartPoint[];
  series: ChartSeries[];
  /** Scatter with a numeric x column plots x on a number axis; otherwise x is a category. */
  xNumeric: boolean;
  /** More rows were loaded than the cap; only the first CHART_ROW_CAP are drawn. */
  truncated: boolean;
  /** y columns past the third, left out rather than recolored. */
  dropped: string[];
  /** Settings that name columns this result does not have (a saved chart on a changed query). */
  missing: string[];
};

/**
 * Chart points from loaded rows: x as given (or as a number for scatter on a numeric
 * column), each y parsed with Number() for plotting only. Colors follow the series order.
 */
export function prepareChartData(
  columns: readonly ColumnMeta[],
  rows: readonly (readonly CellValue[])[],
  settings: ChartSettings,
): ChartData {
  const index = new Map(columns.map((c, i) => [c.name, i]));
  const missing = [settings.x, ...settings.y].filter((name) => !index.has(name));
  const present = settings.y.filter((name) => index.has(name));
  const kept = present.slice(0, MAX_SERIES);
  const dropped = present.slice(MAX_SERIES);
  const series = kept.map((column, i) => ({ column, dataKey: `y${i}`, color: seriesColors[i]! }));
  const xIdx = index.get(settings.x);
  const xMeta = xIdx === undefined ? undefined : columns[xIdx];
  const xNumeric = settings.type === 'scatter' && !!xMeta && isNumericColumn(xMeta);
  const limited = rows.length > CHART_ROW_CAP ? rows.slice(0, CHART_ROW_CAP) : rows;
  const points = limited.map((row) => {
    const raw = xIdx === undefined ? null : (row[xIdx] ?? null);
    const point: ChartPoint = { x: xNumeric ? plotNumber(raw) : raw };
    series.forEach((s) => {
      point[s.dataKey] = plotNumber(row[index.get(s.column)!]);
    });
    return point;
  });
  return { points, series, xNumeric, truncated: rows.length > CHART_ROW_CAP, dropped, missing };
}

/** Compact axis ticks: 35000 -> "35k", 1250000 -> "1.25M". */
export function formatTick(n: number): string {
  const abs = Math.abs(n);
  if (abs >= 1e9) return `${+(n / 1e9).toPrecision(3)}B`;
  if (abs >= 1e6) return `${+(n / 1e6).toPrecision(3)}M`;
  if (abs >= 1e3) return `${+(n / 1e3).toPrecision(3)}k`;
  return String(+n.toPrecision(4));
}

export function sameChart(a: ChartSettings | null, b: ChartSettings | null): boolean {
  if (a === b) return true;
  if (!a || !b) return false;
  return a.type === b.type && a.x === b.x && a.y.length === b.y.length && a.y.every((y, i) => y === b.y[i]);
}
