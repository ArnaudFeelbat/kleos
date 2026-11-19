import { type ApiErrorBody, type ColumnMeta, quoteIdent } from '@kleos/shared';
import { KleosError, isPgError, pgErrorBody } from '../../errors';
import { type CsvRecord, CsvReader } from '../../jobs/csv-reader';
import type { ImportJob, JobContext, JobResult } from '../types';
import type { JobConnection } from './jobs';
import { type TableInfo, columnOf, loadTable } from './table';
import type { Queryable } from './types';

/** Postgres's limit on bind parameters per statement. */
export const MAX_PARAMS = 65_535;
/** Rows per INSERT, below the parameter limit. */
const MAX_BATCH_ROWS = 1000;

type Target = { fileColumn: number; column: ColumnMeta };

type PgError = { code: string; message: string; column?: unknown; detail?: unknown };

/**
 * Inserts a CSV file in one transaction on the job's own client: batched multi-row INSERTs with
 * every value sent as text (Postgres converts it to the column's type exactly as it would a
 * typed literal), unmapped columns left to their DEFAULT, NULL for the chosen null texts.
 * COMMIT happens only after the last row; any error or a cancel rolls everything back.
 *
 * Each batch runs inside a savepoint. When one fails, it is retried row by row to find the file
 * line at fault, and the column comes from the error itself or from casting each value alone.
 */
export async function importFile(connection: JobConnection, req: ImportJob, job: JobContext): Promise<JobResult> {
  const reader = new CsvReader(req.path, req.delimiter);
  let begun = false;
  try {
    await connection.query('begin');
    begun = true;
    const q: Queryable = { query: (config) => connection.query(config) };
    const table = await loadTable(q, req.table);
    if (table.relkind !== 'r' && table.relkind !== 'p') {
      throw KleosError.validation(
        `${table.ref.schema}.${table.ref.name} is not a table; only tables can be imported into`,
      );
    }
    const targets = targetsOf(table, req.mapping);
    const inserter = new BatchInserter(connection, table, targets, new Set(req.nullValues));

    let rows = 0;
    let headerSkipped = !req.hasHeader;
    let batch: CsvRecord[] = [];
    const flush = async () => {
      await inserter.insert(batch);
      rows += batch.length;
      batch = [];
      job.progress({ rows, bytes: reader.bytesRead });
    };
    for await (const record of reader) {
      if (!headerSkipped) {
        headerSkipped = true;
        continue;
      }
      batch.push(record);
      if (batch.length === inserter.batchRows) await flush();
    }
    if (batch.length > 0) await flush();

    connection.checkCancelled();
    await connection.query('commit');
    begun = false;
    job.progress({ rows, bytes: reader.bytesRead });
    return { rows, bytes: reader.bytesRead };
  } catch (err) {
    // Straight on the client: a cancelled job still rolls back before its connection closes.
    if (begun) await connection.client.query('rollback').catch(() => undefined);
    throw err;
  }
}

function targetsOf(table: TableInfo, mapping: ImportJob['mapping']): Target[] {
  const seen = new Set<string>();
  return mapping.map(({ fileColumn, column }) => {
    const meta = columnOf(table, column);
    if (seen.has(meta.name)) throw KleosError.validation(`Column "${meta.name}" is mapped more than once`);
    seen.add(meta.name);
    return { fileColumn, column: meta };
  });
}

class BatchInserter {
  readonly batchRows: number;
  private readonly columnList: string;
  private readonly fullBatchSql: string;

  constructor(
    private readonly connection: JobConnection,
    private readonly table: TableInfo,
    private readonly targets: Target[],
    private readonly nulls: Set<string>,
  ) {
    this.batchRows = Math.max(1, Math.min(MAX_BATCH_ROWS, Math.floor(MAX_PARAMS / targets.length)));
    this.columnList = targets.map((t) => quoteIdent(t.column.name)).join(', ');
    this.fullBatchSql = this.sql(this.batchRows);
  }

  async insert(records: CsvRecord[]): Promise<void> {
    const values = records.flatMap((record) => this.values(record));
    const full = records.length === this.batchRows;
    await this.connection.query('savepoint kleos_import_batch');
    try {
      await this.connection.query({
        // A full batch always has the same text: prepared once, then only bound.
        ...(full ? { name: 'kleos_import_batch' } : {}),
        text: full ? this.fullBatchSql : this.sql(records.length),
        values,
      });
    } catch (err) {
      if (!isPgError(err)) throw err;
      await this.connection.query('rollback to savepoint kleos_import_batch');
      throw await this.locate(records, err);
    }
    await this.connection.query('release savepoint kleos_import_batch');
  }

  /** The values of one record, in mapping order; a short row is an error naming its line. */
  private values(record: CsvRecord): Array<string | null> {
    return this.targets.map((target) => {
      const cell = record.fields[target.fileColumn];
      if (cell === undefined) {
        throw new KleosError(400, {
          code: 'KLEOS_VALIDATION',
          message: `The row has ${record.fields.length} fields; column "${target.column.name}" reads field ${target.fileColumn + 1}`,
          detail: `line ${record.line}`,
          column: target.column.name,
        });
      }
      return this.nulls.has(cell) ? null : cell;
    });
  }

  private sql(rows: number): string {
    const width = this.targets.length;
    const tuples = Array.from(
      { length: rows },
      (_, r) => `(${this.targets.map((_t, c) => `$${r * width + c + 1}`).join(', ')})`,
    );
    return `insert into ${this.table.sql} (${this.columnList}) values ${tuples.join(', ')}`;
  }

  /**
   * Replays a failed batch one row at a time (inside the batch's savepoint, rolled back after)
   * until a row fails, and builds the error for that row's line and column.
   */
  private async locate(records: CsvRecord[], batchError: PgError): Promise<KleosError> {
    const single = this.sql(1);
    for (const record of records) {
      const values = this.values(record);
      await this.connection.query('savepoint kleos_import_row');
      try {
        await this.connection.query({ text: single, values });
        await this.connection.query('release savepoint kleos_import_row');
      } catch (err) {
        if (!isPgError(err)) throw err;
        await this.connection.query('rollback to savepoint kleos_import_row');
        const column = this.columnFromError(err) ?? (await this.columnByCast(values));
        await this.connection.query('rollback to savepoint kleos_import_batch');
        return importError(err, record.line, column);
      }
    }
    // Every row passes alone (unlikely: the batch failed as a whole); blame its first line.
    await this.connection.query('rollback to savepoint kleos_import_batch');
    return importError(batchError, records[0]?.line ?? 0, this.columnFromError(batchError));
  }

  /** The column Postgres names (NOT NULL), or the one key column of a unique violation. */
  private columnFromError(err: PgError): string | undefined {
    const mapped = new Set(this.targets.map((t) => t.column.name));
    if (typeof err.column === 'string' && err.column) return err.column;
    const key = typeof err.detail === 'string' ? /^Key \(([^)]+)\)=/.exec(err.detail)?.[1] : undefined;
    if (key && mapped.has(key)) return key;
    return undefined;
  }

  /**
   * Casts each value alone to its column's type, in a savepoint, and returns the first column
   * whose value Postgres refuses. A length overflow (varchar(n)) is not found this way, since an
   * explicit cast truncates; those errors come without a column.
   */
  private async columnByCast(values: Array<string | null>): Promise<string | undefined> {
    for (let i = 0; i < this.targets.length; i += 1) {
      const value = values[i];
      if (value === null || value === undefined) continue;
      const column = this.targets[i]!.column;
      await this.connection.query('savepoint kleos_import_cast');
      try {
        await this.connection.query({ text: `select $1::${column.type}`, values: [value] });
        await this.connection.query('release savepoint kleos_import_cast');
      } catch (err) {
        if (!isPgError(err)) throw err;
        await this.connection.query('rollback to savepoint kleos_import_cast');
        return column.name;
      }
    }
    return undefined;
  }
}

/**
 * The job's error: Postgres's code and message (with its detail, e.g. the duplicate key,
 * appended), the file line in `detail` and the column in `column`.
 */
function importError(err: PgError, line: number, column: string | undefined): KleosError {
  const body: ApiErrorBody = pgErrorBody(err);
  const pgDetail = body.detail;
  body.message = pgDetail ? `${body.message}. ${pgDetail}` : body.message;
  body.detail = `line ${line}`;
  if (column) body.column = column;
  return new KleosError(400, body);
}
