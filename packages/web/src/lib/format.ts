/**
 * Display formatting shared across features: sizes, counts, durations and relative times.
 * Every function is pure; `now` is injectable so tests and callers can pin the clock.
 */

const intFormat = new Intl.NumberFormat('en-US', { maximumFractionDigits: 0 });

/** Keeps three significant digits and drops trailing zeros: 9.80 -> "9.8", 68.0 -> "68". */
function sig3(value: number): string {
  return String(Number(value.toPrecision(3)));
}

/** 1234567 -> "1,234,567". */
export function formatInt(value: number): string {
  return intFormat.format(Math.round(value));
}

/** Plain number with thousands separators and at most `digits` decimals: 1436.2 -> "1,436". */
export function formatNumber(value: number, digits = 0): string {
  return new Intl.NumberFormat('en-US', { maximumFractionDigits: digits, minimumFractionDigits: 0 }).format(value);
}

const byteUnits = ['B', 'kB', 'MB', 'GB', 'TB', 'PB'] as const;

/** Binary sizes as Postgres pg_size_pretty names them: 431800000 -> "412 MB", 10276044 -> "9.8 MB". */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return '—';
  if (bytes < 1024) return `${Math.round(bytes)} B`;
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < byteUnits.length - 1) {
    value /= 1024;
    unit += 1;
  }
  // 1023.6 kB rounds to "1020 kB" at three digits; that is fine, never "1.02e+3".
  return `${value >= 1000 ? Math.round(value) : sig3(value)} ${byteUnits[unit]}`;
}

/**
 * Compact counts for dense lists: below 10,000 the exact number with separators ("2,184"),
 * above it three significant digits with k / M / B ("12.4k", "3.9M", "122M").
 */
export function formatCompact(value: number): string {
  if (!Number.isFinite(value)) return '—';
  const abs = Math.abs(value);
  if (abs < 10_000) return formatInt(value);
  const steps: [number, string][] = [
    [1e12, 'T'],
    [1e9, 'B'],
    [1e6, 'M'],
    [1e3, 'k'],
  ];
  for (const [size, suffix] of steps) {
    if (abs >= size) {
      const scaled = value / size;
      return `${Math.abs(scaled) >= 1000 ? Math.round(scaled) : sig3(scaled)}${suffix}`;
    }
  }
  return formatInt(value);
}

/** Planner row estimate; pg_class.reltuples is -1 when the table was never analyzed. */
export function formatRowEstimate(estimate: number): string | null {
  return estimate < 0 ? null : formatCompact(estimate);
}

/** 0.9921 -> "99.2%"; null -> "—". */
export function formatPercent(ratio: number | null | undefined, digits = 1): string {
  if (ratio === null || ratio === undefined || !Number.isFinite(ratio)) return '—';
  return `${(ratio * 100).toFixed(digits)}%`;
}

/**
 * Elapsed seconds for ages and waits: "0.0s", "12.8s", "1m 05s", "4m 12s", "2h 03m", "3d 4h".
 * null -> "—".
 */
export function formatDuration(seconds: number | null | undefined): string {
  if (seconds === null || seconds === undefined || !Number.isFinite(seconds)) return '—';
  const s = Math.max(0, seconds);
  if (s < 60) return `${s.toFixed(1)}s`;
  const total = Math.floor(s);
  const days = Math.floor(total / 86_400);
  const hours = Math.floor((total % 86_400) / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const secs = total % 60;
  const pad = (n: number) => String(n).padStart(2, '0');
  if (days > 0) return `${days}d ${hours}h`;
  if (hours > 0) return `${hours}h ${pad(minutes)}m`;
  return `${minutes}m ${pad(secs)}s`;
}

/** Statement timings in milliseconds: "0.11 ms", "3.1 ms", "412 ms", "2.84 s", "57.0 min", "1.5 h". */
export function formatMs(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return '—';
  if (ms < 1) return `${ms.toFixed(2)} ms`;
  if (ms < 10) return `${ms.toFixed(1)} ms`;
  if (ms < 1000) return `${Math.round(ms)} ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(2)} s`;
  if (ms < 3_600_000) return `${(ms / 60_000).toFixed(1)} min`;
  return `${(ms / 3_600_000).toFixed(1)} h`;
}

/**
 * How long ago an ISO time was, compact: "just now", "14 min", "2 h", "3 d", "5 mo", "2 y".
 * null -> `never`.
 */
export function formatAgo(iso: string | null | undefined, now: number = Date.now(), never = 'never'): string {
  if (!iso) return never;
  const then = Date.parse(iso);
  if (Number.isNaN(then)) return never;
  const sec = Math.max(0, (now - then) / 1000);
  if (sec < 60) return 'just now';
  if (sec < 3600) return `${Math.floor(sec / 60)} min`;
  if (sec < 86_400) return `${Math.floor(sec / 3600)} h`;
  if (sec < 86_400 * 60) return `${Math.floor(sec / 86_400)} d`;
  if (sec < 86_400 * 365) return `${Math.floor(sec / (86_400 * 30))} mo`;
  return `${Math.floor(sec / (86_400 * 365))} y`;
}

/** Local wall-clock time of an ISO string: "19:02:30" (or "19:02" without seconds). */
export function formatClock(iso: string, withSeconds = true): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const pad = (n: number) => String(n).padStart(2, '0');
  const hm = `${pad(d.getHours())}:${pad(d.getMinutes())}`;
  return withSeconds ? `${hm}:${pad(d.getSeconds())}` : hm;
}
