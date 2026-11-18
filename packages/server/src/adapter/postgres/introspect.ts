import type { Column, Constraint, EnumType, ForeignKey, Index, SchemaModel, Table } from '@kleos/shared';
import { type Queryable, metaQuery } from './types';

/** Hides pg_catalog, information_schema, pg_toast, pg_toast_temp_* and pg_temp_*. */
const userSchema = (alias: string) =>
  `${alias}.nspname not in ('pg_catalog', 'information_schema') and ${alias}.nspname !~ '^pg_(toast|temp_)'`;

const relationKinds = `('r', 'p', 'v', 'm')`;

type RelationRow = {
  oid: number;
  schema: string;
  name: string;
  relkind: string;
  reltuples: number;
  total_bytes: number;
  comment: string | null;
};

type ColumnRow = {
  rel: number;
  name: string;
  type: string;
  type_name: string;
  type_oid: number;
  type_category: string;
  not_null: boolean;
  default_expr: string | null;
  identity: string | null;
  generated: boolean;
};

type ConstraintRow = {
  rel: number;
  name: string;
  type: Constraint['type'];
  definition: string;
  columns: string[];
  ref_schema: string | null;
  ref_table: string | null;
  ref_columns: string[];
};

type IndexRow = {
  rel: number;
  name: string;
  definition: string;
  unique: boolean;
  primary: boolean;
  method: string;
  columns: string[];
};

type EnumRow = { oid: number; schema: string; name: string; values: string[] };

const kinds: Record<string, Table['kind']> = { r: 'table', p: 'partitioned', v: 'view', m: 'materialized' };

/** Reads the user schemas from pg_catalog with a handful of set-based queries (one per object kind). */
export async function introspect(q: Queryable): Promise<SchemaModel> {
  const [schemas, relations, columns, constraints, indexes, enums] = await Promise.all([
    metaQuery<{ name: string }>(
      q,
      `select n.nspname::text as name from pg_namespace n where ${userSchema('n')} order by n.nspname`,
    ),
    metaQuery<RelationRow>(
      q,
      `select c.oid, n.nspname::text as schema, c.relname::text as name, c.relkind::text as relkind,
              c.reltuples::float8 as reltuples, pg_total_relation_size(c.oid)::float8 as total_bytes,
              obj_description(c.oid, 'pg_class') as comment
         from pg_class c
         join pg_namespace n on n.oid = c.relnamespace
        where c.relkind in ${relationKinds} and ${userSchema('n')}
        order by n.nspname, c.relname`,
    ),
    metaQuery<ColumnRow>(
      q,
      `select a.attrelid as rel, a.attname::text as name, format_type(a.atttypid, a.atttypmod) as type,
              t.typname::text as type_name, a.atttypid as type_oid, t.typcategory::text as type_category,
              a.attnotnull as not_null,
              case when a.attidentity = '' and a.attgenerated = '' then pg_get_expr(d.adbin, d.adrelid) end as default_expr,
              case a.attidentity when 'a' then 'always' when 'd' then 'by default' end as identity,
              a.attgenerated <> '' as generated
         from pg_attribute a
         join pg_class c on c.oid = a.attrelid
         join pg_namespace n on n.oid = c.relnamespace
         join pg_type t on t.oid = a.atttypid
         left join pg_attrdef d on d.adrelid = a.attrelid and d.adnum = a.attnum
        where a.attnum > 0 and not a.attisdropped and c.relkind in ${relationKinds} and ${userSchema('n')}
        order by a.attrelid, a.attnum`,
    ),
    metaQuery<ConstraintRow>(
      q,
      `select co.conrelid as rel, co.conname::text as name, co.contype::text as type,
              pg_get_constraintdef(co.oid) as definition,
              array(select a.attname::text
                      from unnest(co.conkey) with ordinality as k(attnum, ord)
                      join pg_attribute a on a.attrelid = co.conrelid and a.attnum = k.attnum
                     order by k.ord) as columns,
              rn.nspname::text as ref_schema, rc.relname::text as ref_table,
              array(select a.attname::text
                      from unnest(co.confkey) with ordinality as k(attnum, ord)
                      join pg_attribute a on a.attrelid = co.confrelid and a.attnum = k.attnum
                     order by k.ord) as ref_columns
         from pg_constraint co
         join pg_class c on c.oid = co.conrelid
         join pg_namespace n on n.oid = c.relnamespace
         left join pg_class rc on rc.oid = co.confrelid
         left join pg_namespace rn on rn.oid = rc.relnamespace
        where c.relkind in ${relationKinds} and ${userSchema('n')}
        order by co.conrelid, co.contype, co.conname`,
    ),
    metaQuery<IndexRow>(
      q,
      `select i.indrelid as rel, ic.relname::text as name, pg_get_indexdef(i.indexrelid) as definition,
              i.indisunique as unique, i.indisprimary as primary, am.amname::text as method,
              array(select coalesce(a.attname::text, pg_get_indexdef(i.indexrelid, k.n, true))
                      from generate_series(1, i.indnkeyatts::int) as k(n)
                      left join pg_attribute a
                        on a.attrelid = i.indrelid and a.attnum = i.indkey[k.n - 1] and a.attnum > 0
                     order by k.n) as columns
         from pg_index i
         join pg_class ic on ic.oid = i.indexrelid
         join pg_am am on am.oid = ic.relam
         join pg_class c on c.oid = i.indrelid
         join pg_namespace n on n.oid = c.relnamespace
        where c.relkind in ${relationKinds} and ${userSchema('n')}
        order by i.indrelid, i.indisprimary desc, ic.relname`,
    ),
    metaQuery<EnumRow>(
      q,
      `select t.oid, n.nspname::text as schema, t.typname::text as name,
              array_agg(e.enumlabel::text order by e.enumsortorder) as values
         from pg_type t
         join pg_namespace n on n.oid = t.typnamespace
         join pg_enum e on e.enumtypid = t.oid
        where ${userSchema('n')}
        group by t.oid, n.nspname, t.typname
        order by n.nspname, t.typname`,
    ),
  ]);

  const enumValues = new Map(enums.map((e) => [e.oid, e.values]));
  const columnsByRel = groupBy(columns, (c) => c.rel);
  const constraintsByRel = groupBy(constraints, (c) => c.rel);
  const indexesByRel = groupBy(indexes, (i) => i.rel);
  const relationsByOid = new Map(relations.map((r) => [r.oid, r]));

  const tables: Table[] = [];
  const views: Table[] = [];
  for (const rel of relations) {
    const relConstraints = constraintsByRel.get(rel.oid) ?? [];
    const table: Table = {
      schema: rel.schema,
      name: rel.name,
      kind: kinds[rel.relkind] ?? 'table',
      columns: (columnsByRel.get(rel.oid) ?? []).map((c): Column => {
        const values = enumValues.get(c.type_oid);
        return {
          name: c.name,
          type: c.type,
          typeName: c.type_name,
          typeOid: c.type_oid,
          typeCategory: c.type_category,
          nullable: !c.not_null,
          default: c.default_expr,
          identity: c.identity === 'always' || c.identity === 'by default' ? c.identity : null,
          generated: c.generated,
          ...(values ? { enumValues: values } : {}),
        };
      }),
      primaryKey: relConstraints.find((c) => c.type === 'p')?.columns ?? [],
      indexes: (indexesByRel.get(rel.oid) ?? []).map((i): Index => ({
        name: i.name,
        definition: i.definition,
        columns: i.columns,
        unique: i.unique,
        primary: i.primary,
        method: i.method,
      })),
      constraints: relConstraints.map((c): Constraint => ({ name: c.name, type: c.type, definition: c.definition })),
      rowEstimate: rel.reltuples,
      totalBytes: rel.total_bytes,
      comment: rel.comment,
    };
    (rel.relkind === 'v' || rel.relkind === 'm' ? views : tables).push(table);
  }

  const foreignKeys: ForeignKey[] = constraints
    .filter((c) => c.type === 'f' && c.ref_schema !== null && c.ref_table !== null)
    .map((c) => {
      const rel = relationsByOid.get(c.rel)!;
      return {
        name: c.name,
        schema: rel.schema,
        table: rel.name,
        columns: c.columns,
        refSchema: c.ref_schema!,
        refTable: c.ref_table!,
        refColumns: c.ref_columns,
      };
    });

  return {
    schemas: schemas.map((s) => s.name),
    tables,
    views,
    foreignKeys,
    enums: enums.map((e): EnumType => ({ schema: e.schema, name: e.name, values: e.values })),
    introspectedAt: new Date().toISOString(),
  };
}

function groupBy<T, K>(items: T[], key: (item: T) => K): Map<K, T[]> {
  const map = new Map<K, T[]>();
  for (const item of items) {
    const k = key(item);
    const list = map.get(k);
    if (list) list.push(item);
    else map.set(k, [item]);
  }
  return map;
}
