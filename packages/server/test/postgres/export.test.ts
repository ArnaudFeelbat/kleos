import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parse } from 'csv-parse/sync';
import ExcelJS from 'exceljs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type CellValue, type ColumnMeta, ExportRequest, type JobStatus } from '@kleos/shared';
import { createPostgresAdapter } from '../../src/adapter/postgres';
import type { ExportJob, JobResult, Session } from '../../src/adapter/types';
import { createApp } from '../../src/http/app';
import { PARTIAL_SUFFIX } from '../../src/jobs/files';
import { SessionRegistry } from '../../src/sessions/registry';
import { createMemorySecretStore } from '../../src/store/keychain';
import { createSqliteStore } from '../../src/store/sqlite';
import { type TestDatabase, rejectionOf, startPostgres, waitUntil } from '../helpers/postgres';

let db: TestDatabase;
let session: Session;
let dir: string;

beforeAll(async () => {
  db = await startPostgres({ seeds: ['types.sql', 'shop.sql'] });
  session = await createPostgresAdapter().connect(db.config, db.password);
  dir = mkdtempSync(join(tmpdir(), 'kleos-export-'));
});

afterAll(async () => {
  await session?.close();
  await db?.stop();
  if (dir) rmSync(dir, { recursive: true, force: true });
});

const typeTables = [
  'ints',
  'numerics',
  'texts',
  'bools',
  'dates',
  'timestamps',
  'timestamptzs',
  'jsons',
  'arrays',
  'uuids',
  'enums',
  'byteas',
];

let counter = 0;

/** Runs an export to a fresh path; `onProgress` may abort it. */
async function exportTo(
  request: Omit<ExportJob, 'jobId' | 'path'> & { path?: string },
  onProgress?: (update: JobResult, abort: () => void) => void,
): Promise<{ path: string; result: Promise<JobResult> }> {
  counter += 1;
  const path = request.path ?? join(dir, `export-${counter}.${request.format}`);
  const req = ExportRequest.parse({ jobId: `job-${counter}`, ...request, path });
  const controller = new AbortController();
  const result = session.exportFile(req, {
    signal: controller.signal,
    progress: (update) => onProgress?.(update, () => controller.abort()),
  });
  return { path, result };
}

function tableSource(name: string, schema = 'types') {
  return { kind: 'table' as const, table: { schema, name }, filters: [], sort: [] };
}

/** What the grid shows for a whole table: the reference every format is checked against. */
async function gridRows(name: string, schema = 'types'): Promise<{ columns: ColumnMeta[]; rows: CellValue[][] }> {
  const page = await session.fetchRows({ table: { schema, name }, limit: 10_000, offset: 0, filters: [], sort: [] });
  return { columns: page.columns, rows: page.rows };
}

const numberTypes = new Set(['int2', 'int4', 'oid', 'float4', 'float8']);
const nonFinite = new Set(['NaN', 'Infinity', '-Infinity']);

/** The typed value the JSON and Excel exports promise for one grid cell. */
function typed(value: CellValue, column: ColumnMeta, json: boolean): unknown {
  if (value === null) return null;
  if (numberTypes.has(column.typeName)) return nonFinite.has(value) ? value : Number(value);
  if (column.typeName === 'bool') return value === 't';
  if (json && (column.typeName === 'json' || column.typeName === 'jsonb')) return JSON.parse(value);
  return value;
}

describe('export formats round-trip the types fixture', () => {
  it('CSV: every value as text, NULL empty, "" quoted, BOM and header', async () => {
    for (const table of typeTables) {
      const { path, result } = await exportTo({ source: tableSource(table), format: 'csv' });
      const { rows } = await result;
      const text = readFileSync(path, 'utf8');
      expect(text.startsWith('\uFEFF')).toBe(true);
      const grid = await gridRows(table);
      expect(rows).toBe(grid.rows.length);
      const records = parse(text, { bom: true }) as string[][];
      expect(records[0]).toEqual(grid.columns.map((c) => c.name));
      expect(records.slice(1)).toEqual(grid.rows.map((row) => row.map((v) => v ?? '')));
    }
    const { path, result } = await exportTo({ source: tableSource('texts'), format: 'csv' });
    await result;
    const text = readFileSync(path, 'utf8');
    expect(text).toContain('\n2,"",""\n');
    expect(text).toContain('\n3,,\n');
    expect(text).toContain('\n4,"line one\nline two",ünïcödé ✓\n');
    expect(existsSync(`${path}${PARTIAL_SUFFIX}`)).toBe(false);
  });

  it('CSV: semicolon or tab delimiter, without a header', async () => {
    const { path, result } = await exportTo({
      source: tableSource('numerics'),
      format: 'csv',
      csv: { delimiter: ';', header: false },
    });
    await result;
    const lines = readFileSync(path, 'utf8').replace('\uFEFF', '').trimEnd().split('\n');
    expect(lines).toEqual([
      '1;12345678901234567890.123456789;1234567890.12;3.14159;0.1',
      '2;NaN;;Infinity;-Infinity',
      '3;;;;',
    ]);

    const tab = await exportTo({ source: tableSource('texts'), format: 'csv', csv: { delimiter: '\t', header: true } });
    await tab.result;
    expect(readFileSync(tab.path, 'utf8')).toContain('\uFEFFid\tt\tv\n1\thello\tworld\n');
  });

  it('JSON: numbers, booleans, parsed json, everything else (int8, numeric) as strings', async () => {
    for (const table of typeTables) {
      const { path, result } = await exportTo({ source: tableSource(table), format: 'json' });
      await result;
      const grid = await gridRows(table);
      const parsed = JSON.parse(readFileSync(path, 'utf8')) as Array<Record<string, unknown>>;
      expect(parsed).toEqual(
        grid.rows.map((row) => Object.fromEntries(grid.columns.map((c, i) => [c.name, typed(row[i]!, c, true)]))),
      );
    }
    const ints = await exportTo({ source: tableSource('ints'), format: 'json' });
    await ints.result;
    expect(readFileSync(ints.path, 'utf8')).toContain('"i8": "9007199254740993"');
    const jsons = await exportTo({ source: tableSource('jsons'), format: 'json' });
    await jsons.result;
    // json text is spliced as Postgres sent it, so a big number keeps every digit in the file.
    expect(readFileSync(jsons.path, 'utf8')).toContain('12345678901234567890');
  });

  it('JSON: an empty result is an empty array', async () => {
    const { path, result } = await exportTo({
      source: { kind: 'query', sql: 'select 1 as a where false' },
      format: 'json',
    });
    expect(await result).toMatchObject({ rows: 0 });
    expect(JSON.parse(readFileSync(path, 'utf8'))).toEqual([]);
  });

  it('XLSX: one sheet named after the table, bold frozen header, typed numbers and booleans', async () => {
    for (const table of typeTables) {
      const { path, result } = await exportTo({ source: tableSource(table), format: 'xlsx' });
      await result;
      const grid = await gridRows(table);
      const workbook = new ExcelJS.Workbook();
      await workbook.xlsx.readFile(path);
      expect(workbook.worksheets).toHaveLength(1);
      const sheet = workbook.worksheets[0]!;
      expect(sheet.name).toBe(table);
      expect(sheet.views[0]).toMatchObject({ state: 'frozen', ySplit: 1 });
      const header = sheet.getRow(1);
      expect(header.font?.bold ?? header.getCell(1).font?.bold).toBe(true);
      expect(grid.columns.map((_c, i) => header.getCell(i + 1).value)).toEqual(grid.columns.map((c) => c.name));
      expect(sheet.rowCount).toBe(grid.rows.length + 1);
      grid.rows.forEach((row, r) => {
        const cells = grid.columns.map((_c, i) => sheet.getRow(r + 2).getCell(i + 1).value ?? null);
        // Excel has no empty text apart from an empty cell: '' and NULL both read back as empty.
        expect(cells).toEqual(row.map((v, i) => typed(v === '' ? null : v, grid.columns[i]!, false)));
      });
    }
  });
});

describe('export sources', () => {
  it('applies the grid filters, raw WHERE and sort of a table', async () => {
    const source = {
      kind: 'table' as const,
      table: { schema: 'shop', name: 'paging' },
      filters: [{ column: 'grp', op: 'eq' as const, value: '3' }],
      where: 'id < 500',
      sort: [{ column: 'id', dir: 'desc' as const }],
    };
    const { path, result } = await exportTo({ source, format: 'csv' });
    const grid = await session.fetchRows({ ...source, limit: 10_000, offset: 0 });
    expect((await result).rows).toBe(grid.rows.length);
    const records = parse(readFileSync(path, 'utf8'), { bom: true, from_line: 2 }) as string[][];
    expect(records).toEqual(grid.rows);
    expect(records[0]![0]).toBe('493');
  });

  it('exports a query, its repeated column names made unique in JSON', async () => {
    const { path, result } = await exportTo({
      source: { kind: 'query', sql: 'select id, label, id from shop.paging where id <= 3 order by id' },
      format: 'json',
    });
    expect(await result).toMatchObject({ rows: 3 });
    expect(JSON.parse(readFileSync(path, 'utf8'))).toEqual([
      { id: 1, label: 'row 1', id_2: 1 },
      { id: 2, label: 'row 2', id_2: 2 },
      { id: 3, label: 'row 3!', id_2: 3 },
    ]);
    const xlsx = await exportTo({ source: { kind: 'query', sql: 'select 1 as one' }, format: 'xlsx' });
    await xlsx.result;
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.readFile(xlsx.path);
    expect(workbook.worksheets[0]!.name).toBe('Query');
  });

  it('fails a statement with side effects with the read-only error and leaves nothing behind', async () => {
    const { path, result } = await exportTo({
      source: { kind: 'query', sql: "insert into shop.audit_log (message) values ('export') returning *" },
      format: 'csv',
    });
    const err = await rejectionOf(result);
    expect(err.code).toBe('25006');
    expect(existsSync(path)).toBe(false);
    expect(existsSync(`${path}${PARTIAL_SUFFIX}`)).toBe(false);
    const { rows } = await db.sql("select count(*)::int as n from shop.audit_log where message = 'export'");
    expect(rows[0].n).toBe(0);
  });

  it('refuses more than one statement and a statement without rows', async () => {
    const two = await exportTo({ source: { kind: 'query', sql: 'select 1; select 2' }, format: 'csv' });
    expect((await rejectionOf(two.result)).code).toBe('42601');
    const none = await exportTo({ source: { kind: 'query', sql: 'set local work_mem = 65536' }, format: 'csv' });
    expect((await rejectionOf(none.result)).message).toMatch(/no rows/);
    expect(existsSync(none.path)).toBe(false);
  });

  it('fails with KLEOS_FILE when the folder does not exist', async () => {
    const { result } = await exportTo({
      source: tableSource('ints'),
      format: 'csv',
      path: join(dir, 'missing-folder', 'out.csv'),
    });
    expect(await rejectionOf(result)).toMatchObject({ body: { code: 'KLEOS_FILE', detail: 'ENOENT' } });
  });
});

describe('export streaming', () => {
  it('cancelling mid-way leaves no file and frees the connection', async () => {
    const { path, result } = await exportTo(
      { source: { kind: 'query', sql: 'select g, md5(g::text) from generate_series(1, 200000) g' }, format: 'csv' },
      (update, abort) => {
        if (update.rows >= 4000) abort();
      },
    );
    expect((await rejectionOf(result)).name).toBe('JobCancelled');
    expect(existsSync(path)).toBe(false);
    expect(existsSync(`${path}${PARTIAL_SUFFIX}`)).toBe(false);
    await waitUntil(async () => {
      const { rows } = await db.sql(
        "select count(*)::int as n from pg_stat_activity where application_name = 'Kleos' and query like '%generate_series(1, 200000)%'",
      );
      return rows[0].n === 0;
    });
  });

  it('a cancel interrupts a statement that is still running on the server', async () => {
    counter += 1;
    const path = join(dir, `sleep-${counter}.csv`);
    const controller = new AbortController();
    const started = Date.now();
    const result = session.exportFile(
      ExportRequest.parse({
        jobId: `sleep-${counter}`,
        source: { kind: 'query', sql: 'select pg_sleep(30) as slept' },
        format: 'csv',
        path,
      }),
      { signal: controller.signal, progress: () => undefined },
    );
    setTimeout(() => controller.abort(), 300);
    await rejectionOf(result);
    expect(Date.now() - started).toBeLessThan(10_000);
    expect(existsSync(path)).toBe(false);
    expect(existsSync(`${path}${PARTIAL_SUFFIX}`)).toBe(false);
  });

  const LARGE_ROWS = Number(process.env.KLEOS_EXPORT_ROWS ?? 300_000);

  /** Exports LARGE_ROWS generated rows while sampling the process's resident memory. */
  async function measure(format: 'csv' | 'json' | 'xlsx') {
    globalThis.gc?.();
    const before = process.memoryUsage().rss;
    let peak = before;
    const timer = setInterval(() => {
      peak = Math.max(peak, process.memoryUsage().rss);
    }, 20);
    const started = performance.now();
    try {
      const { path, result } = await exportTo({
        source: {
          kind: 'query',
          sql: `select g as id, md5(g::text) as hash, g * 1.5 as amount, now() as at, g % 2 = 0 as even
                  from generate_series(1, ${LARGE_ROWS}) g`,
        },
        format,
      });
      const { rows, bytes } = await result;
      peak = Math.max(peak, process.memoryUsage().rss);
      const mb = (n: number) => Math.round(n / 1024 / 1024);
      console.info(
        `[export ${format}] ${rows} rows, ${mb(bytes)} MB file in ${Math.round(performance.now() - started)} ms;` +
          ` RSS ${mb(before)} MB -> peak ${mb(peak)} MB (+${mb(peak - before)} MB)`,
      );
      rmSync(path);
      return { rows, growth: peak - before };
    } finally {
      clearInterval(timer);
    }
  }

  it('keeps memory flat for a large CSV export', async () => {
    const { rows, growth } = await measure('csv');
    expect(rows).toBe(LARGE_ROWS);
    expect(growth).toBeLessThan(150 * 1024 * 1024);
  }, 600_000);

  it('keeps memory flat for a large XLSX export', async () => {
    const { rows, growth } = await measure('xlsx');
    expect(rows).toBe(LARGE_ROWS);
    expect(growth).toBeLessThan(150 * 1024 * 1024);
  }, 600_000);
});

describe('export over HTTP', () => {
  it('answers 202, then the job reports done with the row count', async () => {
    const PORT = 47002;
    const TOKEN = 'export-token-'.padEnd(64, 'x');
    const store = createSqliteStore(':memory:');
    const sessions = new SessionRegistry();
    const app = createApp(
      { adapter: createPostgresAdapter(), store, secrets: createMemorySecretStore(), sessions, version: 'e2e' },
      { token: TOKEN, getPort: () => PORT },
    );
    const call = async (method: string, path: string, body?: unknown) => {
      const res = await app.request(`/api${path}`, {
        method,
        headers: { host: `127.0.0.1:${PORT}`, authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      const text = await res.text();
      return { status: res.status, json: text ? (JSON.parse(text) as Record<string, unknown>) : null };
    };
    try {
      const saved = await call('POST', '/connections', {
        nickname: 'export',
        host: db.config.host,
        port: db.config.port,
        user: db.config.user,
        database: db.config.database,
        sslMode: 'disable',
        color: 'none',
        readOnly: true,
        password: db.password,
        savePassword: true,
      });
      const opened = await call('POST', '/sessions', { connectionId: saved.json!.id });
      const sid = opened.json!.sid as string;
      const path = join(dir, 'http.csv');
      const started = await call('POST', `/sessions/${sid}/exports`, {
        jobId: 'http-export',
        source: { kind: 'table', table: { schema: 'shop', name: 'paging' }, filters: [], sort: [] },
        format: 'csv',
        path,
      });
      expect(started.status).toBe(202);
      expect(started.json).toMatchObject({ state: 'running', kind: 'export', path });
      let status: JobStatus | null = null;
      await waitUntil(async () => {
        status = (await call('GET', '/jobs/http-export')).json as JobStatus;
        return status.state !== 'running';
      });
      expect(status).toMatchObject({ state: 'done', rows: 1000, totalBytes: null });
      expect(existsSync(path)).toBe(true);
    } finally {
      await sessions.closeAll();
      store.close();
    }
  });
});
