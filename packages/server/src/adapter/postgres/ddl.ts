import type pg from 'pg';
import { type ApiErrorBody, type DdlPreview, type DdlResult, kleosErrorCodes, quoteIdent } from '@kleos/shared';
import { KleosError, connectionErrorBody, isPgError, pgErrorBody } from '../../errors';
import type { DdlJob, TableRef } from '../types';
import { type ParsedType, expressionProblem, parseColumnType } from './ddl-grammar';
import { type Queryable, dataQuery, metaQuery } from './types';

/**
 * Schema editing (0.6): each DdlChange becomes exactly one statement. The same planner serves
 * the preview and the run, so the SQL the user reads is the SQL that runs. Identifiers are
 * always quoted; column types are written in Postgres's own spelling (format_type), never as
 * typed; default and USING expressions are the user's SQL, written as given once they are
 * known to stay inside their slot.
 */

/**
 * A run waits at most this long for a table lock (an open transaction in a query tab, a long
 * export) before failing with 55P03, instead of hanging the window and queueing every other
 * query of that table behind it.
 */
export const DDL_LOCK_TIMEOUT = '10s';

const LOCK_NOT_AVAILABLE = '55P03';

/** NAMEDATALEN - 1: Postgres silently truncates longer names, which could merge two of them. */
const MAX_NAME_BYTES = 63;

/** A refusal before anything ran; `statementIndex` is also the index of the change. */
function invalid(index: number, message: string, detail?: string): KleosError {
  return new KleosError(400, {
    code: kleosErrorCodes.validation,
    message: `Change ${index + 1}: ${message}`,
    ...(detail ? { detail } : {}),
    statementIndex: index,
  });
}

const tableSql = (ref: TableRef) => `${quoteIdent(ref.schema)}.${quoteIdent(ref.name)}`;

function checkName(index: number, name: string, what: string): void {
  if (name.length === 0) throw invalid(index, `the ${what} is empty`);
  if (name.includes('\0')) throw invalid(index, `the ${what} contains a NUL character`);
  if (Buffer.byteLength(name, 'utf8') > MAX_NAME_BYTES) {
    throw invalid(index, `the ${what} "${name}" is longer than ${MAX_NAME_BYTES} bytes`);
  }
}

function checkTable(index: number, ref: TableRef): void {
  checkName(index, ref.schema, 'schema name');
  checkName(index, ref.name, 'table name');
}

/** A blank expression means none (no default, no USING). */
function expressionOf(expr: string | null): string | null {
  const trimmed = expr?.trim() ?? '';
  return trimmed === '' ? null : trimmed;
}

function checkExpression(index: number, expr: string | null, what: string): void {
  const text = expressionOf(expr);
  if (text === null) return;
  const problem = expressionProblem(text);
  if (problem) throw invalid(index, `${what} must be a single SQL expression, but it contains ${problem}`);
}

/** A column type found in a change, with what parsing made of it. */
type TypeUse = { index: number; text: string; parsed: ParsedType };

const typeHelp = 'A type is a name or schema.name, with an optional (n) or (p, s) and any number of [].';

function checkType(index: number, text: string, allowSerial: boolean): TypeUse {
  const parsed = parseColumnType(text);
  if (!parsed) throw invalid(index, `"${text}" is not a type name`, typeHelp);
  if (parsed.kind === 'serial' && !allowSerial) {
    throw invalid(
      index,
      `${parsed.name} only exists when a column is created`,
      'Change the type to integer, bigint or smallint, then set the default to nextval() of a sequence.',
    );
  }
  return { index, text, parsed };
}

function checkColumn(index: number, column: { name: string; type: string; default: string | null }): TypeUse {
  checkName(index, column.name, 'column name');
  checkExpression(index, column.default, `the default of "${column.name}"`);
  return checkType(index, column.type, true);
}

/**
 * Checks the whole request before any SQL runs: names, expressions, the type grammar, the
 * shape of each CREATE TABLE and CREATE INDEX. Throws KLEOS_VALIDATION naming the change;
 * returns every column type to resolve, in order.
 */
export function validateDdl(changes: DdlJob[]): TypeUse[] {
  const types: TypeUse[] = [];
  for (const [index, change] of changes.entries()) {
    switch (change.op) {
      case 'createTable': {
        checkTable(index, { schema: change.schema, name: change.name });
        const names = new Set<string>();
        for (const column of change.columns) {
          types.push(checkColumn(index, column));
          if (names.has(column.name)) throw invalid(index, `the column "${column.name}" appears twice`);
          names.add(column.name);
        }
        const key = new Set<string>();
        for (const column of change.primaryKey) {
          if (!names.has(column)) throw invalid(index, `the primary key names "${column}", which is not a column`);
          if (key.has(column)) throw invalid(index, `the primary key names "${column}" twice`);
          key.add(column);
        }
        break;
      }
      case 'renameTable':
        checkTable(index, change.table);
        checkName(index, change.newName, 'new table name');
        break;
      case 'dropTable':
        checkTable(index, change.table);
        break;
      case 'addColumn':
        checkTable(index, change.table);
        types.push(checkColumn(index, change.column));
        break;
      case 'renameColumn':
        checkTable(index, change.table);
        checkName(index, change.column, 'column name');
        checkName(index, change.newName, 'new column name');
        break;
      case 'alterColumnType':
        checkTable(index, change.table);
        checkName(index, change.column, 'column name');
        checkExpression(index, change.using, 'the USING expression');
        types.push(checkType(index, change.type, false));
        break;
      case 'setNotNull':
      case 'dropColumn':
        checkTable(index, change.table);
        checkName(index, change.column, 'column name');
        break;
      case 'setDefault':
        checkTable(index, change.table);
        checkName(index, change.column, 'column name');
        checkExpression(index, change.default, 'the default');
        break;
      case 'createIndex':
        checkTable(index, change.table);
        if (change.name !== null) checkName(index, change.name, 'index name');
        for (const column of change.columns) checkName(index, column, 'index column name');
        if (change.unique && change.method !== 'btree') {
          throw invalid(index, `a ${change.method} index cannot be unique; only btree indexes can`);
        }
        if (change.method === 'hash' && change.columns.length > 1) {
          throw invalid(index, 'a hash index covers a single column');
        }
        break;
      case 'dropIndex':
        checkName(index, change.schema, 'schema name');
        checkName(index, change.name, 'index name');
        break;
    }
  }
  return types;
}

/**
 * Asks Postgres for the canonical spelling of each type: `select null::<probe>` (the probe is
 * grammar-checked, and `where false` keeps a NOT NULL domain from refusing the null) validates
 * it and yields its typmod, then format_type() spells it, so "varchar(80)" comes back as
 * "character varying(80)" and a type outside the search path comes back schema-qualified.
 * Returns typed text -> SQL; an unknown type is KLEOS_VALIDATION naming the first change using it.
 */
export async function resolveTypes(q: Queryable, uses: TypeUse[]): Promise<Map<string, string>> {
  const resolved = new Map<string, string>();
  const probes: string[] = [];
  for (const use of uses) {
    if (use.parsed.kind === 'serial') resolved.set(use.text, use.parsed.name);
    else if (!probes.includes(use.parsed.probe)) probes.push(use.parsed.probe);
  }
  if (probes.length === 0) return resolved;

  const probeSql = (list: string[]) => `select ${list.map((p, i) => `null::${p} as t${i}`).join(', ')} where false`;
  let fields: pg.FieldDef[];
  try {
    ({ fields } = await dataQuery(q, probeSql(probes)));
  } catch (err) {
    if (!isPgError(err)) throw err;
    // One query for all types; when it fails, ask again one by one to name the culprit.
    for (const probe of probes) {
      try {
        await dataQuery(q, probeSql([probe]));
      } catch (single) {
        if (!isPgError(single)) throw single;
        const use = uses.find((u) => u.parsed.kind === 'type' && u.parsed.probe === probe)!;
        throw invalid(use.index, `unknown type "${use.text}"`, single.message);
      }
    }
    throw err;
  }

  // The result describes a domain by its base type, so the oid comes from to_regtype() of the
  // (already validated) probe; the typmod from the result, unless it is a domain, which takes none.
  const rows = await metaQuery<{ type: string }>(
    q,
    `select format_type(r.oid, case when r.oid = k.field then k.mod else -1 end) as type
       from unnest($1::text[], $2::oid[], $3::int4[]) with ordinality as k(probe, field, mod, n)
      cross join lateral (select coalesce(to_regtype(k.probe)::oid, k.field) as oid) as r
      order by k.n`,
    [probes, fields.map((f) => f.dataTypeID), fields.map((f) => f.dataTypeModifier)],
  );
  const byProbe = new Map(probes.map((probe, i) => [probe, rows[i]!.type]));
  for (const use of uses) {
    if (use.parsed.kind === 'type') resolved.set(use.text, byProbe.get(use.parsed.probe)!);
  }
  return resolved;
}

function columnDefinition(
  column: { name: string; type: string; nullable: boolean; default: string | null },
  typeSql: (text: string) => string,
): string {
  let sql = `${quoteIdent(column.name)} ${typeSql(column.type)}`;
  if (!column.nullable) sql += ' not null';
  const def = expressionOf(column.default);
  if (def !== null) sql += ` default ${def}`;
  return sql;
}

/**
 * The statement of each change, in order. `types` maps each typed column type to its SQL
 * (from resolveTypes); the changes must have passed validateDdl.
 */
export function buildStatements(changes: DdlJob[], types: ReadonlyMap<string, string>): string[] {
  const typeSql = (text: string) => {
    const sql = types.get(text);
    if (sql === undefined) throw new Error(`Type "${text}" was not resolved`);
    return sql;
  };
  return changes.map((change) => {
    switch (change.op) {
      case 'createTable': {
        const parts = change.columns.map((column) => columnDefinition(column, typeSql));
        if (change.primaryKey.length > 0) parts.push(`primary key (${change.primaryKey.map(quoteIdent).join(', ')})`);
        return `create table ${tableSql({ schema: change.schema, name: change.name })} (${parts.join(', ')})`;
      }
      case 'renameTable':
        return `alter table ${tableSql(change.table)} rename to ${quoteIdent(change.newName)}`;
      case 'dropTable':
        return `drop table ${tableSql(change.table)}${change.cascade ? ' cascade' : ''}`;
      case 'addColumn':
        return `alter table ${tableSql(change.table)} add column ${columnDefinition(change.column, typeSql)}`;
      case 'renameColumn':
        return `alter table ${tableSql(change.table)} rename column ${quoteIdent(change.column)} to ${quoteIdent(change.newName)}`;
      case 'alterColumnType': {
        const using = expressionOf(change.using);
        return `alter table ${tableSql(change.table)} alter column ${quoteIdent(change.column)} type ${typeSql(change.type)}${using === null ? '' : ` using ${using}`}`;
      }
      case 'setNotNull':
        return `alter table ${tableSql(change.table)} alter column ${quoteIdent(change.column)} ${change.notNull ? 'set' : 'drop'} not null`;
      case 'setDefault': {
        const def = expressionOf(change.default);
        return `alter table ${tableSql(change.table)} alter column ${quoteIdent(change.column)} ${def === null ? 'drop default' : `set default ${def}`}`;
      }
      case 'dropColumn':
        return `alter table ${tableSql(change.table)} drop column ${quoteIdent(change.column)}${change.cascade ? ' cascade' : ''}`;
      case 'createIndex': {
        const name = change.name === null ? '' : ` ${quoteIdent(change.name)}`;
        const columns = change.columns.map(quoteIdent).join(', ');
        return `create ${change.unique ? 'unique ' : ''}index${name} on ${tableSql(change.table)} using ${change.method} (${columns})`;
      }
      case 'dropIndex':
        return `drop index ${quoteIdent(change.schema)}.${quoteIdent(change.name)}${change.cascade ? ' cascade' : ''}`;
    }
  });
}

/** Validates, resolves the types on `q` (read-only catalog questions) and builds the statements. */
export async function planDdl(q: Queryable, changes: DdlJob[]): Promise<string[]> {
  const uses = validateDdl(changes);
  const types = await resolveTypes(q, uses);
  return buildStatements(changes, types);
}

/** The statements a run would execute; nothing that changes the database runs. */
export async function previewDdl(pool: pg.Pool, changes: DdlJob[]): Promise<DdlPreview> {
  return { statements: await planDdl(pool, changes) };
}

/** The error of a failed run: Postgres's own body, or the driver's for a lost connection. */
function runFailure(err: unknown, statementIndex: number | null): unknown {
  const at = statementIndex === null ? {} : { statementIndex };
  if (isPgError(err)) {
    const body: ApiErrorBody = { ...pgErrorBody(err), ...at };
    if (err.code === LOCK_NOT_AVAILABLE && !body.hint) {
      body.hint = `Another session held a lock on the table for more than ${DDL_LOCK_TIMEOUT}, for example an open transaction in a query tab. Nothing was applied.`;
    }
    return new KleosError(400, body);
  }
  if (err instanceof KleosError) return err;
  return new KleosError(502, { ...connectionErrorBody(err), ...at });
}

/**
 * Runs every statement in one transaction on one pooled client: BEGIN, each statement in order
 * (extended protocol, so each is exactly one statement), COMMIT. Any failure rolls everything
 * back and names the statement; the Postgres position is relative to that statement.
 */
export async function applyDdl(pool: pg.Pool, changes: DdlJob[], readOnly: boolean): Promise<DdlResult> {
  if (readOnly) {
    throw new KleosError(403, { code: kleosErrorCodes.readOnly, message: 'This connection is read-only' });
  }
  const started = performance.now();
  const client = await pool.connect();
  let broken: Error | undefined;
  try {
    const statements = await planDdl(client, changes);
    let current: number | null = null;
    try {
      await client.query('begin');
      await client.query(`set local lock_timeout = '${DDL_LOCK_TIMEOUT}'`);
      for (const [index, sql] of statements.entries()) {
        current = index;
        await dataQuery(client, sql);
      }
      current = null;
      await client.query('commit');
    } catch (err) {
      try {
        await client.query('rollback');
      } catch (rollbackError) {
        broken = rollbackError as Error;
      }
      throw runFailure(err, current);
    }
    return { statements, elapsedMs: Math.round(performance.now() - started) };
  } finally {
    // A client whose ROLLBACK failed may still be in the transaction: destroy it.
    client.release(broken);
  }
}
