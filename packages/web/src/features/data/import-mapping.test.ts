import { describe, expect, it } from 'vitest';
import type { Column } from '@kleos/shared';
import {
  autoMap,
  importTargets,
  landedRows,
  parseNullValues,
  requestMapping,
  setMapping,
  unmappedColumns,
} from './import-mapping';

const col = (name: string, extra: Partial<Column> = {}): Column => ({
  name,
  type: 'text',
  typeName: 'text',
  typeOid: 25,
  typeCategory: 'S',
  nullable: true,
  default: null,
  identity: null,
  generated: false,
  ...extra,
});

const columns = [
  col('id', { nullable: false, identity: 'by default' }),
  col('email', { nullable: false }),
  col('Name'),
  col('status', { nullable: false, default: "'active'::text" }),
  col('search', { generated: true }),
  col('code', { nullable: false, identity: 'always' }),
];
const targets = importTargets(columns);

describe('importTargets', () => {
  it('leaves out generated columns and GENERATED ALWAYS identities', () => {
    expect(targets.map((t) => t.name)).toEqual(['id', 'email', 'Name', 'status']);
  });
});

describe('autoMap', () => {
  it('matches header names ignoring case and surrounding spaces, and skips the rest', () => {
    expect(autoMap(['EMAIL', ' name ', 'age', 'Id'], targets, true)).toEqual(['email', 'Name', null, 'id']);
  });

  it('fills one table column from one file column only', () => {
    expect(autoMap(['email', 'Email'], targets, true)).toEqual(['email', null]);
  });

  it('maps by position when the file has no header', () => {
    expect(autoMap(['column 1', 'column 2', 'column 3', 'column 4', 'column 5'], targets, false)).toEqual([
      'id',
      'email',
      'Name',
      'status',
      null,
    ]);
  });
});

describe('setMapping', () => {
  it('moves a table column to the newly picked file column', () => {
    expect(setMapping(['email', null, 'Name'], 1, 'email')).toEqual([null, 'email', 'Name']);
    expect(setMapping(['email', null, 'Name'], 2, null)).toEqual(['email', null, null]);
  });
});

describe('unmappedColumns', () => {
  it('lists table columns left to their default, flagging NOT NULL ones without any', () => {
    expect(unmappedColumns(['Name', null], targets)).toEqual([
      { name: 'id', required: false },
      { name: 'email', required: true },
      { name: 'status', required: false },
    ]);
  });
});

describe('requestMapping', () => {
  it('keeps mapped file columns with their index', () => {
    expect(requestMapping([null, 'email', null, 'Name'])).toEqual([
      { fileColumn: 1, column: 'email' },
      { fileColumn: 3, column: 'Name' },
    ]);
  });
});

describe('parseNullValues', () => {
  it('always treats empty cells as NULL and adds the markers listed', () => {
    expect(parseNullValues('')).toEqual(['']);
    expect(parseNullValues(' NULL, \\N ,NULL')).toEqual(['', 'NULL', '\\N']);
  });
});

describe('landedRows', () => {
  it('shows mapped values in mapping order, NULL markers as null', () => {
    const rows = [
      ['a@x.io', 'Ada', '36'],
      ['', 'NULL', '41'],
    ];
    expect(landedRows(rows, ['email', 'Name', null], ['', 'NULL'])).toEqual({
      columns: ['email', 'Name'],
      rows: [
        ['a@x.io', 'Ada'],
        [null, null],
      ],
    });
  });
});
