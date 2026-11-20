import { describe, expect, it } from 'vitest';
import { formatSql } from './format-sql';

describe('formatSql', () => {
  it('formats PostgreSQL with lowercase keywords and a two-space indent', () => {
    const result = formatSql('SELECT id, total FROM orders WHERE total > 100 ORDER BY id');
    expect(result).toEqual({
      ok: true,
      text: 'select\n  id,\n  total\nfrom\n  orders\nwhere\n  total > 100\norder by\n  id',
    });
  });

  it('keeps $n and :name placeholders and :: casts intact', () => {
    const result = formatSql("SELECT a::INT FROM t WHERE id = :customer_id AND d > $1 AND s = 'a:b'");
    expect(result.ok && result.text).toBe(
      "select\n  a::int\nfrom\n  t\nwhere\n  id = :customer_id\n  and d > $1\n  and s = 'a:b'",
    );
  });

  it('keeps dollar-quoted bodies whole and the blank space around the SQL', () => {
    const result = formatSql('\n  do $$ begin perform 1; end $$  \n');
    expect(result.ok && result.text).toBe('\n  do $$ begin perform 1; end $$  \n');
  });

  it('reports a parse failure with its line, offset by where the SQL starts', () => {
    expect(formatSql("select 'open", 12)).toEqual({
      ok: false,
      message: 'Couldn’t format: the SQL doesn’t parse near line 12, column 8. Nothing changed.',
    });
  });

  it('leaves blank SQL as it is', () => {
    expect(formatSql('  \n')).toEqual({ ok: true, text: '  \n' });
  });
});
