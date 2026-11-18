import { describe, expect, it } from 'vitest';
import { castType, classifyType, isMonospace, isRightAligned, typeLabel, type TypeInfo } from './classify';
import { byteaPreview, firstLine, oneLine, parsePgArray, previewText, timestamptzToUtc } from './preview';
import { normalizeInput, validateCellInput } from './validate';

const t = (typeName: string, typeCategory: string, type = typeName): TypeInfo => ({ type, typeName, typeCategory });

describe('classifyType', () => {
  it.each([
    [t('int2', 'N', 'smallint'), 'integer'],
    [t('int4', 'N', 'integer'), 'integer'],
    [t('int8', 'N', 'bigint'), 'integer'],
    [t('numeric', 'N', 'numeric(12,2)'), 'number'],
    [t('float4', 'N', 'real'), 'number'],
    [t('float8', 'N', 'double precision'), 'number'],
    [t('text', 'S'), 'text'],
    [t('varchar', 'S', 'character varying(40)'), 'text'],
    [t('bool', 'B', 'boolean'), 'bool'],
    [t('date', 'D'), 'date'],
    [t('timestamp', 'D', 'timestamp without time zone'), 'timestamp'],
    [t('timestamptz', 'D', 'timestamp with time zone'), 'timestamptz'],
    [t('json', 'U'), 'json'],
    [t('jsonb', 'U'), 'json'],
    [t('_text', 'A', 'text[]'), 'array'],
    [t('_int4', 'A', 'integer[]'), 'array'],
    [t('uuid', 'U'), 'uuid'],
    [t('order_status', 'E'), 'enum'],
    [t('bytea', 'U'), 'bytea'],
    [t('inet', 'I'), 'other'],
    [t('interval', 'T'), 'other'],
  ] as const)('%o is %s', (info, kind) => {
    expect(classifyType(info)).toBe(kind);
  });

  it('right-aligns and monospaces numbers only where the spec says', () => {
    expect(isRightAligned('integer')).toBe(true);
    expect(isRightAligned('number')).toBe(true);
    expect(isRightAligned('text')).toBe(false);
    expect(isMonospace('uuid')).toBe(true);
    expect(isMonospace('text')).toBe(false);
    expect(isMonospace('enum')).toBe(false);
  });
});

describe('typeLabel and castType', () => {
  it('keeps the modifier in the header label and drops it in the cast', () => {
    const numeric = t('numeric', 'N', 'numeric(12,2)');
    expect(typeLabel(numeric)).toBe('numeric(12,2)');
    expect(castType(numeric)).toBe('numeric');
    expect(typeLabel(t('timestamptz', 'D', 'timestamp with time zone'))).toBe('timestamptz');
    expect(castType(t('varchar', 'S', 'character varying(40)'))).toBe('character varying');
  });

  it('labels arrays by element type', () => {
    expect(typeLabel(t('_text', 'A', 'text[]'))).toBe('text[]');
    expect(castType(t('_text', 'A', 'text[]'))).toBe('text[]');
  });
});

describe('previewText', () => {
  it('shows integers and numerics with the exact digits from the server', () => {
    expect(previewText('integer', '9007199254740993')).toBe('9007199254740993');
    expect(previewText('number', '1194.00')).toBe('1194.00');
    expect(previewText('number', '0.1000000000000000055511151231257827')).toBe('0.1000000000000000055511151231257827');
  });

  it('shows the first line of text, marked as truncated', () => {
    expect(previewText('text', 'Leave at reception\nring twice')).toBe('Leave at reception…');
    expect(firstLine('one line')).toEqual({ text: 'one line', truncated: false });
    expect(firstLine('x'.repeat(400)).truncated).toBe(true);
  });

  it('keeps an empty string empty and leaves NULL to the NULL marker', () => {
    expect(previewText('text', '')).toBe('');
    expect(previewText('text', null)).toBeNull();
  });

  it('shows date and timestamp as given', () => {
    expect(previewText('date', '2026-11-17')).toBe('2026-11-17');
    expect(previewText('timestamp', '2026-11-17 18:42:13')).toBe('2026-11-17 18:42:13');
    expect(previewText('timestamptz', '2026-11-17 18:42:13+04')).toBe('2026-11-17 18:42:13+04');
  });

  it('previews JSON and arrays on one line', () => {
    expect(previewText('json', '{\n  "channel": "web",\n  "gift": true\n}')).toBe('{ "channel": "web", "gift": true }');
    expect(oneLine('{"a": 1}')).toBe('{"a": 1}');
    expect(previewText('array', '{gift,eco,bundle}')).toBe('{gift,eco,bundle}');
  });

  it('shows uuid in full and enums as their label', () => {
    expect(previewText('uuid', '3f1c2a9e-8b7d-4c11-9e2f-0a6b5d4c3e21')).toBe('3f1c2a9e-8b7d-4c11-9e2f-0a6b5d4c3e21');
    expect(previewText('enum', 'shipped')).toBe('shipped');
  });

  it('shows bytea as size and first bytes in hex', () => {
    const png = `\\x89504e470d0a1a0a${'00'.repeat(2450)}`;
    expect(byteaPreview(png)).toBe('2.4 kB · 89 50 4e 47 0d 0a…');
    expect(previewText('bytea', '\\x0102')).toBe('2 B · 01 02');
    expect(previewText('bytea', '\\x')).toBe('0 B');
  });

  it('shows anything else as the server text form', () => {
    expect(previewText('other', '192.168.0.1/24')).toBe('192.168.0.1/24');
    expect(previewText('other', '1 day 02:00:00')).toBe('1 day 02:00:00');
  });

  it('leaves bool to the checkbox glyph', () => {
    expect(previewText('bool', 't')).toBeNull();
  });
});

describe('timestamptzToUtc', () => {
  it('converts the local time with offset to UTC', () => {
    expect(timestamptzToUtc('2026-11-17 16:31:40+04')).toBe('2026-11-17 12:31:40');
    expect(timestamptzToUtc('2026-11-17 01:00:00+05:30')).toBe('2026-11-16 19:30:00');
    expect(timestamptzToUtc('2026-12-31 22:00:00-03')).toBe('2027-01-01 01:00:00');
  });

  it('keeps fractional seconds as text', () => {
    expect(timestamptzToUtc('2026-11-17 18:42:13.123456+04')).toBe('2026-11-17 14:42:13.123456');
  });

  it('returns null for infinity and unreadable values', () => {
    expect(timestamptzToUtc('infinity')).toBeNull();
    expect(timestamptzToUtc('2026-11-17 18:42:13')).toBeNull();
  });
});

describe('parsePgArray', () => {
  it('reads plain, quoted, NULL and nested elements', () => {
    expect(parsePgArray('{gift,eco,bundle}')).toEqual(['gift', 'eco', 'bundle']);
    expect(parsePgArray('{"a b","c,d",NULL,"NULL"}')).toEqual(['a b', 'c,d', null, 'NULL']);
    expect(parsePgArray('{{1,2},{3,4}}')).toEqual([
      ['1', '2'],
      ['3', '4'],
    ]);
    expect(parsePgArray('{"say \\"hi\\""}')).toEqual(['say "hi"']);
    expect(parsePgArray('{}')).toEqual([]);
    expect(parsePgArray('[0:1]={x,y}')).toEqual(['x', 'y']);
  });

  it('rejects malformed literals', () => {
    expect(parsePgArray('{a,b')).toBeNull();
    expect(parsePgArray('a,b')).toBeNull();
  });
});

describe('validateCellInput', () => {
  const v = (text: string, kind: Parameters<typeof validateCellInput>[1]['kind'], typeName = '') =>
    validateCellInput(text, { kind, typeName });

  it('checks integers, including int8 bounds without rounding', () => {
    expect(v('42', 'integer', 'int4')).toBeNull();
    expect(v('-9223372036854775808', 'integer', 'int8')).toBeNull();
    expect(v('9223372036854775808', 'integer', 'int8')).toMatch(/Out of range for int8/);
    expect(v('40000', 'integer', 'int2')).toMatch(/Out of range for int2/);
    expect(v('4.2', 'integer', 'int4')).toMatch(/whole number/);
    expect(v('', 'integer', 'int4')).toMatch(/whole number/);
  });

  it('checks numbers', () => {
    expect(v('1194.00', 'number')).toBeNull();
    expect(v('-.5e10', 'number')).toBeNull();
    expect(v('NaN', 'number')).toBeNull();
    expect(v('-Infinity', 'number')).toBeNull();
    expect(v('12,5', 'number')).toMatch(/number/);
  });

  it('checks dates as calendar dates', () => {
    expect(v('2026-11-17', 'date')).toBeNull();
    expect(v('2024-02-29', 'date')).toBeNull();
    expect(v('2026-02-29', 'date')).toMatch(/YYYY-MM-DD/);
    expect(v('17/11/2026', 'date')).toMatch(/YYYY-MM-DD/);
    expect(v('infinity', 'date')).toBeNull();
  });

  it('lets Postgres cast timestamps', () => {
    expect(v('tomorrow', 'timestamp')).toBeNull();
  });

  it('requires an offset on timestamptz', () => {
    expect(v('2026-11-17 18:42:13+04', 'timestamptz')).toBeNull();
    expect(v('2026-11-17T18:42:13.5Z', 'timestamptz')).toBeNull();
    expect(v('2026-11-17 18:42+05:30', 'timestamptz')).toBeNull();
    expect(v('2026-11-17 18:42:13', 'timestamptz')).toMatch(/UTC offset/);
  });

  it('checks uuid format', () => {
    expect(v('3f1c2a9e-8b7d-4c11-9e2f-0a6b5d4c3e21', 'uuid')).toBeNull();
    expect(v('3F1C2A9E8B7D4C119E2F0A6B5D4C3E21', 'uuid')).toBeNull();
    expect(v('3f1c2a9e-8b7d', 'uuid')).toMatch(/UUID/);
  });

  it('validates JSON', () => {
    expect(v('{"channel": "web"}', 'json')).toBeNull();
    expect(v('null', 'json')).toBeNull();
    expect(v('{channel: web}', 'json')).toMatch(/^Invalid JSON/);
  });

  it('checks array literals', () => {
    expect(v('{gift,eco,bundle}', 'array')).toBeNull();
    expect(v('{"a}b",c}', 'array')).toBeNull();
    expect(v('{{1,2},{3,4}}', 'array')).toBeNull();
    expect(v('gift,eco', 'array')).toMatch(/array literal/);
    expect(v('{a}{b}', 'array')).toMatch(/array literal/);
  });

  it('checks enum labels against the enum values', () => {
    expect(
      validateCellInput('paid', { kind: 'enum', typeName: 'order_status', enumValues: ['paid', 'shipped'] }),
    ).toBeNull();
    expect(validateCellInput('lost', { kind: 'enum', typeName: 'order_status', enumValues: ['paid'] })).toMatch(
      /Pick one of: paid/,
    );
  });

  it('accepts true/false for bool, refuses bytea, accepts anything for text and other types', () => {
    expect(v('true', 'bool')).toBeNull();
    expect(v('maybe', 'bool')).toMatch(/true, false/);
    expect(v('\\x00', 'bytea')).toMatch(/read-only/);
    expect(v('', 'text')).toBeNull();
    expect(v('10.0.0.1', 'other')).toBeNull();
  });

  it('trims typed values but keeps text exactly', () => {
    expect(normalizeInput(' 42 ', 'integer')).toBe('42');
    expect(normalizeInput(' hi ', 'text')).toBe(' hi ');
  });
});
