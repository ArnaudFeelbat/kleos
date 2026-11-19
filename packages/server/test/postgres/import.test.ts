import { mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { ImportRequest } from '@kleos/shared';
import { createPostgresAdapter } from '../../src/adapter/postgres';
import type { ImportJob, JobResult, Session } from '../../src/adapter/types';
import { previewCsv } from '../../src/jobs/csv-reader';
import { type TestDatabase, rejectionOf, startPostgres } from '../helpers/postgres';

let db: TestDatabase;
let session: Session;
let dir: string;

beforeAll(async () => {
  db = await startPostgres({ seeds: ['shop.sql'] });
  session = await createPostgresAdapter().connect(db.config, db.password);
  dir = mkdtempSync(join(tmpdir(), 'kleos-import-'));
});

afterAll(async () => {
  await session?.close();
  await db?.stop();
  if (dir) rmSync(dir, { recursive: true, force: true });
});

beforeEach(async () => {
  await db.sql(`
    drop table if exists shop.people;
    create table shop.people (
      id serial primary key,
      name text not null,
      age int,
      joined date not null default '2020-01-01',
      score numeric(5, 2),
      status shop.order_status not null default 'pending',
      email text unique
    );`);
});

let counter = 0;

function file(content: string): string {
  counter += 1;
  const path = join(dir, `import-${counter}.csv`);
  writeFileSync(path, content);
  return path;
}

const people = { schema: 'shop', name: 'people' };

async function importInto(
  request: Omit<ImportJob, 'jobId' | 'nullValues' | 'delimiter' | 'hasHeader' | 'table'> &
    Partial<Pick<ImportJob, 'nullValues' | 'delimiter' | 'hasHeader' | 'table'>>,
  onProgress?: (update: JobResult, abort: () => void) => void,
  target: Session = session,
): Promise<JobResult> {
  const req = ImportRequest.parse({ jobId: 'import', table: people, delimiter: ',', hasHeader: true, ...request });
  const controller = new AbortController();
  return target.importFile(req, {
    signal: controller.signal,
    progress: (update) => onProgress?.(update, () => controller.abort()),
  });
}

async function peopleRows(): Promise<Array<Record<string, unknown>>> {
  const { rows } = await db.sql(
    `select id, name, age, joined::text, score::text, status::text, email from shop.people order by id`,
  );
  return rows;
}

describe('CSV import', () => {
  it('inserts mapped columns, leaves the others to their DEFAULT and reports progress', async () => {
    const path = file('age,ignored,name,score\n36,x,Ada,1.5\n45,y,Grace,99.99\n');
    const updates: JobResult[] = [];
    const result = await importInto(
      {
        path,
        mapping: [
          { fileColumn: 2, column: 'name' },
          { fileColumn: 0, column: 'age' },
          { fileColumn: 3, column: 'score' },
        ],
      },
      (update) => updates.push(update),
    );
    expect(result).toEqual({ rows: 2, bytes: statSync(path).size });
    expect(updates.at(-1)).toEqual(result);
    expect(await peopleRows()).toEqual([
      { id: 1, name: 'Ada', age: 36, joined: '2020-01-01', score: '1.50', status: 'pending', email: null },
      { id: 2, name: 'Grace', age: 45, joined: '2020-01-01', score: '99.99', status: 'pending', email: null },
    ]);
  });

  it('turns the chosen null texts into NULL and keeps every other text', async () => {
    const path = file('name;age;email\nAda;;NULL\nNULL;\\N;x@y\n');
    await importInto({
      path,
      delimiter: ';',
      nullValues: ['', '\\N'],
      mapping: [
        { fileColumn: 0, column: 'name' },
        { fileColumn: 1, column: 'age' },
        { fileColumn: 2, column: 'email' },
      ],
    });
    expect((await peopleRows()).map((r) => [r.name, r.age, r.email])).toEqual([
      ['Ada', null, 'NULL'],
      ['NULL', null, 'x@y'],
    ]);
  });

  it('imports a file without a header, enum and date values coerced by Postgres', async () => {
    const path = file('Ada,2024-02-29,paid\nGrace,2023-12-31,shipped\n');
    await importInto({
      path,
      hasHeader: false,
      mapping: [
        { fileColumn: 0, column: 'name' },
        { fileColumn: 1, column: 'joined' },
        { fileColumn: 2, column: 'status' },
      ],
    });
    expect((await peopleRows()).map((r) => [r.name, r.joined, r.status])).toEqual([
      ['Ada', '2024-02-29', 'paid'],
      ['Grace', '2023-12-31', 'shipped'],
    ]);
  });

  it('auto-detects a semicolon file in the preview, then imports with it', async () => {
    const path = file('\uFEFFname;age;note\nÉlodie;31;"a; b"\nZoë;28;c\n');
    const preview = await previewCsv({ path, hasHeader: true });
    expect(preview).toMatchObject({ delimiter: ';', columns: ['name', 'age', 'note'], totalRows: 2 });
    await importInto({
      path,
      delimiter: preview.delimiter,
      mapping: [
        { fileColumn: 0, column: 'name' },
        { fileColumn: 1, column: 'age' },
      ],
    });
    expect((await peopleRows()).map((r) => [r.name, r.age])).toEqual([
      ['Élodie', 31],
      ['Zoë', 28],
    ]);
  });

  it('inserts several batches (more rows than one INSERT carries)', async () => {
    const lines = ['name,age'];
    for (let i = 1; i <= 2500; i += 1) lines.push(`p${i},${i}`);
    const result = await importInto({
      path: file(`${lines.join('\n')}\n`),
      mapping: [
        { fileColumn: 0, column: 'name' },
        { fileColumn: 1, column: 'age' },
      ],
    });
    expect(result.rows).toBe(2500);
    const { rows } = await db.sql('select count(*)::int as n, sum(age)::int as total from shop.people');
    expect(rows[0]).toEqual({ n: 2500, total: (2500 * 2501) / 2 });
  });
});

describe('CSV import errors roll everything back', () => {
  const nameAge = [
    { fileColumn: 0, column: 'name' },
    { fileColumn: 1, column: 'age' },
  ];

  it('names the file line and the column of a bad value', async () => {
    const path = file('name,age\nAda,36\nGrace,45\nLinus,abc\nKen,70\n');
    const err = await rejectionOf(importInto({ path, mapping: nameAge }));
    expect(err).toMatchObject({
      body: { code: '22P02', detail: 'line 4', column: 'age', message: expect.stringMatching(/integer.*"abc"/) },
    });
    expect(await peopleRows()).toEqual([]);
  });

  it('finds the line in a later batch', async () => {
    const lines = ['name,age'];
    for (let i = 1; i <= 2500; i += 1) lines.push(i === 2301 ? 'bad,1.5' : `p${i},${i}`);
    const err = await rejectionOf(importInto({ path: file(`${lines.join('\n')}\n`), mapping: nameAge }));
    // Line 1 is the header, so the 2301st data row is line 2302.
    expect(err).toMatchObject({ body: { code: '22P02', detail: 'line 2302', column: 'age' } });
    expect(await peopleRows()).toEqual([]);
  });

  it('counts physical lines across quoted values with line breaks', async () => {
    const path = file('name,age\n"multi\nline",1\nBob,2\n"x\ny\nz",3\n\nBad,oops\n');
    const err = await rejectionOf(importInto({ path, mapping: nameAge }));
    expect(err).toMatchObject({ body: { detail: 'line 9', column: 'age' } });
    expect(await peopleRows()).toEqual([]);
  });

  it('takes the column from a NOT NULL or unique violation', async () => {
    const nullName = await rejectionOf(importInto({ path: file('name,age\nAda,1\n,2\n'), mapping: nameAge }));
    expect(nullName).toMatchObject({ body: { code: '23502', detail: 'line 3', column: 'name' } });

    const duplicate = await rejectionOf(
      importInto({
        path: file('name,email\nAda,a@x\nGrace,g@x\nAda again,a@x\n'),
        mapping: [
          { fileColumn: 0, column: 'name' },
          { fileColumn: 1, column: 'email' },
        ],
      }),
    );
    expect(duplicate).toMatchObject({
      body: {
        code: '23505',
        detail: 'line 4',
        column: 'email',
        message: expect.stringMatching(/Key \(email\)=\(a@x\) already exists/),
      },
    });
    expect(await peopleRows()).toEqual([]);
  });

  it('refuses a short row, a view, an unknown or twice-mapped column', async () => {
    const short = await rejectionOf(importInto({ path: file('name,age\nAda,1\nGrace\n'), mapping: nameAge }));
    expect(short).toMatchObject({ body: { code: 'KLEOS_VALIDATION', detail: 'line 3', column: 'age' } });

    const view = await rejectionOf(
      importInto({
        path: file('a\n1\n'),
        table: { schema: 'shop', name: 'order_totals' },
        mapping: [{ fileColumn: 0, column: 'orders' }],
      }),
    );
    expect(view).toMatchObject({ body: { code: 'KLEOS_VALIDATION', message: expect.stringMatching(/not a table/) } });

    const unknown = await rejectionOf(
      importInto({ path: file('a\n1\n'), mapping: [{ fileColumn: 0, column: 'nope' }] }),
    );
    expect(unknown).toMatchObject({ body: { code: 'KLEOS_VALIDATION', message: expect.stringMatching(/"nope"/) } });

    const twice = await rejectionOf(
      importInto({
        path: file('a,b\n1,2\n'),
        mapping: [
          { fileColumn: 0, column: 'name' },
          { fileColumn: 1, column: 'name' },
        ],
      }),
    );
    expect(twice).toMatchObject({ body: { message: expect.stringMatching(/mapped more than once/) } });
    expect(await peopleRows()).toEqual([]);
  });

  it('fails a file that is not UTF-8 with KLEOS_FILE', async () => {
    const path = join(dir, 'latin1.csv');
    writeFileSync(path, Buffer.from('name\ncaf\xe9\n', 'latin1'));
    const err = await rejectionOf(importInto({ path, mapping: [{ fileColumn: 0, column: 'name' }] }));
    expect(err).toMatchObject({ body: { code: 'KLEOS_FILE' } });
    expect(await peopleRows()).toEqual([]);
  });

  it('cancelling rolls back the rows already inserted', async () => {
    const lines = ['name,age'];
    for (let i = 1; i <= 50_000; i += 1) lines.push(`p${i},${i}`);
    const err = await rejectionOf(
      importInto({ path: file(`${lines.join('\n')}\n`), mapping: nameAge }, (update, abort) => {
        if (update.rows >= 3000) abort();
      }),
    );
    expect(err.name).toBe('JobCancelled');
    expect(await peopleRows()).toEqual([]);
  });

  it('cannot write through a read-only session even when called directly', async () => {
    const readOnly = await createPostgresAdapter().connect({ ...db.config, readOnly: true }, db.password);
    try {
      const err = await rejectionOf(
        importInto({ path: file('name\nAda\n'), mapping: [nameAge[0]!] }, undefined, readOnly),
      );
      expect(err).toMatchObject({ body: { code: '25006' } });
    } finally {
      await readOnly.close();
    }
    expect(await peopleRows()).toEqual([]);
  });
});
