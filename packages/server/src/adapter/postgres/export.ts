import type pg from 'pg';
import Cursor from 'pg-cursor';
import type { CellValue } from '@kleos/shared';
import { KleosError } from '../../errors';
import { PartialFile } from '../../jobs/files';
import {
  CsvWriter,
  type ExportColumn,
  JsonWriter,
  type RowWriter,
  type ValueKind,
  XlsxWriter,
} from '../../jobs/writers';
import type { ExportJob, JobContext, JobResult } from '../types';
import type { JobConnection } from './jobs';
import { orderBy, whereClause } from './rows';
import { loadTable } from './table';
import { type Queryable, textTypes } from './types';

/** Rows fetched from the cursor per round trip; one batch is all an export ever holds. */
export const EXPORT_BATCH_ROWS = 2000;

/** Built-in type oids written as JSON numbers or Excel numbers (they fit a double exactly). */
const NUMBER_OIDS = new Set([21 /* int2 */, 23 /* int4 */, 26 /* oid */, 700 /* float4 */, 701 /* float8 */]);
const BOOL_OID = 16;
const JSON_OIDS = new Set([114 /* json */, 3802 /* jsonb */]);

function kindOf(field: pg.FieldDef): ValueKind {
  if (NUMBER_OIDS.has(field.dataTypeID)) return 'number';
  if (field.dataTypeID === BOOL_OID) return 'boolean';
  if (JSON_OIDS.has(field.dataTypeID)) return 'json';
  return 'text';
}

/**
 * Streams a table or one statement into a file through a server-side cursor. Always inside
 * BEGIN READ ONLY: an export only reads, so a statement with side effects (or a raw WHERE calling
 * a writing function) fails with Postgres's own read-only error. Only one batch is in memory at
 * a time, and the next one is fetched once the file has taken the previous one.
 */
export async function exportFile(connection: JobConnection, req: ExportJob, job: JobContext): Promise<JobResult> {
  const file = new PartialFile(req.path);
  try {
    await file.open();
    await connection.query('begin transaction read only');
    const q: Queryable = { query: (config) => connection.query(config) };

    let sql: string;
    const params: unknown[] = [];
    let sheet = 'Query';
    if (req.source.kind === 'table') {
      const table = await loadTable(q, req.source.table);
      const where = whereClause(table, req.source.filters, req.source.where, params);
      sql = `select * from ${table.sql}${where}${orderBy(table, req.source.sort)}`;
      sheet = table.ref.name;
    } else {
      sql = req.source.sql;
    }

    const cursor = connection.client.query(
      new Cursor<CellValue[]>(sql, params, { rowMode: 'array', types: textTypes }),
    );
    let batch = await connection.read(cursor, EXPORT_BATCH_ROWS);
    if (batch.fields.length === 0) {
      throw KleosError.validation('This statement returns no rows to export');
    }
    const columns: ExportColumn[] = batch.fields.map((f) => ({ name: f.name, kind: kindOf(f) }));
    const writer = writerFor(req, file, sheet);
    await writer.begin(columns);

    let rows = 0;
    for (;;) {
      if (batch.rows.length > 0) {
        await writer.write(batch.rows);
        rows += batch.rows.length;
        job.progress({ rows, bytes: file.bytes });
      }
      if (batch.rows.length < EXPORT_BATCH_ROWS) break;
      batch = await connection.read(cursor, EXPORT_BATCH_ROWS);
    }
    connection.checkCancelled();
    await writer.end();
    await file.finish();
    await connection.query('rollback').catch(() => undefined);
    job.progress({ rows, bytes: file.bytes });
    return { rows, bytes: file.bytes };
  } catch (err) {
    // The connection is closed right after, which ends the transaction too.
    await file.discard();
    throw err;
  }
}

function writerFor(req: ExportJob, file: PartialFile, sheet: string): RowWriter {
  switch (req.format) {
    case 'csv':
      return new CsvWriter(file, { delimiter: req.csv?.delimiter ?? ',', header: req.csv?.header ?? true });
    case 'json':
      return new JsonWriter(file);
    case 'xlsx':
      return new XlsxWriter(file, sheet);
  }
}
