import { describe, expect, it } from 'vitest';
import { errorRange } from './error-position';
import { bindPlaceholders, findPlaceholders, placeholderKeys } from './params';

const keys = (sql: string) => findPlaceholders(sql).map((p) => p.key);

describe('findPlaceholders', () => {
  it('finds $n and :name placeholders with their offsets', () => {
    const sql = 'select * from orders where customer_id = :customer and total > $1';
    expect(findPlaceholders(sql)).toEqual([
      { key: ':customer', from: sql.indexOf(':customer'), to: sql.indexOf(':customer') + 9 },
      { key: '$1', from: sql.indexOf('$1'), to: sql.indexOf('$1') + 2 },
    ]);
  });

  it('does not take casts, := or array slices for placeholders', () => {
    expect(keys("select total::numeric, '1'::int, x ::text from t")).toEqual([]);
    expect(keys('select arr[1:2], arr[lo:hi], arr[:3] from t')).toEqual([]);
    expect(keys('select f(a := 1)')).toEqual([]);
    // A cast right after a placeholder keeps the placeholder.
    expect(keys('select :day::date, $2::int')).toEqual([':day', '$2']);
  });

  it('ignores strings, comments, quoted identifiers and dollar-quoted bodies', () => {
    const sql = [
      "select ':a', E'\\':b', \"col:c\" -- :d $1",
      '/* :e /* $2 */ */ from t',
      "where x = $$ :f $3 $$ and y = $tag$ :g $tag$ and z = '$4'",
    ].join('\n');
    expect(keys(sql)).toEqual([]);
  });

  it('does not take identifiers with a dollar, or $0, for placeholders', () => {
    expect(keys('select a$1, $0, $1')).toEqual(['$1']);
  });
});

describe('placeholderKeys', () => {
  it('lists each placeholder once: $n in number order, then names in order of appearance', () => {
    expect(placeholderKeys('select :b, $2, :a, $1, :b, $2')).toEqual(['$1', '$2', ':b', ':a']);
  });

  it('collects the placeholders of a whole script', () => {
    expect(placeholderKeys(['select :day', 'delete from t where d < :day and id = $1'])).toEqual(['$1', ':day']);
  });
});

describe('bindPlaceholders', () => {
  it('leaves SQL without placeholders alone', () => {
    const bound = bindPlaceholders('select 1', { ':x': '1' });
    expect(bound).toMatchObject({ sql: 'select 1', params: [], keys: [] });
    expect(bound.sourcePosition(5)).toBe(5);
  });

  it('rewrites :name to $n and sends the values in that order; the same name is one parameter', () => {
    const bound = bindPlaceholders('select * from t where a = :from and b < :to and c > :from', {
      ':from': '2026-01-01',
      ':to': null,
    });
    expect(bound.sql).toBe('select * from t where a = $1 and b < $2 and c > $1');
    expect(bound.params).toEqual(['2026-01-01', null]);
    expect(bound.keys).toEqual([':from', ':to']);
  });

  it('renumbers a statement’s own placeholders, $n first, then names', () => {
    const bound = bindPlaceholders('select :day, $3', { $1: 'one', $3: 'three', ':day': 'd' });
    expect(bound.sql).toBe('select $2, $1');
    expect(bound.params).toEqual(['three', 'd']);
  });

  it('leaves casts and strings untouched while rewriting', () => {
    const bound = bindPlaceholders("select :n::int, ':n'", { ':n': '4' });
    expect(bound.sql).toBe("select $1::int, ':n'");
  });

  it('maps an error position in the rewritten SQL back to the statement as written', () => {
    const sql = 'select :customer_id, ñ.stauts from t';
    const bound = bindPlaceholders(sql, { ':customer_id': '1' });
    expect(bound.sql).toBe('select $1, ñ.stauts from t');
    const rewritten = [...bound.sql].indexOf('ñ') + 1;
    const original = bound.sourcePosition(rewritten);
    const r = errorRange(sql, 0, sql, original);
    expect(sql.slice(r.from, r.to)).toBe('ñ.stauts');
    // Inside the placeholder itself, the position points at its start.
    expect(bound.sourcePosition(8)).toBe(8);
    expect(bound.sourcePosition(3)).toBe(3);
  });
});
