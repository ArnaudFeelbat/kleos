import { describe, expect, it } from 'vitest';
import { paletteScore } from './palette-model';

const score = (search: string, label: string, ...rest: string[]) => paletteScore('id', search, [label, ...rest]);

describe('paletteScore', () => {
  it('needs every typed word as a substring — no loose letter sequences', () => {
    expect(score('appearance', 'accounts', 'shop · shop (read-only)', 'shop', 'table')).toBe(0);
    expect(score('appearance', 'Appearance: Dark', '', 'theme')).toBeGreaterThan(0);
  });

  it('ranks label prefix, then label substring, then label words, then keywords only', () => {
    const prefix = score('order', 'order_items');
    const contains = score('items', 'order_items');
    const words = score('dark appearance', 'Appearance: Dark');
    const keywordOnly = score('theme', 'Appearance: Dark', '', 'theme');
    expect(prefix).toBeGreaterThan(contains);
    expect(contains).toBeGreaterThan(words);
    expect(words).toBeGreaterThan(keywordOnly);
    expect(keywordOnly).toBeGreaterThan(0);
  });

  it('matches the server or schema shown beside a table', () => {
    expect(score('orders prod', 'orders', 'public · prod')).toBeGreaterThan(0);
    expect(score('orders staging', 'orders', 'public · prod')).toBe(0);
  });

  it('shows everything for an empty search', () => {
    expect(score('  ', 'anything')).toBe(1);
  });
});
