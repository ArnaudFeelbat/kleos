import { describe, expect, it } from 'vitest';
import { splitScript, sqlRegions, statementAtOffset } from './sql-script';

const texts = (sql: string) => splitScript(sql).map((s) => s.text);

describe('splitScript', () => {
  it('splits on top-level semicolons, with offsets that point back into the script', () => {
    const sql = 'select 1;\n  select 2 ;\nselect 3';
    const statements = splitScript(sql);
    expect(statements.map((s) => s.text)).toEqual(['select 1', 'select 2', 'select 3']);
    for (const s of statements) expect(sql.slice(s.from, s.to)).toBe(s.text);
    expect(statements.map((s) => s.line)).toEqual([1, 2, 3]);
  });

  it('skips empty statements and statements holding only comments', () => {
    expect(texts(';;  ; select 1;;\n-- just a note\n;/* gone */;')).toEqual(['select 1']);
    expect(texts('')).toEqual([]);
    expect(texts('   \n  ')).toEqual([]);
  });

  it('keeps semicolons inside single-quoted strings, with doubled-quote escapes', () => {
    expect(texts("select 'a;b', 'it''s; fine'; select 2")).toEqual(["select 'a;b', 'it''s; fine'", 'select 2']);
  });

  it('keeps semicolons inside E strings, whose backslash escapes a quote', () => {
    expect(texts("select E'it\\'s; ok'; select 2")).toEqual(["select E'it\\'s; ok'", 'select 2']);
    // A plain string ending in a backslash is not an E string: the quote closes it.
    expect(texts("select 'C:\\'; select 2")).toEqual(["select 'C:\\'", 'select 2']);
    // "type'…'" is a typed literal, not an E string, even though the identifier ends in e.
    expect(texts("select type'a\\'; select 2")).toEqual(["select type'a\\'", 'select 2']);
  });

  it('keeps semicolons inside double-quoted identifiers', () => {
    expect(texts('select 1 as "a;b"""; select 2')).toEqual(['select 1 as "a;b"""', 'select 2']);
  });

  it('keeps a function body with semicolons whole in $$ and $tag$ quotes', () => {
    const fn = [
      'create function touch() returns trigger language plpgsql as $$',
      'begin',
      '  new.updated_at := now();',
      '  return new;',
      'end $$',
    ].join('\n');
    const tagged = "do $body$ begin perform 1; raise notice '$$'; end $body$";
    expect(texts(`${fn};\n${tagged};\nselect 3`)).toEqual([fn, tagged, 'select 3']);
  });

  it('does not take $1 or an identifier with a dollar for a dollar quote', () => {
    expect(texts('select $1; select a$b$c; select 3')).toEqual(['select $1', 'select a$b$c', 'select 3']);
  });

  it('ignores semicolons in line comments and nested block comments', () => {
    const sql = 'select 1 -- not here;\n/* outer /* inner; */ still; */ + 1; select 2';
    expect(texts(sql)).toEqual(['select 1 -- not here;\n/* outer /* inner; */ still; */ + 1', 'select 2']);
    // A comment-only statement with a nested comment is still empty.
    expect(texts('/* a /* b */ c */; select 1')).toEqual(['select 1']);
  });

  it('runs an unterminated string or comment to the end of the script', () => {
    expect(texts("select 'open; select 2")).toEqual(["select 'open; select 2"]);
    expect(texts('select 1; /* open; select 2')).toEqual(['select 1']);
  });

  it('gives the line and the first line of code of each statement, past leading comments', () => {
    const sql = [
      '-- migration 12',
      'begin;',
      '',
      '/* add the column */',
      'alter table orders',
      '  add column note text;',
      "insert into t values ('a;b'); commit;",
    ].join('\n');
    const statements = splitScript(sql);
    expect(statements.map((s) => [s.line, s.preview])).toEqual([
      [2, 'begin'],
      [5, 'alter table orders'],
      [7, "insert into t values ('a;b')"],
      [7, 'commit'],
    ]);
    // The leading comment stays part of the statement that is sent.
    expect(statements[0]!.text).toBe('-- migration 12\nbegin');
    expect(sql.slice(statements[1]!.codeFrom).startsWith('alter table')).toBe(true);
  });

  it('handles a twenty-statement migration', () => {
    const sql = Array.from({ length: 20 }, (_, i) => `insert into log values (${i + 1}, 'step; ${i + 1}');`).join('\n');
    const statements = splitScript(sql);
    expect(statements).toHaveLength(20);
    expect(statements[19]).toMatchObject({ line: 20, text: "insert into log values (20, 'step; 20')" });
  });
});

describe('sqlRegions', () => {
  it('covers the whole script with code, string, identifier, dollar and comment regions', () => {
    const sql = `select 'a', "b", $$c$$ -- d\n/* e */`;
    const regions = sqlRegions(sql);
    expect(regions.map((r) => [r.kind, sql.slice(r.from, r.to)])).toEqual([
      ['code', 'select '],
      ['string', "'a'"],
      ['code', ', '],
      ['identifier', '"b"'],
      ['code', ', '],
      ['dollar', '$$c$$'],
      ['code', ' '],
      ['comment', '-- d'],
      ['code', '\n'],
      ['comment', '/* e */'],
    ]);
  });
});

describe('statementAtOffset', () => {
  const sql = 'select 1;\nselect 2;\n\nselect 3';
  it('finds the statement under the cursor, including right after its semicolon', () => {
    expect(statementAtOffset(sql, sql.indexOf('2'))?.text).toBe('select 2');
    expect(statementAtOffset(sql, sql.indexOf('2') + 2)?.text).toBe('select 2');
  });
  it('falls back to the statement before the cursor, then the first one', () => {
    expect(statementAtOffset(sql, sql.indexOf('\n\n') + 1)?.text).toBe('select 2');
    expect(statementAtOffset('  -- nothing', 3)).toBeNull();
  });
});
