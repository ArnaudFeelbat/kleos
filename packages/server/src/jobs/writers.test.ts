import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { PartialFile } from './files';
import { CsvWriter, XLSX_MAX_DATA_ROWS, XlsxWriter, sheetName, uniqueNames } from './writers';

const dir = mkdtempSync(join(tmpdir(), 'kleos-writers-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

async function openFile(name: string): Promise<PartialFile> {
  const file = new PartialFile(join(dir, name));
  await file.open();
  return file;
}

describe('CsvWriter', () => {
  it('quotes per RFC 4180 and keeps NULL apart from the empty string', async () => {
    const file = await openFile('quotes.csv');
    const writer = new CsvWriter(file, { delimiter: ';', header: true });
    await writer.begin([
      { name: 'a;b', kind: 'text' },
      { name: 'plain', kind: 'text' },
    ]);
    await writer.write([
      ['say "hi"', 'x,y'],
      ['', null],
      ['two\nlines', 'cr\rhere'],
    ]);
    await writer.end();
    await file.finish();
    expect(readFileSync(join(dir, 'quotes.csv'), 'utf8')).toBe(
      '\uFEFF"a;b";plain\n"say ""hi""";x,y\n"";\n"two\nlines";"cr\rhere"\n',
    );
    expect(file.bytes).toBe(readFileSync(join(dir, 'quotes.csv')).length);
  });
});

describe('XlsxWriter', () => {
  it('refuses more rows than an Excel sheet holds', async () => {
    const file = await openFile('big.xlsx');
    const writer = new XlsxWriter(file, 'big');
    await writer.begin([{ name: 'n', kind: 'number' }]);
    const tooMany = { length: XLSX_MAX_DATA_ROWS + 1 } as unknown as string[][];
    await expect(writer.write(tooMany)).rejects.toMatchObject({
      body: { code: 'KLEOS_VALIDATION', detail: expect.stringMatching(/1,048,575 rows\. Export as CSV/) },
    });
    await file.discard();
  });
});

describe('names', () => {
  it('makes repeated column names unique and sheet names valid', () => {
    expect(uniqueNames(['id', 'id', 'id_2', 'x'])).toEqual(['id', 'id_2', 'id_2_2', 'x']);
    expect(sheetName('a/b:c*[d]?')).toBe('a b c  d');
    expect(sheetName('x'.repeat(40))).toHaveLength(31);
    expect(sheetName('')).toBe('Sheet1');
  });
});
