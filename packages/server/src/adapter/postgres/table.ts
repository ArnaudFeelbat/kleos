import { type ColumnMeta, type TableRef, quoteIdent } from '@kleos/shared';
import { KleosError } from '../../errors';
import { type Queryable, metaQuery } from './types';

/** What the grid, counts and edits need to know about one table or view. */
export type TableInfo = {
  ref: TableRef;
  /** pg_class.relkind: r table, p partitioned, v view, m materialized view, f foreign table */
  relkind: string;
  /** In attnum order, so they line up with `select *` and `returning *`. */
  columns: ColumnMeta[];
  byName: Map<string, ColumnMeta>;
  /** Primary-key columns in key order; empty for views and tables without one. */
  primaryKey: string[];
  /** pg_class.reltuples; -1 when never analyzed. */
  reltuples: number;
  /** "schema"."name", quoted. */
  sql: string;
};

type Row = {
  relkind: string;
  reltuples: number;
  name: string;
  type: string;
  type_name: string;
  type_oid: number;
  type_category: string;
  pk_position: number | null;
};

/** Reads one relation's columns (with format_type for casts) and primary key in one catalog query. */
export async function loadTable(q: Queryable, ref: TableRef): Promise<TableInfo> {
  const rows = await metaQuery<Row>(
    q,
    `select c.relkind::text as relkind, c.reltuples::float8 as reltuples, a.attname::text as name,
            format_type(a.atttypid, a.atttypmod) as type, t.typname::text as type_name, a.atttypid as type_oid,
            t.typcategory::text as type_category, array_position(pk.conkey, a.attnum) as pk_position
       from pg_class c
       join pg_namespace n on n.oid = c.relnamespace
       join pg_attribute a on a.attrelid = c.oid and a.attnum > 0 and not a.attisdropped
       join pg_type t on t.oid = a.atttypid
       left join pg_constraint pk on pk.conrelid = c.oid and pk.contype = 'p'
      where n.nspname = $1 and c.relname = $2 and c.relkind in ('r', 'p', 'v', 'm', 'f')
      order by a.attnum`,
    [ref.schema, ref.name],
  );
  const first = rows[0];
  if (!first) throw KleosError.notFound(`Table ${ref.schema}.${ref.name} does not exist`);
  const columns: ColumnMeta[] = rows.map((r) => ({
    name: r.name,
    type: r.type,
    typeName: r.type_name,
    typeOid: r.type_oid,
    typeCategory: r.type_category,
  }));
  const primaryKey = rows
    .filter((r) => r.pk_position !== null)
    .sort((a, b) => (a.pk_position ?? 0) - (b.pk_position ?? 0))
    .map((r) => r.name);
  return {
    ref,
    relkind: first.relkind,
    columns,
    byName: new Map(columns.map((c) => [c.name, c])),
    primaryKey,
    reltuples: first.reltuples,
    sql: `${quoteIdent(ref.schema)}.${quoteIdent(ref.name)}`,
  };
}

/** The column, or a validation error naming it. */
export function columnOf(table: TableInfo, name: string): ColumnMeta {
  const column = table.byName.get(name);
  if (!column) throw KleosError.validation(`Column "${name}" does not exist in ${table.ref.schema}.${table.ref.name}`);
  return column;
}
