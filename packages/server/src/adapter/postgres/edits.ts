import type pg from 'pg';
import {
  type ApplyEditsResult,
  type CellValue,
  type RowEdit,
  kleosErrorCodes,
  quoteIdent,
  tableKey,
} from '@kleos/shared';
import { KleosError, isPgError, pgErrorBody } from '../../errors';
import { type TableInfo, loadTable } from './table';
import { dataQuery, metaQuery } from './types';

type Statement = { sql: string; params: unknown[]; column?: string; returning: boolean };

/** A Postgres error raised by one statement of the batch, with where it happened. */
class EditFailure extends Error {
  constructor(
    readonly pgError: unknown,
    readonly editIndex: number,
    readonly column: string | undefined,
  ) {
    super('edit failed');
  }
}

function invalid(message: string, editIndex: number, column?: string): KleosError {
  return new KleosError(400, {
    code: kleosErrorCodes.validation,
    message,
    editIndex,
    ...(column ? { column } : {}),
  });
}

/**
 * Applies the edits in one transaction on a pooled client. Refuses read-only sessions and tables
 * without a primary key before touching anything. Each changed cell is its own UPDATE, so a
 * failure names the cell; any statement that affects a number of rows other than one, or any
 * error, rolls the whole batch back.
 */
export async function applyEdits(pool: pg.Pool, edits: RowEdit[], readOnly: boolean): Promise<ApplyEditsResult> {
  if (readOnly) {
    throw new KleosError(403, { code: kleosErrorCodes.readOnly, message: 'This connection is read-only' });
  }
  if (edits.length === 0) return { applied: 0, rows: [], columns: [] };

  const client = await pool.connect();
  let broken: Error | undefined;
  try {
    const tables = new Map<string, TableInfo>();
    const plans: Statement[][] = [];
    for (const [index, edit] of edits.entries()) {
      const key = tableKey(edit.table);
      let table = tables.get(key);
      if (!table) {
        table = await loadTable(client, edit.table);
        tables.set(key, table);
      }
      plans.push(planEdit(edit, index, table));
    }

    await client.query('begin');
    try {
      const rows: (CellValue[] | null)[] = [];
      for (const [index, statements] of plans.entries()) {
        let returned: CellValue[] | null = null;
        for (const statement of statements) {
          const row = await run(client, statement, index, edits[index]!);
          if (statement.returning) returned = row;
        }
        rows.push(returned);
      }
      await client.query('commit');
      const first = tables.get(tableKey(edits[0]!.table))!;
      return { applied: edits.length, rows, columns: first.columns };
    } catch (err) {
      try {
        await client.query('rollback');
      } catch (rollbackError) {
        broken = rollbackError as Error;
      }
      if (err instanceof EditFailure) {
        const edit = edits[err.editIndex]!;
        const column =
          err.column ??
          (broken ? undefined : await findBadValue(client, edit, tables.get(tableKey(edit.table))!, err.pgError));
        const body = isPgError(err.pgError)
          ? pgErrorBody(err.pgError)
          : { code: kleosErrorCodes.internal, message: String(err.pgError) };
        throw new KleosError(400, { ...body, editIndex: err.editIndex, ...(column ? { column } : {}) });
      }
      throw err;
    }
  } finally {
    client.release(broken);
  }
}

function keyCondition(table: TableInfo, key: Record<string, CellValue>, params: unknown[], editIndex: number): string {
  const names = Object.keys(key);
  const missing = table.primaryKey.filter((pk) => !(pk in key));
  const extra = names.filter((name) => !table.primaryKey.includes(name));
  if (missing.length > 0 || extra.length > 0) {
    throw invalid(
      `The key of ${table.ref.schema}.${table.ref.name} must name exactly its primary-key columns (${table.primaryKey.join(', ')})`,
      editIndex,
    );
  }
  return table.primaryKey
    .map((pk) => {
      params.push(key[pk]);
      return `${quoteIdent(pk)} = $${params.length}::${table.byName.get(pk)!.type}`;
    })
    .join(' and ');
}

function castOf(table: TableInfo, column: string, editIndex: number): string {
  const meta = table.byName.get(column);
  if (!meta)
    throw invalid(`Column "${column}" does not exist in ${table.ref.schema}.${table.ref.name}`, editIndex, column);
  return meta.type;
}

/** Turns one edit into its statements, validating keys and columns against the catalog. */
function planEdit(edit: RowEdit, index: number, table: TableInfo): Statement[] {
  const editable = table.relkind === 'r' || table.relkind === 'p';
  if (!editable || table.primaryKey.length === 0) {
    throw new KleosError(400, {
      code: kleosErrorCodes.noPrimaryKey,
      message: `${table.ref.schema}.${table.ref.name} has no primary key, so it is read-only`,
      editIndex: index,
    });
  }

  if (edit.kind === 'insert') {
    const columns = Object.keys(edit.values);
    const params: unknown[] = [];
    const casts = columns.map((column) => {
      const type = castOf(table, column, index);
      params.push(edit.values[column]);
      return `$${params.length}::${type}`;
    });
    const sql =
      columns.length === 0
        ? `insert into ${table.sql} default values returning *`
        : `insert into ${table.sql} (${columns.map(quoteIdent).join(', ')}) values (${casts.join(', ')}) returning *`;
    return [{ sql, params, returning: true }];
  }

  if (edit.kind === 'delete') {
    const params: unknown[] = [];
    const where = keyCondition(table, edit.key, params, index);
    return [{ sql: `delete from ${table.sql} where ${where}`, params, returning: false }];
  }

  const columns = Object.keys(edit.set);
  if (columns.length === 0) throw invalid('An update must change at least one column', index);
  for (const column of columns) castOf(table, column, index);
  // Key columns go last and the key follows each change, so later statements still find the row.
  const ordered = [
    ...columns.filter((c) => !table.primaryKey.includes(c)),
    ...columns.filter((c) => table.primaryKey.includes(c)),
  ];
  const key = { ...edit.key };
  keyCondition(table, key, [], index);
  return ordered.map((column, i) => {
    const params: unknown[] = [edit.set[column]];
    const where = keyCondition(table, key, params, index);
    const last = i === ordered.length - 1;
    if (table.primaryKey.includes(column)) key[column] = edit.set[column] ?? null;
    return {
      sql: `update ${table.sql} set ${quoteIdent(column)} = $1::${table.byName.get(column)!.type} where ${where}${last ? ' returning *' : ''}`,
      params,
      column,
      returning: last,
    };
  });
}

async function run(
  client: pg.PoolClient,
  statement: Statement,
  editIndex: number,
  edit: RowEdit,
): Promise<CellValue[] | null> {
  let result;
  try {
    result = await dataQuery(client, statement.sql, statement.params);
  } catch (err) {
    if (!isPgError(err)) throw err;
    const pgColumn = (err as { column?: unknown }).column;
    throw new EditFailure(err, editIndex, statement.column ?? (typeof pgColumn === 'string' ? pgColumn : undefined));
  }
  if (result.rowCount !== 1) {
    const where = `${edit.table.schema}.${edit.table.name}`;
    throw new KleosError(409, {
      code: kleosErrorCodes.rowCountMismatch,
      message: `Edit ${editIndex + 1} (${edit.kind} on ${where}) affected ${result.rowCount ?? 0} rows instead of 1; nothing was applied`,
      editIndex,
      ...(statement.column ? { column: statement.column } : {}),
    });
  }
  return result.rows[0] ?? null;
}

/**
 * After a data error in an insert, finds the value that does not cast to its column's type,
 * so the error can name the cell. Runs after the rollback, one cheap cast per value.
 */
async function findBadValue(
  client: pg.PoolClient,
  edit: RowEdit,
  table: TableInfo,
  cause: unknown,
): Promise<string | undefined> {
  if (edit.kind !== 'insert' || !isPgError(cause) || !cause.code.startsWith('22')) return undefined;
  for (const [column, value] of Object.entries(edit.values)) {
    if (value === null) continue;
    try {
      await metaQuery(client, `select $1::${table.byName.get(column)!.type}::text`, [value]);
    } catch (err) {
      if (isPgError(err)) return column;
      throw err;
    }
  }
  return undefined;
}
