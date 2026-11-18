import {
  ChartColumn,
  ChartLine,
  ChartNoAxesColumn,
  ChartScatter,
  Plus,
  Save,
  TriangleExclamationPoint,
  X,
} from 'lucide-react';
import { useCallback, useMemo, useState } from 'react';
import {
  Bar,
  BarChart,
  CartesianGrid,
  Line,
  LineChart,
  ResponsiveContainer,
  Scatter,
  ScatterChart,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import { chartTypes, type CellValue, type ChartSettings, type ColumnMeta } from '@kleos/shared';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group';
import { Tooltip as UiTooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { classifyType, typeLabel } from '@/features/cells/classify';
import { EmptyState } from '@/features/common/empty-state';
import { segmentedItem, segmentedList } from '@/features/common/styles';
import { DataGrid } from '@/features/grid/data-grid';
import type { GridColumn, GridSelection } from '@/features/grid/types';
import { formatInt } from '@/lib/format';
import { cn } from '@/lib/utils';
import {
  CHART_ROW_CAP,
  formatTick,
  isNumericColumn,
  MAX_SERIES,
  prepareChartData,
  type ChartData,
  type ChartPoint,
} from './chart-data';

type ChartViewProps = {
  columns: readonly ColumnMeta[];
  rows: readonly (readonly CellValue[])[];
  /** Effective settings (the tab's, or derived from the result); null when nothing is numeric. */
  settings: ChartSettings | null;
  onChange(settings: ChartSettings): void;
  asTable: boolean;
  onAsTableChange(asTable: boolean): void;
  /** More rows exist on the server than are loaded (the chart only uses loaded rows). */
  hasMore: boolean;
  onSave(): void;
  saveLabel: string;
};

const typeIcons = { line: ChartLine, bar: ChartColumn, scatter: ChartScatter } as const;
const valueFormat = new Intl.NumberFormat('en-US', { maximumFractionDigits: 6 });

/** Line, bar or scatter chart of the loaded rows: one y axis, up to three series in chart-1..3. */
export function ChartView(props: ChartViewProps) {
  const { columns, rows, settings, onChange, asTable, onAsTableChange, hasMore, onSave, saveLabel } = props;
  const data = useMemo(() => (settings ? prepareChartData(columns, rows, settings) : null), [columns, rows, settings]);

  if (columns.length === 0) {
    return (
      <EmptyState icon={ChartLine} title="Nothing to chart yet" hint="Run a query that returns rows to chart them." />
    );
  }

  const ySet = new Set(settings?.y ?? []);
  const yChoices = columns
    .filter((c) => c.name !== settings?.x && !ySet.has(c.name))
    .sort((a, b) => Number(isNumericColumn(b)) - Number(isNumericColumn(a)));
  const firstNonNumeric = columns.find((c) => !isNumericColumn(c)) ?? columns[0]!;
  const base: ChartSettings = settings ?? { type: 'line', x: firstNonNumeric.name, y: [] };
  const full = (settings?.y.length ?? 0) >= MAX_SERIES;

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-auto">
      <div className="bg-sidebar/50 flex flex-wrap items-center gap-2.5 border-b px-3 py-2">
        <ToggleGroup
          type="single"
          value={base.type}
          onValueChange={(v) => v && onChange({ ...base, type: v as ChartSettings['type'] })}
          aria-label="Chart type"
          className={segmentedList}
        >
          {chartTypes.map((t) => {
            const Icon = typeIcons[t];
            return (
              <ToggleGroupItem
                key={t}
                value={t}
                className={cn(segmentedItem, 'min-w-0 rounded-md! capitalize hover:bg-transparent')}
              >
                <Icon aria-hidden="true" />
                {t}
              </ToggleGroupItem>
            );
          })}
        </ToggleGroup>
        <span className="text-muted-foreground ml-1.5 text-xs" id="chart-x-label">
          X
        </span>
        <Select value={base.x} onValueChange={(x) => onChange({ ...base, x, y: base.y.filter((y) => y !== x) })}>
          <SelectTrigger size="sm" className="h-7 font-mono text-xs" aria-labelledby="chart-x-label">
            <SelectValue />
          </SelectTrigger>
          <SelectContent position="popper">
            {columns.map((c) => (
              <SelectItem key={c.name} value={c.name} className="font-mono text-xs">
                {c.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <span className="text-muted-foreground ml-1.5 text-xs">Y</span>
        {(data?.series ?? []).map((s) => (
          <span
            key={s.column}
            className="bg-card inline-flex h-7 items-center gap-1.5 rounded-md pr-1 pl-2.5 text-xs shadow-[0_0_0_1px_var(--edge),var(--elev-1)] dark:bg-white/[0.04]"
          >
            <span className="h-[3px] w-2.5 rounded-full" style={{ background: s.color }} aria-hidden="true" />
            <span className="font-mono">{s.column}</span>
            <button
              type="button"
              className="text-muted-foreground hover:text-foreground inline-flex size-5 items-center justify-center rounded-[4px] hover:bg-black/[0.06] dark:hover:bg-white/[0.08]"
              aria-label={`Remove ${s.column}`}
              onClick={() => onChange({ ...base, y: base.y.filter((y) => y !== s.column) })}
            >
              <X className="size-3" aria-hidden="true" />
            </button>
          </span>
        ))}
        <DropdownMenu>
          <UiTooltip>
            <TooltipTrigger asChild>
              <span>
                <DropdownMenuTrigger asChild>
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    className="border-foreground/20 text-foreground/75 hover:border-foreground/30 h-7 border border-dashed px-2.5 text-xs"
                    disabled={full || yChoices.length === 0}
                  >
                    <Plus className="size-3.5" aria-hidden="true" />
                    Column
                  </Button>
                </DropdownMenuTrigger>
              </span>
            </TooltipTrigger>
            {full && <TooltipContent>Three series at most: the palette has three validated colors.</TooltipContent>}
          </UiTooltip>
          <DropdownMenuContent align="start">
            <DropdownMenuLabel className="text-xs">Add a series</DropdownMenuLabel>
            {yChoices.map((c) => (
              <DropdownMenuItem
                key={c.name}
                className="font-mono text-xs"
                onSelect={() => onChange({ ...base, y: [...base.y, c.name] })}
              >
                {c.name}
                <span className="text-muted-foreground ml-auto pl-4 text-[11px]">{typeLabel(c)}</span>
              </DropdownMenuItem>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>
        <span className="flex-1" />
        <Button type="button" variant="outline" size="sm" className="h-7 text-xs" onClick={onSave}>
          <Save className="size-3.5" aria-hidden="true" />
          {saveLabel}
        </Button>
      </div>

      {!settings || !data || data.series.length === 0 ? (
        <EmptyState
          icon={ChartNoAxesColumn}
          title="No series to plot"
          hint="No numeric column to plot yet. Add a y column with “Column”."
        />
      ) : (
        <figure className="surface-raised animate-in fade-in-0 m-4 flex flex-col gap-3.5 rounded-xl px-5 pt-5 pb-4 duration-200">
          <figcaption className="flex flex-wrap items-start gap-3">
            <div className="flex flex-col gap-0.5">
              <b className="text-[15px] font-semibold tracking-[-0.012em]">
                {data.series.map((s) => s.column).join(', ')} by {settings.x}
              </b>
              <span className="text-muted-foreground text-xs">
                From the {formatInt(Math.min(rows.length, CHART_ROW_CAP))} rows already loaded
                {data.truncated
                  ? ` (capped at ${formatInt(CHART_ROW_CAP)} of ${formatInt(rows.length)})`
                  : hasMore
                    ? '; more exist on the server and are not drawn'
                    : ''}
                .
              </span>
              {(data.missing.length > 0 || data.dropped.length > 0) && (
                <span className="text-warning inline-flex items-start gap-1 text-xs">
                  <TriangleExclamationPoint className="mt-px size-3 shrink-0" aria-hidden="true" />
                  {data.missing.length > 0 && `Not in this result: ${data.missing.join(', ')}. `}
                  {data.dropped.length > 0 && `Left out (three series at most): ${data.dropped.join(', ')}.`}
                </span>
              )}
            </div>
            <span className="flex-1" />
            {data.series.length >= 2 && (
              <div className="flex items-center gap-3.5 pt-1 text-xs" aria-label="Legend">
                {data.series.map((s) => (
                  <span key={s.column} className="inline-flex items-center gap-1.5">
                    <span className="h-[3px] w-3.5 rounded-full" style={{ background: s.color }} aria-hidden="true" />
                    <span className="font-mono">{s.column}</span>
                  </span>
                ))}
              </div>
            )}
            <Button
              type="button"
              variant="outline"
              size="xs"
              className="text-xs"
              aria-pressed={asTable}
              onClick={() => onAsTableChange(!asTable)}
            >
              {asTable ? 'View as chart' : 'View as table'}
            </Button>
          </figcaption>
          {asTable ? (
            <ChartTable columns={columns} rows={rows} settings={settings} series={data.series.map((s) => s.column)} />
          ) : (
            <div className="h-[300px]" role="img" aria-label={chartDescription(settings, data)}>
              <ChartPlot settings={settings} data={data} />
            </div>
          )}
        </figure>
      )}
    </div>
  );
}

function chartDescription(settings: ChartSettings, data: ChartData): string {
  return `${settings.type} chart of ${data.series.map((s) => s.column).join(', ')} by ${settings.x}, ${data.points.length} points`;
}

const axisTick = { fill: 'var(--muted-foreground)', fontSize: 11 };

function ChartPlot({ settings, data }: { settings: ChartSettings; data: ChartData }) {
  const multi = data.series.length >= 2;
  const lastIndex = data.points.length - 1;
  const commonAxes = (
    <>
      <CartesianGrid vertical={false} stroke="var(--chart-grid)" />
      <XAxis
        dataKey="x"
        type={data.xNumeric ? 'number' : 'category'}
        domain={data.xNumeric ? ['auto', 'auto'] : undefined}
        tick={axisTick}
        tickLine={false}
        axisLine={{ stroke: 'var(--input)' }}
        minTickGap={24}
        tickFormatter={data.xNumeric ? (v: number) => formatTick(v) : undefined}
      />
      <YAxis
        tick={axisTick}
        tickLine={false}
        axisLine={false}
        width={48}
        tickFormatter={(v: number) => formatTick(v)}
      />
    </>
  );
  const tooltip = (
    <Tooltip
      cursor={
        settings.type === 'bar'
          ? { fill: 'var(--muted)', opacity: 0.5 }
          : { stroke: 'var(--muted-foreground)', strokeDasharray: '3 3' }
      }
      content={(p) => (
        <ChartTooltip
          active={p.active}
          label={p.label as string | number | undefined}
          point={(p.payload?.[0]?.payload as ChartPoint | undefined) ?? undefined}
          series={data.series}
          total={multi && settings.type !== 'scatter'}
        />
      )}
    />
  );
  const margin = { top: 8, right: settings.type === 'line' ? 110 : 16, bottom: 0, left: 0 };

  if (settings.type === 'bar') {
    return (
      <ResponsiveContainer width="100%" height="100%">
        <BarChart data={data.points} margin={margin} barGap={2} barCategoryGap="20%">
          {commonAxes}
          {tooltip}
          {data.series.map((s) => (
            <Bar
              key={s.column}
              dataKey={s.dataKey}
              name={s.column}
              fill={s.color}
              maxBarSize={24}
              radius={[4, 4, 0, 0]}
              isAnimationActive={false}
            />
          ))}
        </BarChart>
      </ResponsiveContainer>
    );
  }
  if (settings.type === 'scatter') {
    return (
      <ResponsiveContainer width="100%" height="100%">
        <ScatterChart margin={margin}>
          {commonAxes}
          {tooltip}
          {data.series.map((s) => (
            <Scatter
              key={s.column}
              name={s.column}
              data={data.points}
              dataKey={s.dataKey}
              fill={s.color}
              stroke="var(--card)"
              strokeWidth={2}
              isAnimationActive={false}
            />
          ))}
        </ScatterChart>
      </ResponsiveContainer>
    );
  }
  return (
    <ResponsiveContainer width="100%" height="100%">
      <LineChart data={data.points} margin={margin}>
        {commonAxes}
        {tooltip}
        {data.series.map((s) => (
          <Line
            key={s.column}
            type="linear"
            dataKey={s.dataKey}
            name={s.column}
            stroke={s.color}
            strokeWidth={2}
            dot={false}
            activeDot={{ r: 4, stroke: 'var(--card)', strokeWidth: 2 }}
            isAnimationActive={false}
            label={(p: { x?: number | string; y?: number | string; index?: number; value?: unknown }) => {
              // Direct label at the end of each line: name and last value, in text ink.
              if (p.index !== lastIndex || p.value === null || p.value === undefined) return <g />;
              return (
                <g>
                  <circle cx={Number(p.x) + 10} cy={Number(p.y)} r={4} fill={s.color} />
                  <text x={Number(p.x) + 18} y={Number(p.y)} dy={4} fontSize={12} fill="var(--foreground)">
                    {s.column}{' '}
                    <tspan fill="var(--muted-foreground)" fontFamily="var(--font-mono)">
                      {formatTick(Number(p.value))}
                    </tspan>
                  </text>
                </g>
              );
            }}
          />
        ))}
      </LineChart>
    </ResponsiveContainer>
  );
}

function ChartTooltip({
  active,
  label,
  point,
  series,
  total,
}: {
  active?: boolean;
  label?: string | number;
  point?: ChartPoint;
  series: ChartData['series'];
  total: boolean;
}) {
  if (!active || !point) return null;
  const values = series.map((s) => point[s.dataKey]);
  const sum = values.reduce<number>((acc, v) => acc + (typeof v === 'number' ? v : 0), 0);
  return (
    <div className="surface-overlay flex w-52 flex-col gap-1.5 rounded-lg px-3 py-2.5 text-xs">
      <b className="font-semibold">{String(point.x ?? label ?? '')}</b>
      {series.map((s, i) => (
        <span key={s.column} className="flex items-center gap-2">
          <span className="size-2 rounded-full" style={{ background: s.color }} aria-hidden="true" />
          {s.column}
          <span className="ml-auto font-mono">
            {typeof values[i] === 'number' ? valueFormat.format(values[i] as number) : 'NULL'}
          </span>
        </span>
      ))}
      {total && (
        <span className="text-muted-foreground flex border-t pt-1.5">
          Total<span className="text-foreground ml-auto font-mono">{valueFormat.format(sum)}</span>
        </span>
      )}
    </div>
  );
}

/** The plotted columns as a grid, with the exact text values from the server. */
function ChartTable({
  columns,
  rows,
  settings,
  series,
}: {
  columns: readonly ColumnMeta[];
  rows: readonly (readonly CellValue[])[];
  settings: ChartSettings;
  series: string[];
}) {
  const [selection, setSelection] = useState<GridSelection | null>(null);
  const picked = useMemo(
    () => [settings.x, ...series].map((name) => columns.findIndex((c) => c.name === name)).filter((i) => i !== -1),
    [columns, settings.x, series],
  );
  const gridColumns = useMemo<GridColumn[]>(
    () =>
      picked.map((i) => {
        const c = columns[i]!;
        return { key: `${i}`, name: c.name, kind: classifyType(c), typeLabel: typeLabel(c) };
      }),
    [picked, columns],
  );
  const count = Math.min(rows.length, CHART_ROW_CAP);
  const getRowMeta = useCallback((i: number) => ({ key: String(i), label: String(i + 1), status: null }), []);
  const getCell = useCallback((r: number, c: number) => ({ value: rows[r]?.[picked[c]!] ?? null }), [rows, picked]);
  return (
    <div className="flex h-[300px] min-h-0 flex-col overflow-hidden rounded-lg border">
      <DataGrid
        columns={gridColumns}
        rowCount={count}
        getRowMeta={getRowMeta}
        getCell={getCell}
        selection={selection}
        onSelectionChange={setSelection}
        ariaLabel="Chart data"
      />
    </div>
  );
}
