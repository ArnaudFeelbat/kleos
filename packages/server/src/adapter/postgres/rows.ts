import {
  type CountRequest,
  type CountResult,
  type Filter,
  type RowsPage,
  type RowsRequest,
  type SortKey,
  quoteIdent,
} from '@kleos/shared';
import { KleosError } from '../../errors';
import { type TableInfo, columnOf, loadTable } from './table';
import { type Queryable, dataQuery } from './types';

const comparators = { eq: '=', neq: '<>', gt: '>', gte: '>=', lt: '<', lte: '<=' } as const;

/** Escapes LIKE wildcards so `contains` matches the text literally (backslash is the default escape). */
export function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, (ch) => `\\${ch}`);
}

/**
 * Compiles filters and the raw WHERE box into one condition. Filter values become parameters
 * cast to the column's type; identifiers are quoted. The raw WHERE text is the one deliberate
 * exception: it is the user's own SQL, parenthesized (on its own lines, so a trailing `--`
 * comment cannot swallow what follows) and run over the extended protocol, which refuses a
 * second statement.
 */
export function whereClause(table: TableInfo, filters: Filter[], where: string | undefined, params: unknown[]): string {
  const parts: string[] = [];
  for (const filter of filters) {
    const column = columnOf(table, filter.column);
    const ident = quoteIdent(column.name);
    switch (filter.op) {
      case 'isNull':
        parts.push(`${ident} is null`);
        break;
      case 'isNotNull':
        parts.push(`${ident} is not null`);
        break;
      case 'contains':
        params.push(`%${escapeLike(requireValue(filter))}%`);
        parts.push(`${ident}::text ilike $${params.length}`);
        break;
      default:
        params.push(requireValue(filter));
        parts.push(`${ident} ${comparators[filter.op]} $${params.length}::${column.type}`);
    }
  }
  const raw = where?.trim().replace(/;\s*$/, '').trim();
  if (raw) parts.push(`(\n${raw}\n)`);
  return parts.length > 0 ? `\nwhere ${parts.join('\n  and ')}` : '';
}

function requireValue(filter: Filter): string {
  if (filter.value === undefined) {
    throw KleosError.validation(`Filter "${filter.op}" on "${filter.column}" needs a value`);
  }
  return filter.value;
}

/**
 * ORDER BY for the requested sort, followed by the primary-key columns not already sorted on,
 * so paging with LIMIT/OFFSET is stable. Views and tables without a key get no implicit order.
 * Exports reuse it with the WHERE above, so a file holds exactly what the grid shows.
 */
export function orderBy(table: TableInfo, sort: SortKey[]): string {
  const keys = sort.map((s) => `${quoteIdent(columnOf(table, s.column).name)} ${s.dir === 'desc' ? 'desc' : 'asc'}`);
  const sorted = new Set(sort.map((s) => s.column));
  for (const pk of table.primaryKey) {
    if (!sorted.has(pk)) keys.push(`${quoteIdent(pk)} asc`);
  }
  return keys.length > 0 ? `\norder by ${keys.join(', ')}` : '';
}

export async function fetchRows(q: Queryable, req: RowsRequest): Promise<RowsPage> {
  const started = performance.now();
  const table = await loadTable(q, req.table);
  const params: unknown[] = [];
  const where = whereClause(table, req.filters, req.where, params);
  const order = orderBy(table, req.sort);
  params.push(req.limit + 1, req.offset);
  const sql = `select * from ${table.sql}${where}${order}\nlimit $${params.length - 1} offset $${params.length}`;
  const result = await dataQuery(q, sql, params);
  const hasMore = result.rows.length > req.limit;
  return {
    columns: table.columns,
    rows: hasMore ? result.rows.slice(0, req.limit) : result.rows,
    hasMore,
    elapsedMs: Math.round(performance.now() - started),
  };
}

/** Exact count(*), as text so very large counts never round. */
export async function exactCount(q: Queryable, req: CountRequest): Promise<CountResult> {
  const table = await loadTable(q, req.table);
  const params: unknown[] = [];
  const where = whereClause(table, req.filters, req.where, params);
  const result = await dataQuery(q, `select count(*) from ${table.sql}${where}`, params);
  return { count: result.rows[0]?.[0] ?? '0', exact: true };
}

/**
 * Planner estimate: pg_class.reltuples for an unfiltered, analyzed table; otherwise the row
 * estimate of EXPLAIN (FORMAT JSON) for the filtered query.
 */
export async function estimateCount(q: Queryable, req: CountRequest): Promise<CountResult> {
  const table = await loadTable(q, req.table);
  const filtered = req.filters.length > 0 || Boolean(req.where?.trim());
  if (!filtered && (table.relkind === 'r' || table.relkind === 'm') && table.reltuples >= 0) {
    return { count: String(Math.round(table.reltuples)), exact: false };
  }
  const params: unknown[] = [];
  const where = whereClause(table, req.filters, req.where, params);
  const result = await dataQuery(q, `explain (format json) select 1 from ${table.sql}${where}`, params);
  const plan = JSON.parse(result.rows[0]?.[0] ?? '[]') as Array<{ Plan?: { 'Plan Rows'?: number } }>;
  const rows = plan[0]?.Plan?.['Plan Rows'] ?? 0;
  return { count: String(Math.round(rows)), exact: false };
}
