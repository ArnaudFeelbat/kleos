import type { CellValue, Filter, FilterOperator, ForeignKey, SchemaModel, TableRef } from '@kleos/shared';

/** One removable chip of the filter bar. */
export type FilterChip = { id: string; column: string; op: FilterOperator; value: string };

export const operatorLabels: Record<FilterOperator, string> = {
  eq: '=',
  neq: '≠',
  contains: 'contains',
  gt: '>',
  gte: '≥',
  lt: '<',
  lte: '≤',
  isNull: 'is null',
  isNotNull: 'is not null',
};

/** Words for screen readers and menus, where symbols read badly. */
export const operatorNames: Record<FilterOperator, string> = {
  eq: 'equals',
  neq: 'not equals',
  contains: 'contains',
  gt: 'greater than',
  gte: 'greater than or equal',
  lt: 'less than',
  lte: 'less than or equal',
  isNull: 'is null',
  isNotNull: 'is not null',
};

export function operatorNeedsValue(op: FilterOperator): boolean {
  return op !== 'isNull' && op !== 'isNotNull';
}

/** The API filter for a chip; null tests carry no value. */
export function chipToFilter(chip: FilterChip): Filter {
  return operatorNeedsValue(chip.op)
    ? { column: chip.column, op: chip.op, value: chip.value }
    : { column: chip.column, op: chip.op };
}

export function chipsToFilters(chips: readonly FilterChip[]): Filter[] {
  return chips.map(chipToFilter);
}

/** Accessible description of a chip, e.g. "placed_at greater than or equal 2026-11-01". */
export function chipDescription(chip: FilterChip): string {
  return operatorNeedsValue(chip.op)
    ? `${chip.column} ${operatorNames[chip.op]} ${chip.value}`
    : `${chip.column} ${operatorNames[chip.op]}`;
}

/** Foreign keys of a table, by each of their columns. */
export function foreignKeysByColumn(model: SchemaModel | undefined, table: TableRef): Map<string, ForeignKey> {
  const map = new Map<string, ForeignKey>();
  for (const fk of model?.foreignKeys ?? []) {
    if (fk.schema !== table.schema || fk.table !== table.name) continue;
    for (const c of fk.columns) if (!map.has(c)) map.set(c, fk);
  }
  return map;
}

/**
 * Where a foreign-key link leads: the referenced table, filtered on each referenced column
 * equal to this row's value. Null when any of the row's key columns is NULL (it references
 * nothing) or missing from the row.
 */
export function foreignKeyTarget(
  fk: ForeignKey,
  row: Record<string, CellValue | undefined>,
  makeId: () => string,
): { table: TableRef; chips: FilterChip[] } | null {
  const chips: FilterChip[] = [];
  for (let i = 0; i < fk.columns.length; i += 1) {
    const value = row[fk.columns[i]!];
    const refColumn = fk.refColumns[i];
    if (value === null || value === undefined || refColumn === undefined) return null;
    chips.push({ id: makeId(), column: refColumn, op: 'eq', value });
  }
  return { table: { schema: fk.refSchema, name: fk.refTable }, chips };
}
