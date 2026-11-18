import type { ColumnMeta } from '@kleos/shared';

/**
 * How a Postgres value is shown and edited, per the "Postgres type handling" table of the
 * spec. Every value arrives as text (or null); the kind decides alignment, font, preview
 * and editor, never a JavaScript conversion of the value itself.
 */
export type CellKind =
  | 'integer'
  | 'number'
  | 'text'
  | 'bool'
  | 'date'
  | 'timestamp'
  | 'timestamptz'
  | 'json'
  | 'array'
  | 'uuid'
  | 'enum'
  | 'bytea'
  | 'other';

export type TypeInfo = Pick<ColumnMeta, 'type' | 'typeName' | 'typeCategory'>;

const kindByTypeName: Record<string, CellKind> = {
  int2: 'integer',
  int4: 'integer',
  int8: 'integer',
  numeric: 'number',
  float4: 'number',
  float8: 'number',
  text: 'text',
  varchar: 'text',
  bpchar: 'text',
  name: 'text',
  citext: 'text',
  bool: 'bool',
  date: 'date',
  timestamp: 'timestamp',
  timestamptz: 'timestamptz',
  json: 'json',
  jsonb: 'json',
  uuid: 'uuid',
  bytea: 'bytea',
};

/** Classifies a column from its type name and pg_type category (A array, E enum, ...). */
export function classifyType(t: TypeInfo): CellKind {
  if (t.typeCategory === 'A' || t.typeName.startsWith('_')) return 'array';
  if (t.typeCategory === 'E') return 'enum';
  return kindByTypeName[t.typeName] ?? 'other';
}

/** Right-aligned digits for numbers; everything else reads left to right. */
export function isRightAligned(kind: CellKind): boolean {
  return kind === 'integer' || kind === 'number';
}

/** Data that is compared character by character is set in Geist Mono. */
export function isMonospace(kind: CellKind): boolean {
  return kind !== 'text' && kind !== 'enum' && kind !== 'bool';
}

/** Range of the integer types, as BigInt so int8 bounds stay exact. */
export const integerRanges: Record<string, readonly [bigint, bigint]> = {
  int2: [-32768n, 32767n],
  int4: [-2147483648n, 2147483647n],
  int8: [-9223372036854775808n, 9223372036854775807n],
};

/**
 * Short type label for a column header: the type name plus its modifier when it has one
 * ("numeric(12,2)", "varchar(40)"), arrays as "text[]".
 */
export function typeLabel(t: TypeInfo): string {
  if (t.typeCategory === 'A' || t.typeName.startsWith('_')) {
    const element = t.typeName.startsWith('_') ? t.typeName.slice(1) : t.typeName;
    return `${element}[]`;
  }
  const modifier = /\(([^)]*)\)/.exec(t.type);
  return modifier ? `${t.typeName}(${modifier[1]})` : t.typeName;
}

/**
 * The type a value is cast to in reviewable SQL: format_type without its modifier, so
 * "numeric(12,2)" reads "numeric" and "character varying(40)" reads "character varying".
 */
export function castType(t: TypeInfo): string {
  return t.type.replace(/\s*\([^)]*\)/g, '').trim() || t.typeName;
}
