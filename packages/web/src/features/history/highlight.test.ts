import { describe, expect, it } from 'vitest';
import { matchRanges, previewWithMatches, searchWords } from './highlight';

const marked = (text: string, query: string) => matchRanges(text, query).map((r) => text.slice(r.start, r.end));

describe('searchWords', () => {
  it('lowercases, trims outer punctuation and drops words without a letter or digit', () => {
    expect(searchWords("  Orders 'PAID' ; -- o.stat ")).toEqual(['orders', 'paid', 'o.stat']);
  });
});

describe('matchRanges', () => {
  it('matches every word as a token prefix, case-insensitively', () => {
    expect(marked('select * from Orders o where o.status = 1', 'ord stat')).toEqual(['Ord', 'stat']);
  });

  it('treats _ and . as token separators like the server, but never matches inside a token', () => {
    expect(marked('select order_status, o.status from estate', 'status')).toEqual(['status', 'status']);
  });

  it('merges overlapping matches and sorts them', () => {
    expect(matchRanges('orders', 'or ord orders')).toEqual([{ start: 0, end: 6 }]);
    expect(matchRanges('b a', 'a b')).toEqual([
      { start: 0, end: 1 },
      { start: 2, end: 3 },
    ]);
  });

  it('matches nothing for an empty search', () => {
    expect(matchRanges('select 1', '  ')).toEqual([]);
  });
});

describe('previewWithMatches', () => {
  it('collapses whitespace and keeps an early match where it is', () => {
    expect(previewWithMatches('select\n  *\n from orders', 'orders')).toEqual({
      text: 'select * from orders',
      ranges: [{ start: 14, end: 20 }],
    });
  });

  it('starts shortly before a late first match, behind an ellipsis, with ranges shifted', () => {
    const sql = `select id, customer_id, created_at, total, currency from orders where status = 'refunded'`;
    const preview = previewWithMatches(sql, 'refunded');
    expect(preview.text.startsWith('…')).toBe(true);
    expect(preview.text.endsWith("status = 'refunded'")).toBe(true);
    const [range] = preview.ranges;
    expect(preview.text.slice(range!.start, range!.end)).toBe('refunded');
  });
});
