import { z } from 'zod';
import { ApiErrorBody } from './errors';
import { Filter, SortKey } from './rows';
import { TableRef } from './schema';

/**
 * Export and import run as background jobs on the local server, which reads and writes the
 * file itself (the server lives in the app's main process), streaming through a cursor so a
 * large table never loads into memory. The window polls GET /jobs/:jobId for progress.
 */

export const exportFormats = ['csv', 'json', 'xlsx'] as const;
export const ExportFormat = z.enum(exportFormats);
export type ExportFormat = z.infer<typeof ExportFormat>;

export const ExportSource = z.discriminatedUnion('kind', [
  /** A table or view with the Data tab's current filters, raw WHERE and sort. */
  z.object({
    kind: z.literal('table'),
    table: TableRef,
    filters: z.array(Filter),
    where: z.string().optional(),
    sort: z.array(SortKey),
  }),
  /** One statement, run again on its own cursor (on read-only sessions inside a read-only transaction). */
  z.object({ kind: z.literal('query'), sql: z.string().min(1) }),
]);
export type ExportSource = z.infer<typeof ExportSource>;

export const ExportRequest = z.object({
  /** Chosen by the window (a UUID) so it can be cancelled at once. */
  jobId: z.string().min(1).max(100),
  source: ExportSource,
  format: ExportFormat,
  /** Absolute path picked in the native save dialog; its extension matches the format. */
  path: z.string().min(1),
  csv: z
    .object({
      delimiter: z.enum([',', ';', '\t']).default(','),
      header: z.boolean().default(true),
    })
    .optional(),
});
export type ExportRequest = z.input<typeof ExportRequest>;

/** Body of POST /imports/preview: no session needed, only the file. */
export const ImportPreviewRequest = z.object({
  path: z.string().min(1),
  /** Detected from the first lines when absent. */
  delimiter: z.enum([',', ';', '\t']).optional(),
  hasHeader: z.boolean().default(true),
});
export type ImportPreviewRequest = z.input<typeof ImportPreviewRequest>;

export const ImportPreview = z.object({
  path: z.string(),
  delimiter: z.enum([',', ';', '\t']),
  /** Header names, or "column 1", "column 2", … without a header. */
  columns: z.array(z.string()),
  /** The first rows as text (at most 50). */
  rows: z.array(z.array(z.string())),
  /** Data rows in the whole file (header excluded). */
  totalRows: z.number(),
  bytes: z.number(),
});
export type ImportPreview = z.infer<typeof ImportPreview>;

export const ImportRequest = z.object({
  jobId: z.string().min(1).max(100),
  table: TableRef,
  path: z.string().min(1),
  delimiter: z.enum([',', ';', '\t']),
  hasHeader: z.boolean(),
  /** File column index -> table column. Unmapped table columns take their DEFAULT. */
  mapping: z.array(z.object({ fileColumn: z.number().int().min(0), column: z.string() })).min(1),
  /** Cell texts that mean NULL, e.g. ["", "NULL"]. */
  nullValues: z.array(z.string()).default(['']),
});
export type ImportRequest = z.input<typeof ImportRequest>;

export const JobStatus = z.object({
  jobId: z.string(),
  kind: z.enum(['export', 'import']),
  state: z.enum(['running', 'done', 'failed', 'cancelled']),
  /** Rows written (export) or inserted so far (import; committed only when state is done). */
  rows: z.number(),
  /** Bytes written (export) or read (import). */
  bytes: z.number(),
  /** Total for a progress bar when known (import: file size; export: unknown → null). */
  totalBytes: z.number().nullable(),
  path: z.string(),
  startedAt: z.string(),
  finishedAt: z.string().nullable(),
  /**
   * When failed. Import errors carry the file line in `detail` ("line 1204") and the column
   * in `column`; the whole import was rolled back.
   */
  error: ApiErrorBody.nullable(),
});
export type JobStatus = z.infer<typeof JobStatus>;
