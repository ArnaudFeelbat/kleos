import type { CellValue, Column, ImportRequest } from '@kleos/shared';

/**
 * Where each file column goes in a CSV import: `mapping[i]` is the table column that file
 * column `i` fills, or null to skip it. Table columns no file column maps to take their
 * DEFAULT (the server leaves them out of the INSERT).
 */
export type ColumnMapping = (string | null)[];

/** A table column an import can write: not generated, not GENERATED ALWAYS AS IDENTITY. */
export function importTargets(columns: readonly Column[]): Column[] {
  return columns.filter((c) => !c.generated && c.identity !== 'always');
}

const norm = (s: string) => s.trim().toLowerCase();

/**
 * First guess at the mapping. With a header, each file column goes to the table column of
 * the same name (ignoring case and surrounding spaces); without one there are no names to
 * match, so file columns fill the table's columns in order.
 */
export function autoMap(fileColumns: readonly string[], targets: readonly Column[], hasHeader: boolean): ColumnMapping {
  if (!hasHeader) return fileColumns.map((_, i) => targets[i]?.name ?? null);
  const byName = new Map<string, string>();
  for (const t of targets) if (!byName.has(norm(t.name))) byName.set(norm(t.name), t.name);
  const used = new Set<string>();
  return fileColumns.map((name) => {
    const hit = byName.get(norm(name));
    if (!hit || used.has(hit)) return null;
    used.add(hit);
    return hit;
  });
}

/** Sets file column `index` to `column`; a table column fills from one file column only. */
export function setMapping(mapping: ColumnMapping, index: number, column: string | null): ColumnMapping {
  return mapping.map((c, i) => (i === index ? column : column !== null && c === column ? null : c));
}

export type UnmappedColumn = {
  name: string;
  /** NOT NULL without a default: every imported row would fail on it. */
  required: boolean;
};

/** Table columns no file column fills, in table order; they take their default. */
export function unmappedColumns(mapping: ColumnMapping, targets: readonly Column[]): UnmappedColumn[] {
  const mapped = new Set(mapping.filter((c): c is string => c !== null));
  return targets
    .filter((t) => !mapped.has(t.name))
    .map((t) => ({ name: t.name, required: !t.nullable && t.default === null && t.identity === null }));
}

/** The request's mapping: mapped file columns only, by index. */
export function requestMapping(mapping: ColumnMapping): ImportRequest['mapping'] {
  return mapping.flatMap((column, fileColumn) => (column === null ? [] : [{ fileColumn, column }]));
}

/**
 * "Treat as NULL" text -> the request's nullValues. Empty means empty cells; several
 * markers can be given separated by commas ("NULL, \N"), and empty cells stay NULL too.
 */
export function parseNullValues(text: string): string[] {
  const markers = text
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s !== '');
  return ['', ...new Set(markers)];
}

/** Preview rows as they will land: one value per mapped column, NULL markers as null. */
export function landedRows(
  rows: readonly (readonly string[])[],
  mapping: ColumnMapping,
  nullValues: readonly string[],
): { columns: string[]; rows: CellValue[][] } {
  const picked = requestMapping(mapping);
  const nulls = new Set(nullValues);
  return {
    columns: picked.map((m) => m.column),
    rows: rows.map((row) =>
      picked.map(({ fileColumn }) => {
        const text = row[fileColumn] ?? '';
        return nulls.has(text) ? null : text;
      }),
    ),
  };
}
