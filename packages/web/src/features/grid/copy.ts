import type { CellValue } from '@kleos/shared';

export type CopyFormat = 'csv' | 'tsv';

/**
 * RFC 4180 CSV field: NULL is an empty unquoted field, an empty string is "" so the two
 * stay distinguishable; fields with commas, quotes or line breaks are quoted.
 */
function csvField(value: CellValue | undefined): string {
  if (value === null || value === undefined) return '';
  if (value === '') return '""';
  return /[",\r\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
}

/** TSV field for pasting into spreadsheets: quoted only when it holds a tab, quote or line break. */
function tsvField(value: CellValue | undefined): string {
  if (value === null || value === undefined) return '';
  return /[\t"\r\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
}

/** Rows (and an optional header line) as CSV or TSV text, lines joined with \n. */
export function formatRows(
  rows: readonly (readonly (CellValue | undefined)[])[],
  format: CopyFormat,
  header?: readonly string[],
): string {
  const field = format === 'csv' ? csvField : tsvField;
  const sep = format === 'csv' ? ',' : '\t';
  const lines = rows.map((r) => r.map(field).join(sep));
  if (header) lines.unshift(header.map((h) => field(h)).join(sep));
  return lines.join('\n');
}

/** Writes to the clipboard; returns false when the browser refuses. */
export async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}
