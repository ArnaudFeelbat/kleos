import { describe, expect, it } from 'vitest';
import type { ColumnMeta, PlanNode } from '@kleos/shared';
import {
  CHART_ROW_CAP,
  defaultChartSettings,
  formatTick,
  prepareChartData,
  sameChart,
  seriesColors,
} from './chart-data';
import { errorRange, lineColumn } from './error-position';
import { computePlanRows, nodeDetails, nodeSummary, nodeTarget } from './explain-plan';
import { lineSpan, runTarget } from './run-target';
import { buildSqlNamespace } from './schema-completion';

describe('runTarget', () => {
  const doc = 'select 1;\n\nselect *\nfrom orders;\n-- note\nselect 3';

  it('runs the statement under the cursor when nothing is selected', () => {
    const at = doc.indexOf('from');
    expect(runTarget(doc, { from: at, to: at })).toEqual({
      sql: 'select *\nfrom orders',
      from: doc.indexOf('select *'),
      to: doc.indexOf('from orders') + 'from orders'.length,
    });
    expect(runTarget(doc, { from: 3, to: 3 })?.sql).toBe('select 1');
  });

  it('runs the statement just before the cursor when it sits after a semicolon', () => {
    const end = doc.indexOf(';') + 1;
    expect(runTarget(doc, { from: end, to: end })?.sql).toBe('select 1');
  });

  it('runs the selection, trimmed and without a trailing semicolon', () => {
    const from = doc.indexOf('select *') - 1;
    const to = doc.indexOf('orders;') + 'orders;'.length;
    expect(runTarget(doc, { from, to })).toEqual({
      sql: 'select *\nfrom orders',
      from: from + 1,
      to: from + 1 + 'select *\nfrom orders'.length,
    });
  });

  it('accepts a backwards selection and falls back to the cursor for a blank one', () => {
    const a = doc.indexOf('select 3');
    expect(runTarget(doc, { from: a + 8, to: a })?.sql).toBe('select 3');
    expect(runTarget(doc, { from: 9, to: 11 })?.sql).toBe('select *\nfrom orders');
  });

  it('returns null for an editor with only comments', () => {
    expect(runTarget('-- nothing\n', { from: 0, to: 0 })).toBeNull();
  });

  it('reports the line span of a statement', () => {
    const t = runTarget(doc, { from: doc.indexOf('from'), to: doc.indexOf('from') })!;
    expect(lineSpan(doc, t.from, t.to)).toEqual({ first: 3, last: 4 });
  });
});

describe('errorRange', () => {
  it('maps a 1-based position in the statement to the token in the document', () => {
    const doc = '-- first\nselect o.stauts, count(*)\nfrom orders o group by 1;';
    const from = doc.indexOf('select');
    const stmt = doc.slice(from, doc.indexOf(';'));
    // Postgres: position 8 is the "o" of o.stauts.
    expect(errorRange(doc, from, stmt, 8)).toEqual({
      from: doc.indexOf('o.stauts'),
      to: doc.indexOf('o.stauts') + 'o.stauts'.length,
    });
    expect(lineColumn(doc, doc.indexOf('o.stauts'))).toEqual({ line: 2, column: 8 });
  });

  it('counts characters, not UTF-16 units, before the error', () => {
    const doc = "select '😀', nope";
    expect(errorRange(doc, 0, doc, 13)).toEqual({ from: doc.indexOf('nope'), to: doc.length });
  });

  it('marks the last character for errors at the end of input', () => {
    const doc = 'select * from';
    expect(errorRange(doc, 0, doc, doc.length + 1)).toEqual({ from: doc.length - 1, to: doc.length });
  });

  it('marks a single character when the position is on punctuation', () => {
    const doc = 'select (1';
    expect(errorRange(doc, 0, doc, 8)).toEqual({ from: 7, to: 8 });
  });
});

describe('computePlanRows', () => {
  const plan: PlanNode = {
    'Node Type': 'Sort',
    'Actual Total Time': 212.4,
    'Actual Rows': 30,
    'Plan Rows': 30,
    'Actual Loops': 1,
    'Sort Key': ["(date_trunc('day', placed_at))::date DESC"],
    'Sort Method': 'quicksort',
    Plans: [
      {
        'Node Type': 'HashAggregate',
        'Actual Total Time': 212.1,
        'Actual Rows': 30,
        'Plan Rows': 31,
        'Actual Loops': 1,
        Plans: [
          {
            'Node Type': 'Bitmap Heap Scan',
            'Relation Name': 'orders',
            Alias: 'o',
            'Actual Total Time': 190.5,
            'Actual Rows': 41207,
            'Plan Rows': 39850,
            'Actual Loops': 1,
            Filter: "(status <> 'cancelled'::order_status)",
            'Rows Removed by Filter': 1163,
            Plans: [
              {
                'Node Type': 'Bitmap Index Scan',
                'Index Name': 'orders_placed_at_idx',
                'Actual Total Time': 18.7,
                'Actual Rows': 42370,
                'Plan Rows': 40912,
                'Actual Loops': 1,
              },
            ],
          },
        ],
      },
    ],
  };

  it('computes self time as total minus children and its share of execution', () => {
    const rows = computePlanRows(plan, 212.6);
    expect(rows.map((r) => [r.node['Node Type'], r.depth])).toEqual([
      ['Sort', 0],
      ['HashAggregate', 1],
      ['Bitmap Heap Scan', 2],
      ['Bitmap Index Scan', 3],
    ]);
    expect(rows.map((r) => Number(r.selfMs.toFixed(1)))).toEqual([0.3, 21.6, 171.8, 18.7]);
    expect(rows[2]!.share).toBeCloseTo(171.8 / 212.6, 3);
  });

  it('flags the node with the most self time', () => {
    const rows = computePlanRows(plan, 212.6);
    expect(rows.filter((r) => r.hottest).map((r) => r.node['Node Type'])).toEqual(['Bitmap Heap Scan']);
  });

  it('multiplies per-loop times by loops and never goes below zero', () => {
    const looped: PlanNode = {
      'Node Type': 'Nested Loop',
      'Actual Total Time': 10,
      'Actual Loops': 1,
      Plans: [{ 'Node Type': 'Index Scan', 'Actual Total Time': 0.5, 'Actual Loops': 40 }],
    };
    const rows = computePlanRows(looped, 10);
    expect(rows[1]!.totalMs).toBe(20);
    expect(rows[0]!.selfMs).toBe(0);
    expect(rows[1]!.hottest).toBe(true);
  });

  it('flags nothing for a plan without timings', () => {
    expect(computePlanRows({ 'Node Type': 'Seq Scan' }, 0).some((r) => r.hottest)).toBe(false);
  });

  it('describes relations, indexes, conditions and other keys', () => {
    expect(nodeTarget({ 'Node Type': 'Bitmap Heap Scan', 'Relation Name': 'orders', Alias: 'o' })).toBe('on orders o');
    expect(nodeTarget({ 'Node Type': 'Bitmap Index Scan', 'Index Name': 'orders_placed_at_idx' })).toBe(
      'on orders_placed_at_idx',
    );
    expect(
      nodeTarget({ 'Node Type': 'Index Scan', 'Index Name': 'pk', 'Relation Name': 'orders', Alias: 'orders' }),
    ).toBe('using pk on orders');
    expect(nodeSummary(plan.Plans![0]!.Plans![0]!)).toBe(
      "Filter: (status <> 'cancelled'::order_status) · removed 1,163 rows",
    );
    expect(nodeSummary(plan)).toBe("Sort Key: (date_trunc('day', placed_at))::date DESC · quicksort");
    expect(nodeDetails({ 'Node Type': 'Seq Scan', 'Shared Hit Blocks': 2113, 'Startup Cost': 0.5 })).toEqual([
      { key: 'Shared Hit Blocks', value: '2,113' },
      { key: 'Startup Cost', value: '0.5' },
    ]);
  });
});

describe('chart data', () => {
  const col = (name: string, typeName: string, typeCategory = 'N'): ColumnMeta => ({
    name,
    type: typeName,
    typeName,
    typeOid: 0,
    typeCategory,
  });
  const columns = [col('day', 'date', 'D'), col('web', 'numeric'), col('ios', 'int8'), col('android', 'float8')];

  it('picks a non-numeric x and the numeric columns as y', () => {
    expect(defaultChartSettings(columns)).toEqual({ type: 'line', x: 'day', y: ['web', 'ios', 'android'] });
    expect(defaultChartSettings([col('label', 'text', 'S')])).toBeNull();
    expect(defaultChartSettings([col('a', 'int4'), col('b', 'int4')], 'scatter')).toEqual({
      type: 'scatter',
      x: 'a',
      y: ['b'],
    });
  });

  it('parses values for plotting only, keeping x as text for line charts', () => {
    const data = prepareChartData(
      columns,
      [
        ['2026-11-17', '24339.10', '12207', 'NaN'],
        ['2026-11-16', null, '9007199254740993', '7.5'],
      ],
      { type: 'line', x: 'day', y: ['web', 'ios', 'android'] },
    );
    expect(data.points).toEqual([
      { x: '2026-11-17', y0: 24339.1, y1: 12207, y2: null },
      { x: '2026-11-16', y0: null, y1: 9007199254740992, y2: 7.5 },
    ]);
    expect(data.xNumeric).toBe(false);
  });

  it('assigns chart-1..3 in series order and drops a fourth series instead of cycling', () => {
    const data = prepareChartData([...columns, col('pos', 'int4')], [], {
      type: 'bar',
      x: 'day',
      y: ['ios', 'web', 'android', 'pos'],
    });
    expect(data.series).toEqual([
      { column: 'ios', dataKey: 'y0', color: seriesColors[0] },
      { column: 'web', dataKey: 'y1', color: seriesColors[1] },
      { column: 'android', dataKey: 'y2', color: seriesColors[2] },
    ]);
    expect(data.dropped).toEqual(['pos']);
  });

  it('caps the points at 5,000 rows and says so', () => {
    const rows = Array.from({ length: CHART_ROW_CAP + 10 }, (_, i) => [String(i), String(i), '1', '2']);
    const data = prepareChartData(columns, rows, { type: 'line', x: 'day', y: ['web'] });
    expect(data.points).toHaveLength(CHART_ROW_CAP);
    expect(data.truncated).toBe(true);
  });

  it('uses a numeric x axis for scatter on a numeric column', () => {
    const data = prepareChartData(columns, [['2026-11-17', '1.5', '2', '3']], {
      type: 'scatter',
      x: 'web',
      y: ['ios'],
    });
    expect(data.xNumeric).toBe(true);
    expect(data.points[0]).toEqual({ x: 1.5, y0: 2 });
  });

  it('reports columns a saved chart names that the result lacks', () => {
    expect(prepareChartData(columns, [], { type: 'line', x: 'day', y: ['gone', 'web'] }).missing).toEqual(['gone']);
  });

  it('formats ticks compactly and compares settings', () => {
    expect(formatTick(35000)).toBe('35k');
    expect(formatTick(1250000)).toBe('1.25M');
    expect(formatTick(0.5)).toBe('0.5');
    expect(sameChart({ type: 'line', x: 'a', y: ['b'] }, { type: 'line', x: 'a', y: ['b'] })).toBe(true);
    expect(sameChart({ type: 'line', x: 'a', y: ['b'] }, { type: 'bar', x: 'a', y: ['b'] })).toBe(false);
  });
});

describe('buildSqlNamespace', () => {
  it('nests schemas, tables and columns for autocomplete', () => {
    const ns = buildSqlNamespace({
      schemas: ['public'],
      tables: [
        {
          schema: 'public',
          name: 'payments',
          kind: 'table',
          columns: [
            {
              name: 'paid_at',
              type: 'timestamp with time zone',
              typeName: 'timestamptz',
              typeOid: 1184,
              typeCategory: 'D',
              nullable: true,
              default: null,
              identity: null,
              generated: false,
            },
          ],
          primaryKey: [],
          indexes: [],
          constraints: [],
          rowEstimate: 1100000,
          totalBytes: 0,
          comment: null,
        },
      ],
      views: [],
      foreignKeys: [],
      enums: [],
      introspectedAt: '',
    }) as Record<string, Record<string, { self: { label: string; detail?: string }; children: { label: string }[] }>>;
    expect(ns.public!.payments!.self).toMatchObject({ label: 'payments', detail: 'table · 1.1M rows' });
    expect(ns.public!.payments!.children.map((c) => c.label)).toEqual(['paid_at']);
  });
});
