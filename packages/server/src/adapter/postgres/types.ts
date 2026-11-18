import pg from 'pg';
import type { CellValue, ColumnMeta } from '@kleos/shared';

/**
 * Type parsers that hand back the server's text untouched, so bigint/numeric never round,
 * timestamps never shift, arrays stay Postgres literals and bytea stays '\x..'.
 * Used for every query that returns user data.
 */
export const textTypes: pg.CustomTypesConfig = {
  getTypeParser: (() => (value: string) => value) as unknown as pg.CustomTypesConfig['getTypeParser'],
};

/**
 * The driver's default parsers (int4 -> number, bool -> boolean, text[] -> string[]).
 * Used only for Kleos's own catalog and statistics queries, whose SQL casts timestamps and
 * big counters explicitly.
 */
const metaTypes: pg.CustomTypesConfig = pg.types;

/** Anything that runs a query: the pool, a pooled client or a dedicated client. */
export interface Queryable {
  query(config: pg.QueryConfig): Promise<pg.QueryResult>;
}

/** Runs one of Kleos's own catalog/statistics queries and returns object rows. */
export async function metaQuery<T>(q: Queryable, text: string, values: unknown[] = []): Promise<T[]> {
  const result = await q.query({ text, values, types: metaTypes });
  return result.rows as T[];
}

export type DataResult = { rows: CellValue[][]; fields: pg.FieldDef[]; rowCount: number | null };

/**
 * Runs a statement that returns user data: rows as arrays of text, always over the extended
 * protocol, which accepts exactly one statement.
 */
export async function dataQuery(q: Queryable, text: string, values: unknown[] = []): Promise<DataResult> {
  const config = { text, values, types: textTypes, rowMode: 'array', queryMode: 'extended' };
  const result = await q.query(config as pg.QueryConfig);
  return { rows: result.rows as unknown as CellValue[][], fields: result.fields, rowCount: result.rowCount };
}

/** The backend pid node-postgres keeps from BackendKeyData; null before the client connected. */
export function processId(client: pg.ClientBase): number | null {
  const pid = (client as unknown as { processID?: number | null }).processID;
  return typeof pid === 'number' ? pid : null;
}

/** The backend pid of a connected client. */
export function backendPid(client: pg.ClientBase): number {
  const pid = processId(client);
  if (pid === null) throw new Error('The database client has no backend pid');
  return pid;
}

/** The error Postgres raises for a cancelled statement, for a cancel that lands before the statement starts. */
export function queryCanceledError(): Error {
  return Object.assign(new Error('canceling statement due to user request'), { code: '57014', severity: 'ERROR' });
}

type TypeInfo = Omit<ColumnMeta, 'name'>;

/**
 * Turns result fields (oid + typmod) into ColumnMeta with format_type, typname and
 * typcategory. Lookups are cached for the session; unknown keys are resolved in one query.
 */
export class TypeCache {
  private readonly cache = new Map<string, TypeInfo>();

  constructor(private readonly q: Queryable) {}

  async columnsFor(fields: pg.FieldDef[]): Promise<ColumnMeta[]> {
    const missing = new Map<string, { oid: number; mod: number }>();
    for (const field of fields) {
      const key = cacheKey(field.dataTypeID, field.dataTypeModifier);
      if (!this.cache.has(key)) missing.set(key, { oid: field.dataTypeID, mod: field.dataTypeModifier });
    }
    if (missing.size > 0) {
      const keys = [...missing.values()];
      const rows = await metaQuery<{
        oid: number;
        mod: number;
        type: string;
        type_name: string;
        type_category: string;
      }>(
        this.q,
        `select k.oid, k.mod, format_type(k.oid, k.mod) as type, t.typname::text as type_name,
                t.typcategory::text as type_category
           from unnest($1::oid[], $2::int4[]) as k(oid, mod)
           join pg_type t on t.oid = k.oid`,
        [keys.map((k) => k.oid), keys.map((k) => k.mod)],
      );
      for (const row of rows) {
        this.cache.set(cacheKey(row.oid, row.mod), {
          type: row.type,
          typeName: row.type_name,
          typeOid: row.oid,
          typeCategory: row.type_category,
        });
      }
    }
    return fields.map((field) => {
      const info = this.cache.get(cacheKey(field.dataTypeID, field.dataTypeModifier));
      return {
        name: field.name,
        ...(info ?? { type: 'unknown', typeName: 'unknown', typeOid: field.dataTypeID, typeCategory: 'X' }),
      };
    });
  }
}

function cacheKey(oid: number, mod: number): string {
  return `${oid}:${mod}`;
}
