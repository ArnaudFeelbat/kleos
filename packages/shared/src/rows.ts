import { z } from 'zod';
import { TableRef } from './schema';

/**
 * Every value crosses the wire as text or null, with the column's type name beside it,
 * so bigint/numeric never round and timestamps never shift in JavaScript.
 */
export const CellValue = z.string().nullable();
export type CellValue = z.infer<typeof CellValue>;

export const ColumnMeta = z.object({
  name: z.string(),
  /** format_type(oid, typmod) when known, else pg_type.typname */
  type: z.string(),
  typeName: z.string(),
  typeOid: z.number(),
  typeCategory: z.string(),
});
export type ColumnMeta = z.infer<typeof ColumnMeta>;

export const filterOperators = ['eq', 'neq', 'contains', 'gt', 'gte', 'lt', 'lte', 'isNull', 'isNotNull'] as const;
export const FilterOperator = z.enum(filterOperators);
export type FilterOperator = z.infer<typeof FilterOperator>;

export const Filter = z.object({
  column: z.string(),
  op: FilterOperator,
  /** Ignored for isNull / isNotNull. Sent as a parameter cast to the column type (contains casts the column to text). */
  value: z.string().optional(),
});
export type Filter = z.infer<typeof Filter>;

export const SortKey = z.object({
  column: z.string(),
  dir: z.enum(['asc', 'desc']),
});
export type SortKey = z.infer<typeof SortKey>;

export const RowsRequest = z.object({
  table: TableRef,
  limit: z.number().int().min(1).max(5000),
  offset: z.number().int().min(0),
  sort: z.array(SortKey),
  /** Combined with AND. */
  filters: z.array(Filter),
  /** Raw SQL condition typed by the user, ANDed with the filters. Empty or absent means none. */
  where: z.string().optional(),
});
export type RowsRequest = z.infer<typeof RowsRequest>;

export const RowsPage = z.object({
  columns: z.array(ColumnMeta),
  rows: z.array(z.array(CellValue)),
  /** True when at least one more row exists after this page. */
  hasMore: z.boolean(),
  elapsedMs: z.number(),
});
export type RowsPage = z.infer<typeof RowsPage>;

export const CountRequest = z.object({
  table: TableRef,
  filters: z.array(Filter),
  where: z.string().optional(),
  /** false returns the planner's estimate (cheap); true runs count(*). */
  exact: z.boolean().default(true),
});
export type CountRequest = z.input<typeof CountRequest>;

export const CountResult = z.object({
  /** Planner estimate when exact is false. Text so very large counts never round. */
  count: z.string(),
  exact: z.boolean(),
});
export type CountResult = z.infer<typeof CountResult>;

export const RowEdit = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('update'),
    table: TableRef,
    /** Primary-key column -> current value. */
    key: z.record(z.string(), CellValue),
    /** Column -> new value (null sets NULL). */
    set: z.record(z.string(), CellValue),
  }),
  z.object({
    kind: z.literal('insert'),
    table: TableRef,
    /** Only the columns given are inserted; omitted columns take their DEFAULT. */
    values: z.record(z.string(), CellValue),
  }),
  z.object({
    kind: z.literal('delete'),
    table: TableRef,
    key: z.record(z.string(), CellValue),
  }),
]);
export type RowEdit = z.infer<typeof RowEdit>;

export const ApplyEditsRequest = z.object({
  edits: z.array(RowEdit).min(1),
});
export type ApplyEditsRequest = z.infer<typeof ApplyEditsRequest>;

export const ApplyEditsResult = z.object({
  applied: z.number(),
  /** One entry per edit, in order: the row returned by RETURNING *, as text, for updates and inserts. */
  rows: z.array(z.array(CellValue).nullable()),
  columns: z.array(ColumnMeta),
});
export type ApplyEditsResult = z.infer<typeof ApplyEditsResult>;
