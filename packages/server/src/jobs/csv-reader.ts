import { createReadStream } from 'node:fs';
import { open, stat } from 'node:fs/promises';
import { Transform, type TransformCallback } from 'node:stream';
import { CsvError, type Info, parse } from 'csv-parse';
import { type ImportPreview, kleosErrorCodes } from '@kleos/shared';
import { KleosError } from '../errors';
import { fileError } from './files';

export type Delimiter = ',' | ';' | '\t';

const DELIMITERS: Delimiter[] = [',', ';', '\t'];
/** Bytes read to guess the delimiter. */
const SAMPLE_BYTES = 64 * 1024;
const PREVIEW_ROWS = 50;

/** One CSV record and the physical file line it starts on (1-based, the header counts). */
export type CsvRecord = { fields: string[]; line: number };

const NOT_UTF8 = 'The file is not UTF-8 text. Save it as “CSV UTF-8” and try again.';

/**
 * Passes the file through unchanged while checking it decodes as UTF-8 and counting bytes.
 * Decoding is streamed, so a character split across two chunks is fine.
 */
class Utf8Check extends Transform {
  private readonly decoder = new TextDecoder('utf-8', { fatal: true });
  bytes = 0;

  override _transform(chunk: Buffer, _encoding: BufferEncoding, callback: TransformCallback): void {
    try {
      this.decoder.decode(chunk, { stream: true });
    } catch {
      callback(fileError(null, NOT_UTF8));
      return;
    }
    this.bytes += chunk.length;
    callback(null, chunk);
  }

  override _flush(callback: TransformCallback): void {
    try {
      this.decoder.decode();
    } catch {
      callback(fileError(null, NOT_UTF8));
      return;
    }
    callback();
  }
}

/**
 * Streams the records of a CSV file: UTF-8 checked, BOM stripped, empty lines skipped, rows of
 * any length (the caller decides what a short row means). `bytesRead` follows the file as it is
 * consumed, for progress. A malformed file (unclosed quote) or an unreadable one fails with
 * KLEOS_FILE; the line is in `detail`.
 */
export class CsvReader implements AsyncIterable<CsvRecord> {
  private readonly check = new Utf8Check();

  constructor(
    private readonly path: string,
    private readonly delimiter: Delimiter,
  ) {}

  get bytesRead(): number {
    return this.check.bytes;
  }

  async *[Symbol.asyncIterator](): AsyncGenerator<CsvRecord> {
    const source = createReadStream(this.path);
    const parser = parse({
      delimiter: this.delimiter,
      bom: true,
      info: true,
      relax_column_count: true,
      skip_empty_lines: true,
    });
    source.on('error', (err) => parser.destroy(fileError(err)));
    this.check.on('error', (err) => parser.destroy(err));
    source.pipe(this.check).pipe(parser);
    try {
      for await (const item of parser as AsyncIterable<{ record: string[]; info: Info }>) {
        yield { fields: item.record, line: startLine(item.record, item.info.lines) };
      }
    } catch (err) {
      throw csvError(err);
    } finally {
      source.destroy();
      parser.destroy();
    }
  }
}

/**
 * csv-parse counts the line a record ends on; a quoted value with line breaks started that many
 * lines earlier.
 */
function startLine(fields: string[], endLine: number): number {
  let breaks = 0;
  for (const field of fields) {
    if (field.includes('\n') || field.includes('\r')) breaks += field.match(/\r\n|\r|\n/g)?.length ?? 0;
  }
  return endLine - breaks;
}

function csvError(err: unknown): unknown {
  if (err instanceof KleosError) return err;
  if (err instanceof CsvError) {
    return new KleosError(400, {
      code: kleosErrorCodes.file,
      message: `The file is not valid CSV: ${err.message}`,
      ...(typeof err.lines === 'number' ? { detail: `line ${err.lines}` } : {}),
    });
  }
  return fileError(err);
}

/**
 * Picks the delimiter whose field count is the same on every line of the first ~64 KB (and
 * above one); the widest wins, ties go to comma, then semicolon, then tab. Quotes are honoured,
 * so a semicolon inside a quoted value does not count.
 */
export async function detectDelimiter(path: string): Promise<Delimiter> {
  const sample = await readSample(path);
  let best: { delimiter: Delimiter; width: number } | null = null;
  for (const delimiter of DELIMITERS) {
    const records = await parseSample(sample.text, delimiter, sample.truncated);
    if (records.length === 0) continue;
    const width = records[0]!.length;
    if (width < 2 || records.some((r) => r.length !== width)) continue;
    if (!best || width > best.width) best = { delimiter, width };
  }
  return best?.delimiter ?? ',';
}

async function readSample(path: string): Promise<{ text: string; truncated: boolean }> {
  let handle;
  try {
    handle = await open(path, 'r');
    const buffer = Buffer.alloc(SAMPLE_BYTES);
    const { bytesRead } = await handle.read(buffer, 0, SAMPLE_BYTES, 0);
    const size = (await handle.stat()).size;
    // Not fatal: the sample may end in the middle of a character. The full read checks UTF-8.
    let text = new TextDecoder('utf-8').decode(buffer.subarray(0, bytesRead));
    if (text.startsWith('\uFEFF')) text = text.slice(1);
    return { text, truncated: size > bytesRead };
  } catch (err) {
    throw fileError(err);
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

/** The records of a sample; a cut-off last record (or a parse error) ends the list early. */
function parseSample(text: string, delimiter: Delimiter, truncated: boolean): Promise<string[][]> {
  return new Promise((resolve) => {
    const records: string[][] = [];
    const parser = parse({ delimiter, relax_column_count: true, skip_empty_lines: true });
    parser.on('readable', () => {
      let record: string[] | null;
      while ((record = parser.read() as string[] | null) !== null) records.push(record);
    });
    // The sample may stop inside a record, so its last record is not trusted.
    const done = () => resolve(truncated ? records.slice(0, -1) : records);
    parser.on('end', done);
    parser.on('error', () => resolve(records.slice(0, -1)));
    parser.end(text);
  });
}

/** POST /imports/preview: delimiter, column names, the first 50 rows and the row count. */
export async function previewCsv(req: {
  path: string;
  delimiter?: Delimiter;
  hasHeader: boolean;
}): Promise<ImportPreview> {
  const { hasHeader } = req;
  let bytes: number;
  try {
    bytes = (await stat(req.path)).size;
  } catch (err) {
    throw fileError(err);
  }
  const delimiter = req.delimiter ?? (await detectDelimiter(req.path));
  let header: string[] | null = null;
  const rows: string[][] = [];
  let totalRows = 0;
  let width = 0;
  for await (const record of new CsvReader(req.path, delimiter)) {
    if (hasHeader && header === null) {
      header = record.fields;
      continue;
    }
    totalRows += 1;
    width = Math.max(width, record.fields.length);
    if (rows.length < PREVIEW_ROWS) rows.push(record.fields);
  }
  const names = header ?? [];
  const columns = Array.from({ length: Math.max(names.length, width) }, (_, i) => {
    const name = names[i]?.trim();
    return name ? name : `column ${i + 1}`;
  });
  return { path: req.path, delimiter, columns, rows, totalRows, bytes };
}
