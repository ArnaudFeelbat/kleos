import type { PlanNode } from '@kleos/shared';

export type PlanRow = {
  /** Path in the tree ("0", "0.1", ...), stable for selection. */
  id: string;
  depth: number;
  node: PlanNode;
  /** Actual total time × loops, in ms. */
  totalMs: number;
  /** Total minus the children's totals, never negative. */
  selfMs: number;
  /** selfMs as a share of the execution time, 0..1. */
  share: number;
  actualRows: number | null;
  planRows: number | null;
  loops: number | null;
  /** The node with the most self time (only when some node has any). */
  hottest: boolean;
};

/** Time spent in a node across all its loops: Postgres reports per-loop averages. */
export function nodeTotalMs(node: PlanNode): number {
  const perLoop = node['Actual Total Time'];
  if (typeof perLoop !== 'number') return 0;
  const loops = typeof node['Actual Loops'] === 'number' ? node['Actual Loops'] : 1;
  return perLoop * loops;
}

/** Flattens a plan into indented rows with self time = total − children. */
export function computePlanRows(plan: PlanNode, executionMs: number): PlanRow[] {
  const rows: PlanRow[] = [];
  const walk = (node: PlanNode, depth: number, id: string) => {
    const totalMs = nodeTotalMs(node);
    const children = node.Plans ?? [];
    const childMs = children.reduce((sum, c) => sum + nodeTotalMs(c), 0);
    const selfMs = Math.max(0, totalMs - childMs);
    rows.push({
      id,
      depth,
      node,
      totalMs,
      selfMs,
      share: executionMs > 0 ? Math.min(1, selfMs / executionMs) : 0,
      actualRows: typeof node['Actual Rows'] === 'number' ? node['Actual Rows'] : null,
      planRows: typeof node['Plan Rows'] === 'number' ? node['Plan Rows'] : null,
      loops: typeof node['Actual Loops'] === 'number' ? node['Actual Loops'] : null,
      hottest: false,
    });
    children.forEach((c, i) => walk(c, depth + 1, `${id}.${i}`));
  };
  walk(plan, 0, '0');
  let hottest: PlanRow | null = null;
  for (const r of rows) if (r.selfMs > 0 && (!hottest || r.selfMs > hottest.selfMs)) hottest = r;
  if (hottest) hottest.hottest = true;
  return rows;
}

/** "Bitmap Heap Scan" + "on orders o" / "using idx on orders" / "on orders_placed_at_idx". */
export function nodeTarget(node: PlanNode): string | null {
  const rel = node['Relation Name'];
  const alias = node.Alias;
  const index = node['Index Name'];
  const relText = rel ? `${rel}${alias && alias !== rel ? ` ${alias}` : ''}` : null;
  if (index && relText) return `using ${index} on ${relText}`;
  if (relText) return `on ${relText}`;
  if (index) return `on ${index}`;
  if (typeof node['CTE Name'] === 'string') return `on ${node['CTE Name']}`;
  if (typeof node['Function Name'] === 'string') return `on ${node['Function Name']}`;
  return null;
}

const summaryKeys = [
  'Sort Key',
  'Group Key',
  'Hash Cond',
  'Merge Cond',
  'Join Filter',
  'Index Cond',
  'Recheck Cond',
  'Filter',
  'Sort Method',
  'Rows Removed by Filter',
] as const;

/** Secondary line under a node: its condition or key, e.g. "Filter: status <> 'cancelled' · removed 1,163 rows". */
export function nodeSummary(node: PlanNode): string | null {
  const parts: string[] = [];
  for (const key of summaryKeys) {
    const v = node[key];
    if (v === undefined || v === null) continue;
    if (key === 'Rows Removed by Filter') {
      if (typeof v === 'number' && v > 0) parts.push(`removed ${v.toLocaleString('en-US')} rows`);
    } else if (key === 'Sort Method') {
      parts.push(String(v));
    } else {
      parts.push(`${key}: ${formatPlanValue(v)}`);
    }
    if (parts.length >= 3) break;
  }
  return parts.length ? parts.join(' · ') : null;
}

const shownElsewhere = new Set([
  'Plans',
  'Node Type',
  'Relation Name',
  'Alias',
  'Index Name',
  'Actual Total Time',
  'Actual Rows',
  'Plan Rows',
  'Actual Loops',
]);

/** Every other key of a node for the detail panel, in Postgres order. */
export function nodeDetails(node: PlanNode): { key: string; value: string }[] {
  return Object.entries(node)
    .filter(([k, v]) => !shownElsewhere.has(k) && v !== undefined)
    .map(([key, v]) => ({ key, value: formatPlanValue(v) }));
}

export function formatPlanValue(v: unknown): string {
  if (typeof v === 'number') return Number.isInteger(v) ? v.toLocaleString('en-US') : String(v);
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  if (Array.isArray(v)) return v.map(formatPlanValue).join(', ');
  if (v !== null && typeof v === 'object') return JSON.stringify(v);
  return String(v);
}
