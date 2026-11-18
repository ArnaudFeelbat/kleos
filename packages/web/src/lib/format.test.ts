import { describe, expect, it } from 'vitest';
import {
  formatAgo,
  formatBytes,
  formatClock,
  formatCompact,
  formatDuration,
  formatInt,
  formatMs,
  formatPercent,
  formatRowEstimate,
} from './format';

describe('formatBytes', () => {
  it('uses binary units with three significant digits', () => {
    expect(formatBytes(0)).toBe('0 B');
    expect(formatBytes(512)).toBe('512 B');
    expect(formatBytes(112 * 1024)).toBe('112 kB');
    expect(formatBytes(9.8 * 1024 ** 2)).toBe('9.8 MB');
    expect(formatBytes(68 * 1024 ** 2)).toBe('68 MB');
    expect(formatBytes(412 * 1024 ** 2)).toBe('412 MB');
    expect(formatBytes(61.2 * 1024 ** 3)).toBe('61.2 GB');
  });

  it('rejects nonsense', () => {
    expect(formatBytes(-1)).toBe('—');
    expect(formatBytes(Number.NaN)).toBe('—');
  });
});

describe('formatCompact', () => {
  it('keeps exact digits below ten thousand', () => {
    expect(formatCompact(48)).toBe('48');
    expect(formatCompact(2184)).toBe('2,184');
    expect(formatCompact(9999)).toBe('9,999');
  });

  it('compacts larger counts', () => {
    expect(formatCompact(12_400)).toBe('12.4k');
    expect(formatCompact(41_000)).toBe('41k');
    expect(formatCompact(812_345)).toBe('812k');
    expect(formatCompact(1_204_380)).toBe('1.2M');
    expect(formatCompact(48_200_000)).toBe('48.2M');
    expect(formatCompact(122_000_000)).toBe('122M');
    expect(formatCompact(3_000_000_000)).toBe('3B');
  });

  it('hides never-analyzed estimates', () => {
    expect(formatRowEstimate(-1)).toBeNull();
    expect(formatRowEstimate(12_400)).toBe('12.4k');
  });
});

describe('formatDuration', () => {
  it('formats seconds, minutes, hours and days', () => {
    expect(formatDuration(0)).toBe('0.0s');
    expect(formatDuration(12.84)).toBe('12.8s');
    expect(formatDuration(65)).toBe('1m 05s');
    expect(formatDuration(252)).toBe('4m 12s');
    expect(formatDuration(7380)).toBe('2h 03m');
    expect(formatDuration(3 * 86_400 + 4 * 3600)).toBe('3d 4h');
    expect(formatDuration(null)).toBe('—');
  });
});

describe('formatMs', () => {
  it('picks a unit by magnitude', () => {
    expect(formatMs(0.11)).toBe('0.11 ms');
    expect(formatMs(3.1)).toBe('3.1 ms');
    expect(formatMs(412.4)).toBe('412 ms');
    expect(formatMs(2840)).toBe('2.84 s');
    expect(formatMs(57 * 60_000)).toBe('57.0 min');
    expect(formatMs(5_400_000)).toBe('1.5 h');
  });
});

describe('formatAgo', () => {
  const now = Date.parse('2026-11-18T12:00:00Z');
  it('is compact and says never for null', () => {
    expect(formatAgo(null, now)).toBe('never');
    expect(formatAgo('2026-11-18T11:59:30Z', now)).toBe('just now');
    expect(formatAgo('2026-11-18T11:46:00Z', now)).toBe('14 min');
    expect(formatAgo('2026-11-18T10:00:00Z', now)).toBe('2 h');
    expect(formatAgo('2026-11-15T12:00:00Z', now)).toBe('3 d');
    expect(formatAgo('2026-05-18T12:00:00Z', now)).toBe('6 mo');
  });
});

describe('small helpers', () => {
  it('formats ints, percents and clock times', () => {
    expect(formatInt(1_204_380)).toBe('1,204,380');
    expect(formatPercent(0.9921)).toBe('99.2%');
    expect(formatPercent(null)).toBe('—');
    expect(formatClock(new Date(2026, 10, 18, 19, 2, 30).toISOString())).toBe('19:02:30');
    expect(formatClock(new Date(2026, 10, 18, 19, 2, 30).toISOString(), false)).toBe('19:02');
  });
});
