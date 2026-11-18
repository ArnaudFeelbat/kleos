import { describe, expect, it } from 'vitest';
import { quoteIdent, splitStatements, statementAt } from './sql';

describe('splitStatements', () => {
  it('splits on top-level semicolons and trims', () => {
    const sql = 'select 1;\n  select 2 ;\nselect 3';
    expect(splitStatements(sql).map((s) => s.text)).toEqual(['select 1', 'select 2', 'select 3']);
  });

  it('ignores semicolons inside strings, identifiers and comments', () => {
    const sql = [
      'select \'a;b\', "c;d" from t; -- x; y',
      "select E'it\\'s; fine';",
      '/* a; /* nested; */ still; */ select 4;',
      'select $$ body; $$, $fn$ x; $fn$;',
    ].join('\n');
    expect(splitStatements(sql).map((s) => s.text)).toEqual([
      'select \'a;b\', "c;d" from t',
      "-- x; y\nselect E'it\\'s; fine'",
      '/* a; /* nested; */ still; */ select 4',
      'select $$ body; $$, $fn$ x; $fn$',
    ]);
  });

  it('drops comment-only statements', () => {
    expect(splitStatements('-- just a note\n;  ;select 1')).toHaveLength(1);
  });

  it('reports offsets into the original text', () => {
    const sql = 'select 1;\n\nselect 2;';
    const [, second] = splitStatements(sql);
    expect(sql.slice(second!.from, second!.to)).toBe('select 2');
  });
});

describe('statementAt', () => {
  const sql = 'select 1;\n\nselect 2;\n\nselect 3';
  it('returns the statement containing the cursor', () => {
    expect(statementAt(sql, sql.indexOf('2'))?.text).toBe('select 2');
  });
  it('treats a cursor right after the semicolon as the statement before it', () => {
    expect(statementAt(sql, sql.indexOf('2') + 2)?.text).toBe('select 2');
  });
  it('falls back to the closest statement before a blank line', () => {
    expect(statementAt(sql, sql.indexOf('2') + 3)?.text).toBe('select 2');
  });
  it('returns null for empty input', () => {
    expect(statementAt('  -- nothing', 3)).toBeNull();
  });
});

describe('quoteIdent', () => {
  it('doubles embedded quotes', () => {
    expect(quoteIdent('we"ird')).toBe('"we""ird"');
  });
});
