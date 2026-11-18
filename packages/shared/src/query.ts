import { z } from 'zod';
import { CellValue, ColumnMeta } from './rows';

export const QueryRequest = z.object({
  /**
   * Chosen by the frontend (a UUID) so Cancel can target the query while the
   * first page is still running.
   */
  qid: z.string().min(1).max(100),
  sql: z.string().min(1),
  /** Query tab id chosen by the frontend; each tab gets its own dedicated database client. */
  tabId: z.string().min(1),
  pageSize: z.number().int().min(1).max(5000).default(500),
});
export type QueryRequest = z.input<typeof QueryRequest>;

export const QueryStarted = z.object({
  qid: z.string(),
  columns: z.array(ColumnMeta),
  rows: z.array(z.array(CellValue)),
  hasMore: z.boolean(),
  /** Command tag for statements that return no rows, e.g. "UPDATE 3", "CREATE TABLE". */
  command: z.string().nullable(),
  /** Rows affected for commands; rows fetched so far for selects. */
  rowCount: z.number().nullable(),
  elapsedMs: z.number(),
});
export type QueryStarted = z.infer<typeof QueryStarted>;

export const QueryPage = z.object({
  rows: z.array(z.array(CellValue)),
  hasMore: z.boolean(),
  elapsedMs: z.number(),
});
export type QueryPage = z.infer<typeof QueryPage>;

export const ExplainRequest = z.object({
  /** Chosen by the frontend, cancellable like a query. */
  qid: z.string().min(1).max(100),
  sql: z.string().min(1),
  tabId: z.string().min(1),
});
export type ExplainRequest = z.infer<typeof ExplainRequest>;

/** One node of EXPLAIN (ANALYZE, FORMAT JSON), keys as Postgres writes them ("Node Type", "Actual Total Time", ...). */
export type PlanNode = {
  'Node Type': string;
  'Relation Name'?: string;
  Alias?: string;
  'Index Name'?: string;
  'Actual Total Time'?: number;
  'Actual Startup Time'?: number;
  'Actual Rows'?: number;
  'Plan Rows'?: number;
  'Actual Loops'?: number;
  'Total Cost'?: number;
  'Startup Cost'?: number;
  Plans?: PlanNode[];
  [key: string]: unknown;
};

export const ExplainResult = z.object({
  plan: z.custom<PlanNode>((v) => typeof v === 'object' && v !== null && 'Node Type' in v),
  planningMs: z.number(),
  executionMs: z.number(),
});
export type ExplainResult = z.infer<typeof ExplainResult>;

export const chartTypes = ['line', 'bar', 'scatter'] as const;
export const ChartSettings = z.object({
  type: z.enum(chartTypes),
  x: z.string(),
  y: z.array(z.string()).min(1),
});
export type ChartSettings = z.infer<typeof ChartSettings>;

export const HistoryEntry = z.object({
  id: z.string(),
  connectionId: z.string(),
  sql: z.string(),
  kind: z.enum(['query', 'explain']),
  ranAt: z.string(),
  elapsedMs: z.number().nullable(),
  rowCount: z.number().nullable(),
  /** Postgres error code and message, e.g. "42703 column o.stauts does not exist". */
  error: z.string().nullable(),
  cancelled: z.boolean(),
});
export type HistoryEntry = z.infer<typeof HistoryEntry>;

export const NewHistoryEntry = HistoryEntry.omit({ id: true, connectionId: true });
export type NewHistoryEntry = z.infer<typeof NewHistoryEntry>;

export const SavedQuery = z.object({
  id: z.string(),
  connectionId: z.string(),
  name: z.string().min(1),
  sql: z.string(),
  chart: ChartSettings.nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type SavedQuery = z.infer<typeof SavedQuery>;

export const SavedQueryInput = z.object({
  connectionId: z.string(),
  name: z.string().trim().min(1).max(200),
  sql: z.string(),
  chart: ChartSettings.nullable(),
});
export type SavedQueryInput = z.infer<typeof SavedQueryInput>;

export const LayoutPositions = z.object({
  /** tableKey ("schema.table") -> top-left position on the canvas */
  positions: z.record(z.string(), z.object({ x: z.number(), y: z.number() })),
});
export type LayoutPositions = z.infer<typeof LayoutPositions>;
