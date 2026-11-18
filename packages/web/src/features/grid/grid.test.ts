import { describe, expect, it } from 'vitest';
import { formatJsonExact, parseJsonExact } from '@/features/cells/json';
import { formatRows } from './copy';
import { defaultColumnWidth } from './layout';
import { isCellSelected, moveSelection, selectedRows, tabSelection } from './selection';
import type { GridSelection } from './types';

const size = { rows: 10, cols: 4, pageRows: 5 };
const at = (row: number, col: number): GridSelection => ({ anchor: { row, col }, focus: { row, col } });

describe('moveSelection', () => {
  it('moves with arrows and clamps at the edges', () => {
    expect(moveSelection(at(0, 0), 'up', false, size)).toEqual(at(0, 0));
    expect(moveSelection(at(0, 0), 'down', false, size)).toEqual(at(1, 0));
    expect(moveSelection(at(0, 3), 'right', false, size)).toEqual(at(0, 3));
    expect(moveSelection(at(4, 2), 'pageDown', false, size)).toEqual(at(9, 2));
    expect(moveSelection(at(4, 2), 'home', false, size)).toEqual(at(4, 0));
    expect(moveSelection(at(4, 2), 'last', false, size)).toEqual(at(9, 2));
  });

  it('starts at the first cell when nothing is selected', () => {
    expect(moveSelection(null, 'down', false, size)).toEqual(at(0, 0));
  });

  it('extends the range with Shift and keeps the anchor', () => {
    const sel = moveSelection(moveSelection(at(2, 1), 'down', true, size), 'right', true, size)!;
    expect(sel).toEqual({ anchor: { row: 2, col: 1 }, focus: { row: 3, col: 2 } });
    expect(selectedRows(sel, 4)).toEqual([2, 3]);
    expect(isCellSelected(sel, { row: 3, col: 1 }, 4)).toBe(true);
    expect(isCellSelected(sel, { row: 3, col: 3 }, 4)).toBe(false);
  });

  it('treats a row selection as covering every column', () => {
    const sel: GridSelection = { anchor: { row: 1, col: 0 }, focus: { row: 2, col: 0 }, rows: true };
    expect(isCellSelected(sel, { row: 2, col: 3 }, 4)).toBe(true);
  });

  it('returns null for an empty grid', () => {
    expect(moveSelection(null, 'down', false, { rows: 0, cols: 3, pageRows: 5 })).toBeNull();
  });
});

describe('tabSelection', () => {
  it('moves right and wraps to the next row', () => {
    expect(tabSelection(at(0, 2), false, size)).toEqual(at(0, 3));
    expect(tabSelection(at(0, 3), false, size)).toEqual(at(1, 0));
    expect(tabSelection(at(1, 0), true, size)).toEqual(at(0, 3));
    expect(tabSelection(at(9, 3), false, size)).toEqual(at(9, 3));
  });
});

describe('formatRows', () => {
  const rows = [
    ['1', 'plain', null],
    ['2', 'with, comma', ''],
    ['3', 'say "hi"\nthere', 'tab\there'],
  ];

  it('writes CSV with NULL empty and empty string quoted', () => {
    expect(formatRows(rows, 'csv', ['id', 'note', 'extra'])).toBe(
      'id,note,extra\n1,plain,\n2,"with, comma",""\n3,"say ""hi""\nthere",tab\there',
    );
  });

  it('writes TSV, quoting only fields with tabs, quotes or line breaks', () => {
    expect(formatRows(rows, 'tsv')).toBe('1\tplain\t\n2\twith, comma\t\n3\t"say ""hi""\nthere"\t"tab\there"');
  });
});

describe('defaultColumnWidth', () => {
  it('gives uuids room for all 36 characters and widens for long names', () => {
    expect(defaultColumnWidth({ key: 'a', name: 'id', kind: 'uuid', typeLabel: 'uuid' })).toBeGreaterThanOrEqual(300);
    const long = defaultColumnWidth({
      key: 'b',
      name: 'a_very_long_column_name_here',
      kind: 'bool',
      typeLabel: 'bool',
    });
    expect(long).toBeGreaterThan(200);
  });
});

describe('parseJsonExact', () => {
  it('keeps every digit of large numbers', () => {
    const node = parseJsonExact('{"id": 9007199254740993, "ratio": 0.1000000000000000055511151231257827}');
    expect(node).toEqual({
      t: 'obj',
      v: [
        ['id', { t: 'num', v: '9007199254740993' }],
        ['ratio', { t: 'num', v: '0.1000000000000000055511151231257827' }],
      ],
    });
  });

  it('reads nested arrays, strings with escapes, booleans and null', () => {
    const node = parseJsonExact('[true, null, "a\\"b", {"x": []}]');
    expect(node).toEqual({
      t: 'arr',
      v: [{ t: 'bool', v: true }, { t: 'null' }, { t: 'str', v: 'a"b' }, { t: 'obj', v: [['x', { t: 'arr', v: [] }]] }],
    });
  });

  it('returns null for invalid JSON', () => {
    expect(parseJsonExact('{channel: web}')).toBeNull();
    expect(parseJsonExact('[1, 2')).toBeNull();
    expect(parseJsonExact('1 2')).toBeNull();
  });

  it('formats with indentation without touching digits', () => {
    expect(formatJsonExact(parseJsonExact('{"a":[1,9007199254740993],"b":{}}')!)).toBe(
      '{\n  "a": [\n    1,\n    9007199254740993\n  ],\n  "b": {}\n}',
    );
  });
});
