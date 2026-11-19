import { once } from 'node:events';
import { Writable } from 'node:stream';
import { setImmediate as yieldToLoop } from 'node:timers/promises';
import ExcelJS from 'exceljs';
import type { CellValue } from '@kleos/shared';
import { KleosError } from '../errors';
import { type PartialFile, fileError } from './files';

/**
 * How a column is written. The engine adapter decides it from the column's type:
 * - number: int2, int4, float4, float8, oid (exact in a double; NaN and ±Infinity stay text)
 * - boolean: bool ('t' / 'f')
 * - json: json and jsonb, whose text is valid JSON
 * - text: everything else, int8 and numeric included, so no digit is ever lost
 * Dates and timestamps are text too, in the ISO form Postgres sends with DateStyle=ISO.
 */
export type ValueKind = 'number' | 'boolean' | 'json' | 'text';

export type ExportColumn = { name: string; kind: ValueKind };

/** One output format. Rows arrive as Postgres text (or null), a batch at a time. */
export interface RowWriter {
  begin(columns: ExportColumn[]): Promise<void>;
  /** Resolves once the batch is handed to the file, waiting for the disk when it falls behind. */
  write(rows: CellValue[][]): Promise<void>;
  end(): Promise<void>;
}

/** Excel's sheet limit is 1,048,576 rows, one of which is the header. */
export const XLSX_MAX_DATA_ROWS = 1_048_575;

const UTF8_BOM = '\uFEFF';

/** Postgres float text that JSON has no number for. */
const NON_FINITE = new Set(['NaN', 'Infinity', '-Infinity']);

/**
 * RFC 4180 CSV, with two deliberate choices:
 * - lines end with LF, not CRLF: what Postgres COPY, Numbers and Unix tools write; Excel and
 *   every CSV reader accept it. Quoted values keep their own line breaks as they are.
 * - a UTF-8 BOM first, without which Excel for Mac decodes the file as Mac Roman and mangles
 *   accents.
 * NULL is an empty field and the empty string is `""`, so the two stay apart (as with COPY).
 */
export class CsvWriter implements RowWriter {
  private readonly needsQuotes: RegExp;

  constructor(
    private readonly file: PartialFile,
    private readonly options: { delimiter: string; header: boolean },
  ) {
    const escaped = options.delimiter === '\t' ? '\\t' : options.delimiter;
    this.needsQuotes = new RegExp(`["\\r\\n${escaped}]`);
  }

  async begin(columns: ExportColumn[]): Promise<void> {
    let head = UTF8_BOM;
    if (this.options.header) head += this.line(columns.map((c) => c.name));
    await this.file.write(head);
  }

  async write(rows: CellValue[][]): Promise<void> {
    let chunk = '';
    for (const row of rows) chunk += this.line(row);
    await this.file.write(chunk);
  }

  async end(): Promise<void> {}

  private line(values: CellValue[]): string {
    return `${values.map((v) => this.field(v)).join(this.options.delimiter)}\n`;
  }

  private field(value: CellValue): string {
    if (value === null) return '';
    if (value === '' || this.needsQuotes.test(value)) return `"${value.replace(/"/g, '""')}"`;
    return value;
  }
}

/**
 * One JSON array of objects, written row by row so it never sits in memory. json/jsonb text is
 * spliced in as it comes from Postgres (already valid JSON), so big numbers inside keep every digit.
 * A name repeated in a query's columns gets a suffix ("id", "id_2") so no value is lost.
 */
export class JsonWriter implements RowWriter {
  private keys: string[] = [];
  private kinds: ValueKind[] = [];
  private first = true;

  constructor(private readonly file: PartialFile) {}

  async begin(columns: ExportColumn[]): Promise<void> {
    this.keys = uniqueNames(columns.map((c) => c.name)).map((name) => JSON.stringify(name));
    this.kinds = columns.map((c) => c.kind);
    await this.file.write('[');
  }

  async write(rows: CellValue[][]): Promise<void> {
    let chunk = '';
    for (const row of rows) {
      chunk += this.first ? '\n  {' : ',\n  {';
      this.first = false;
      for (let i = 0; i < this.keys.length; i += 1) {
        if (i > 0) chunk += ', ';
        chunk += `${this.keys[i]}: ${jsonValue(row[i] ?? null, this.kinds[i]!)}`;
      }
      chunk += '}';
    }
    await this.file.write(chunk);
  }

  async end(): Promise<void> {
    await this.file.write(this.first ? ']\n' : '\n]\n');
  }
}

function jsonValue(value: CellValue, kind: ValueKind): string {
  if (value === null) return 'null';
  switch (kind) {
    case 'number':
      return NON_FINITE.has(value) ? JSON.stringify(value) : value;
    case 'boolean':
      return value === 't' ? 'true' : 'false';
    case 'json':
      return value;
    case 'text':
      return JSON.stringify(value);
  }
}

/** "id", "id" -> "id", "id_2". */
export function uniqueNames(names: string[]): string[] {
  const seen = new Set<string>();
  return names.map((name) => {
    let candidate = name;
    for (let n = 2; seen.has(candidate); n += 1) candidate = `${name}_${n}`;
    seen.add(candidate);
    return candidate;
  });
}

/** XML allowed to wait for the compressor, so the next batch is fetched while it works. */
const XLSX_ZIP_BACKLOG_BYTES = 4 * 1024 * 1024;

/** Excel refuses a cell longer than this. */
const XLSX_MAX_CELL_CHARS = 32_767;
/** Characters XML 1.0 cannot carry at all; Excel reports a damaged file if one slips in. */
// eslint-disable-next-line no-control-regex
const XML_INVALID = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\uFFFE\uFFFF]/g;

/**
 * An .xlsx through exceljs's streaming writer: one sheet, a bold header row frozen in place,
 * numbers and booleans typed, everything else (dates and timestamps included) as text. Rows are
 * committed as they come, without shared strings, so memory stays flat. More than 1,048,575
 * rows fails the export, since Excel cannot open the file.
 */
export class XlsxWriter implements RowWriter {
  private readonly workbook: ExcelJS.stream.xlsx.WorkbookWriter;
  private readonly sink: Writable;
  private sinkError: Error | null = null;
  private sheet: ExcelJS.Worksheet | null = null;
  private kinds: ValueKind[] = [];
  private rows = 0;

  constructor(
    file: PartialFile,
    private readonly sheetName: string,
  ) {
    // exceljs pipes its zip into this stream; each chunk waits for the file, so the zip slows down
    // with the disk instead of buffering.
    const sink = new Writable({
      write(chunk: Buffer, _encoding, callback) {
        file.write(chunk).then(() => callback(), callback);
      },
    });
    // A disk error stops the zip; it is rethrown by the next write() instead of crashing the app.
    sink.on('error', (err) => {
      this.sinkError ??= err;
    });
    this.sink = sink;
    this.workbook = new ExcelJS.stream.xlsx.WorkbookWriter({
      stream: sink,
      useStyles: true,
      useSharedStrings: false,
    });
  }

  async begin(columns: ExportColumn[]): Promise<void> {
    this.kinds = columns.map((c) => c.kind);
    const sheet = this.workbook.addWorksheet(sheetName(this.sheetName), {
      views: [{ state: 'frozen', ySplit: 1 }],
    });
    const header = sheet.addRow(columns.map((c) => xlsxText(c.name)));
    header.font = { bold: true };
    header.commit();
    this.sheet = sheet;
  }

  async write(rows: CellValue[][]): Promise<void> {
    const sheet = this.sheet!;
    this.checkSink();
    if (this.rows + rows.length > XLSX_MAX_DATA_ROWS) {
      throw KleosError.validation(
        'Too many rows for Excel',
        `An Excel sheet holds at most ${XLSX_MAX_DATA_ROWS.toLocaleString('en-US')} rows. Export as CSV instead.`,
      );
    }
    for (const row of rows) {
      sheet.addRow(row.map((value, i) => xlsxValue(value, this.kinds[i]!))).commit();
    }
    this.rows += rows.length;
    await this.zipCaughtUp(sheet);
  }

  /**
   * exceljs writes committed rows into the zip entry without waiting, so a fast cursor would pile
   * XML up in memory ahead of the compressor. Waits for the entry's buffer to drain (an internal
   * of exceljs's streaming writer: the sheet's StreamBuf pipes into archiver's PassThrough), and
   * at least yields to the event loop if that internal ever changes.
   */
  private async zipCaughtUp(sheet: ExcelJS.Worksheet): Promise<void> {
    const entry = (sheet as unknown as { _stream?: { pipes?: unknown[] } })._stream?.pipes?.[0];
    if (entry instanceof Writable && entry.writableNeedDrain && entry.writableLength > XLSX_ZIP_BACKLOG_BYTES) {
      // The zip stops reading when the file fails, so the drain would never come: race the error.
      const stop = new AbortController();
      const drained = once(entry, 'drain', { signal: stop.signal }).then(() => undefined);
      const failed = once(this.sink, 'error', { signal: stop.signal }).then(() => undefined);
      drained.catch(() => undefined);
      failed.catch(() => undefined);
      try {
        await Promise.race([drained, failed]);
      } finally {
        stop.abort();
      }
      this.checkSink();
    } else await yieldToLoop();
  }

  private checkSink(): void {
    if (this.sinkError) throw fileError(this.sinkError);
  }

  async end(): Promise<void> {
    this.checkSink();
    this.sheet?.commit();
    await this.workbook.commit();
  }
}

function xlsxValue(value: CellValue, kind: ValueKind): string | number | boolean | null {
  if (value === null) return null;
  switch (kind) {
    case 'number':
      return NON_FINITE.has(value) ? value : Number(value);
    case 'boolean':
      return value === 't';
    default:
      return xlsxText(value);
  }
}

function xlsxText(value: string): string {
  const clean = value.replace(XML_INVALID, '\uFFFD');
  return clean.length > XLSX_MAX_CELL_CHARS ? clean.slice(0, XLSX_MAX_CELL_CHARS) : clean;
}

/** Excel sheet names: at most 31 characters, none of : \ / ? * [ ]. */
export function sheetName(name: string): string {
  const clean = name
    .replace(/[:\\/?*[\]]/g, ' ')
    .trim()
    .slice(0, 31);
  return clean || 'Sheet1';
}
