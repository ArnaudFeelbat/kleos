import type { ThroughputSample } from '@kleos/shared';
import {
  CartesianGrid,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
  type TooltipContentProps,
} from 'recharts';
import { formatClock, formatCompact, formatNumber } from '@/lib/format';

const axisTick = {
  fill: 'var(--muted-foreground)',
  fontSize: 11,
  fontFamily: 'Geist Mono Variable, ui-monospace, monospace',
};

/** Screen-reader summary of the series: range and latest value. */
export function throughputSummary(samples: ThroughputSample[]): string {
  if (samples.length === 0) return 'Transactions per second: no samples yet';
  const values = samples.map((s) => s.xactPerSec);
  const last = values.at(-1) ?? 0;
  return `Transactions per second over the last 15 minutes, between ${formatNumber(Math.min(...values))} and ${formatNumber(Math.max(...values))}, now ${formatNumber(last)}`;
}

/** Single-series line of xactPerSec: thin 2px line, recessive grid, crosshair tooltip, no legend. */
export function ThroughputChart({ samples }: { samples: ThroughputSample[] }) {
  if (samples.length < 2) {
    return (
      <div className="text-muted-foreground flex h-[220px] items-center justify-center text-xs">
        Collecting samples… the rate needs two snapshots, 5 s apart.
      </div>
    );
  }
  return (
    <div role="img" aria-label={throughputSummary(samples)} className="h-[220px] px-2 pt-4 pb-2">
      <ResponsiveContainer width="100%" height="100%">
        <LineChart data={samples} margin={{ top: 4, right: 16, bottom: 0, left: 0 }}>
          <CartesianGrid vertical={false} stroke="var(--chart-grid)" />
          <XAxis
            dataKey="t"
            tickFormatter={(t: string) => formatClock(t, false)}
            tick={axisTick}
            tickLine={false}
            axisLine={{ stroke: 'var(--input)' }}
            minTickGap={48}
          />
          <YAxis
            tickFormatter={(v: number) => formatCompact(v)}
            tick={axisTick}
            tickLine={false}
            axisLine={false}
            width={48}
            allowDecimals={false}
          />
          <Tooltip
            content={ThroughputTooltip}
            cursor={{ stroke: 'var(--muted-foreground)', strokeDasharray: '3 3', strokeWidth: 1 }}
            isAnimationActive={false}
          />
          <Line
            type="monotone"
            dataKey="xactPerSec"
            stroke="var(--chart-1)"
            strokeWidth={2}
            dot={false}
            activeDot={{ r: 5, fill: 'var(--chart-1)', stroke: 'var(--card)', strokeWidth: 2 }}
            isAnimationActive={false}
          />
        </LineChart>
      </ResponsiveContainer>
    </div>
  );
}

function ThroughputTooltip({ active, payload }: TooltipContentProps) {
  const sample = payload?.[0]?.payload as ThroughputSample | undefined;
  if (!active || !sample) return null;
  return (
    <div className="bg-card flex flex-col gap-0.5 rounded-lg border px-2.5 py-2 text-xs shadow-[0_8px_24px_rgba(0,0,0,.12)]">
      <span className="text-muted-foreground font-mono">{formatClock(sample.t)}</span>
      <span>
        <b className="font-mono font-semibold">{formatNumber(sample.xactPerSec)}</b> tx/s
      </span>
    </div>
  );
}
