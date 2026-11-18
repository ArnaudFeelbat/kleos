import { z } from 'zod';

export const TableRef = z.object({
  schema: z.string(),
  name: z.string(),
});
export type TableRef = z.infer<typeof TableRef>;

/** Stable key for a table or view, used in maps, layouts and URLs. */
export function tableKey(ref: TableRef): string {
  return `${ref.schema}.${ref.name}`;
}

export const Column = z.object({
  name: z.string(),
  /** format_type(atttypid, atttypmod), e.g. "numeric(12,2)", "timestamp with time zone", "order_status" */
  type: z.string(),
  /** pg_type.typname of the base type, e.g. "numeric", "timestamptz", "_text" for text[] */
  typeName: z.string(),
  typeOid: z.number(),
  /** pg_type.typcategory: A array, B bool, D datetime, E enum, N numeric, S string, U user, ... */
  typeCategory: z.string(),
  nullable: z.boolean(),
  /** Default expression text, or null. Identity and generated columns report null here. */
  default: z.string().nullable(),
  identity: z.enum(['always', 'by default']).nullable(),
  generated: z.boolean(),
  /** Labels in sort order when the column is an enum. */
  enumValues: z.array(z.string()).optional(),
});
export type Column = z.infer<typeof Column>;

export const Index = z.object({
  name: z.string(),
  /** pg_get_indexdef output */
  definition: z.string(),
  columns: z.array(z.string()),
  unique: z.boolean(),
  primary: z.boolean(),
  method: z.string(),
});
export type Index = z.infer<typeof Index>;

export const Constraint = z.object({
  name: z.string(),
  /** p primary key, f foreign key, u unique, c check, x exclusion */
  type: z.enum(['p', 'f', 'u', 'c', 'x', 't', 'n']),
  /** pg_get_constraintdef output */
  definition: z.string(),
});
export type Constraint = z.infer<typeof Constraint>;

export const Table = TableRef.extend({
  kind: z.enum(['table', 'partitioned', 'view', 'materialized']),
  columns: z.array(Column),
  /** Column names of the primary key, empty when there is none. */
  primaryKey: z.array(z.string()),
  indexes: z.array(Index),
  constraints: z.array(Constraint),
  /** pg_class.reltuples, -1 when never analyzed */
  rowEstimate: z.number(),
  totalBytes: z.number(),
  comment: z.string().nullable(),
});
export type Table = z.infer<typeof Table>;

export const ForeignKey = z.object({
  name: z.string(),
  schema: z.string(),
  table: z.string(),
  columns: z.array(z.string()),
  refSchema: z.string(),
  refTable: z.string(),
  refColumns: z.array(z.string()),
});
export type ForeignKey = z.infer<typeof ForeignKey>;

export const EnumType = z.object({
  schema: z.string(),
  name: z.string(),
  values: z.array(z.string()),
});
export type EnumType = z.infer<typeof EnumType>;

export const SchemaModel = z.object({
  /** User schemas; pg_catalog, information_schema, pg_toast and pg_temp_* are left out. */
  schemas: z.array(z.string()),
  /** Ordinary and partitioned tables. */
  tables: z.array(Table),
  /** Views and materialized views, with columns; indexes/constraints may be empty. */
  views: z.array(Table),
  foreignKeys: z.array(ForeignKey),
  enums: z.array(EnumType),
  introspectedAt: z.string(),
});
export type SchemaModel = z.infer<typeof SchemaModel>;
