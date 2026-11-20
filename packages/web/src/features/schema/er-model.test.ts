import type { SchemaModel } from '@kleos/shared';
import { describe, expect, it } from 'vitest';
import { buildErGraph, columnTypeLabel, inHandle, nodeHeight, outHandle, shortType } from './er-model';
import { layoutWithElk, placeMissing } from './layout';
import { col, fk, shopModel, table } from './test-fixtures';

describe('buildErGraph', () => {
  it('makes one node per table of the schema and one edge per foreign key', () => {
    const graph = buildErGraph(shopModel(), 'public', null);
    expect(graph.nodes.map((n) => n.id)).toEqual([
      'public.categories',
      'public.customers',
      'public.order_items',
      'public.orders',
      'public.products',
      // sales.invoices references public.orders: drawn as an external node, after the schema's own.
      'sales.invoices',
    ]);
    expect(graph.nodes.filter((n) => n.data.external).map((n) => n.id)).toEqual(['sales.invoices']);
    expect(graph.limited).toBe(false);
    expect(graph.total).toBe(5);
    expect(graph.edges).toHaveLength(6);
    const orders = graph.edges.find((e) => e.fk.name === 'orders_customer_id_fkey');
    // Parent -> child, between the two columns.
    expect(orders).toMatchObject({
      source: 'public.customers',
      sourceHandle: outHandle('id'),
      target: 'public.orders',
      targetHandle: inHandle('customer_id'),
      label: 'customer_id',
    });
  });

  it('keeps self-references as an edge from a table to itself', () => {
    const graph = buildErGraph(shopModel(), 'public', null);
    const self = graph.edges.find((e) => e.fk.table === 'categories');
    expect(self).toMatchObject({ source: 'public.categories', target: 'public.categories' });
  });

  it('records column references and sizes nodes by column count', () => {
    const graph = buildErGraph(shopModel(), 'public', null);
    const items = graph.nodes.find((n) => n.id === 'public.order_items')!;
    expect(items.data.references).toEqual({
      order_id: { schema: 'public', table: 'orders', column: 'id' },
      product_id: { schema: 'public', table: 'products', column: 'id' },
    });
    expect(items.data.primaryKey).toEqual(['id']);
    expect(items.height).toBe(nodeHeight(3));
  });

  describe('across schemas', () => {
    it('draws a referenced table of another schema as a compact external node with its edge', () => {
      const graph = buildErGraph(shopModel(), 'sales', null);
      expect(graph.total).toBe(1);
      expect(graph.nodes.map((n) => [n.id, n.data.external])).toEqual([
        ['sales.invoices', false],
        ['public.orders', true],
      ]);
      expect(graph.nodes[0]!.data.references.order_id).toEqual({ schema: 'public', table: 'orders', column: 'id' });
      // Only the referenced key column, sized to match.
      const orders = graph.nodes[1]!;
      expect(orders.ref).toEqual({ schema: 'public', name: 'orders' });
      expect(orders.data.table.columns.map((c) => c.name)).toEqual(['id']);
      expect(orders.data.primaryKey).toEqual(['id']);
      expect(orders.height).toBe(nodeHeight(1));
      expect(graph.edges).toEqual([
        expect.objectContaining({
          id: 'sales.invoices.invoices_order_id_fkey',
          source: 'public.orders',
          sourceHandle: outHandle('id'),
          target: 'sales.invoices',
          targetHandle: inHandle('order_id'),
        }),
      ]);
      expect(graph.external).toEqual([]);
    });

    it('draws a referencing table of another schema with its referencing columns only', () => {
      const graph = buildErGraph(shopModel(), 'public', null);
      const invoices = graph.nodes.find((n) => n.id === 'sales.invoices')!;
      expect(invoices.data.external).toBe(true);
      expect(invoices.data.table.columns.map((c) => c.name)).toEqual(['order_id']);
      expect(invoices.data.references).toEqual({ order_id: { schema: 'public', table: 'orders', column: 'id' } });
      expect(graph.edges.find((e) => e.target === 'sales.invoices')).toMatchObject({
        source: 'public.orders',
        targetHandle: inHandle('order_id'),
      });
    });

    it('makes one external node per table, with the key columns of every edge in table order', () => {
      const base = shopModel();
      const model: SchemaModel = {
        ...base,
        tables: [
          ...base.tables,
          table('audit', [col('id'), col('order_ref', 'bigint'), col('note', 'text'), col('customer_ref', 'uuid')], {
            schema: 'ops',
          }),
        ],
        foreignKeys: [
          ...base.foreignKeys,
          fk('audit', 'customer_ref', 'customers', 'id', { schema: 'ops' }),
          fk('audit', 'order_ref', 'orders', 'id', { schema: 'ops' }),
        ],
      };
      const graph = buildErGraph(model, 'public', null);
      const audit = graph.nodes.find((n) => n.id === 'ops.audit')!;
      expect(audit.data.table.columns.map((c) => c.name)).toEqual(['order_ref', 'customer_ref']);
      expect(graph.nodes.filter((n) => n.data.external).map((n) => n.id)).toEqual(['ops.audit', 'sales.invoices']);
      expect(graph.edges.filter((e) => e.target === 'ops.audit')).toHaveLength(2);
    });

    it('draws external neighbours of the selected table only, above the threshold', () => {
      const graph = buildErGraph(shopModel(), 'public', { schema: 'public', name: 'customers' }, 3);
      expect(graph.nodes.map((n) => n.id)).toEqual(['public.customers', 'public.orders']);
      const viaOrders = buildErGraph(shopModel(), 'public', { schema: 'public', name: 'orders' }, 3);
      expect(viaOrders.nodes.filter((n) => n.data.external).map((n) => n.id)).toEqual(['sales.invoices']);
    });

    it('keeps a key to a table missing from the model in `external`, undrawn', () => {
      const base = shopModel();
      const model: SchemaModel = {
        ...base,
        foreignKeys: [...base.foreignKeys, fk('orders', 'customer_id', 'ghosts', 'id', { refSchema: 'gone' })],
      };
      const graph = buildErGraph(model, 'public', null);
      expect(graph.external.map((f) => f.refTable)).toEqual(['ghosts']);
      expect(graph.nodes.some((n) => n.id === 'gone.ghosts')).toBe(false);
      expect(graph.edges.some((e) => e.source === 'gone.ghosts')).toBe(false);
    });

    it('lays out external nodes with the rest', { timeout: 20_000 }, async () => {
      const graph = buildErGraph(shopModel(), 'sales', null);
      const positions = await layoutWithElk(graph);
      expect(Object.keys(positions).sort()).toEqual(['public.orders', 'sales.invoices']);
      expect(positions['public.orders']!.x).toBeLessThan(positions['sales.invoices']!.x);
    });
  });

  describe('above the threshold', () => {
    function bigModel(): SchemaModel {
      const base = shopModel();
      const extra = Array.from({ length: 200 }, (_, i) => table(`t${String(i).padStart(3, '0')}`, [col('id')]));
      return {
        ...base,
        tables: [...base.tables, ...extra],
        foreignKeys: [...base.foreignKeys, fk('t000', 'id', 'orders')],
      };
    }

    it('draws nothing until a table is selected', () => {
      const graph = buildErGraph(bigModel(), 'public', null);
      expect(graph.limited).toBe(true);
      expect(graph.total).toBe(205);
      expect(graph.nodes).toEqual([]);
      expect(graph.edges).toEqual([]);
    });

    it('draws only the selected table and its neighbours, both directions', () => {
      const graph = buildErGraph(bigModel(), 'public', { schema: 'public', name: 'orders' });
      expect(graph.nodes.map((n) => n.id).sort()).toEqual([
        'public.customers',
        'public.order_items',
        'public.orders',
        'public.t000',
        // sales.invoices references orders: an external neighbour.
        'sales.invoices',
      ]);
      // Only edges between drawn tables; order_items -> products is left out.
      expect(graph.edges.map((e) => e.fk.name).sort()).toEqual([
        'invoices_order_id_fkey',
        'order_items_order_id_fkey',
        'orders_customer_id_fkey',
        't000_id_fkey',
      ]);
    });

    it('honours a custom threshold', () => {
      const graph = buildErGraph(shopModel(), 'public', { schema: 'public', name: 'categories' }, 3);
      expect(graph.limited).toBe(true);
      expect(graph.nodes.map((n) => n.id)).toEqual(['public.categories', 'public.products']);
    });
  });
});

describe('shortType', () => {
  it('uses the compact Postgres names', () => {
    expect(shortType('bigint')).toBe('int8');
    expect(shortType('integer')).toBe('int4');
    expect(shortType('boolean')).toBe('bool');
    expect(shortType('timestamp with time zone')).toBe('timestamptz');
    expect(shortType('timestamp(3) without time zone')).toBe('timestamp(3)');
    expect(shortType('character varying(64)')).toBe('varchar(64)');
    expect(shortType('character(2)')).toBe('char(2)');
    expect(shortType('text[]')).toBe('text[]');
    expect(shortType('integer[][]')).toBe('int4[][]');
    expect(shortType('numeric(12,2)')).toBe('numeric(12,2)');
    expect(shortType('order_status')).toBe('order_status');
  });

  it('marks nullable columns with a question mark', () => {
    expect(columnTypeLabel(col('tags', 'text[]', { nullable: true }))).toBe('text[]?');
    expect(columnTypeLabel(col('id', 'bigint'))).toBe('int8');
  });
});

// elk runs cold in jsdom and can take seconds when the machine is busy.
describe('layoutWithElk', { timeout: 20_000 }, () => {
  it('places every node, parents left of children, without overlaps', async () => {
    const graph = buildErGraph(shopModel(), 'public', null);
    const positions = await layoutWithElk(graph);
    expect(Object.keys(positions).sort()).toEqual(graph.nodes.map((n) => n.id).sort());
    expect(positions['public.customers']!.x).toBeLessThan(positions['public.orders']!.x);
    expect(positions['public.orders']!.x).toBeLessThan(positions['public.order_items']!.x);
    const boxes = graph.nodes.map((n) => ({ ...positions[n.id]!, w: n.width, h: n.height }));
    for (const a of boxes) {
      for (const b of boxes) {
        if (a === b) continue;
        const overlap = a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
        expect(overlap).toBe(false);
      }
    }
  });

  it('places only new tables, below the pinned ones', async () => {
    const graph = buildErGraph(shopModel(), 'public', null);
    const known = { 'public.customers': { x: 500, y: 40 }, 'public.orders': { x: 900, y: 300 } };
    const placed = await placeMissing(graph, known);
    expect(Object.keys(placed).sort()).toEqual([
      'public.categories',
      'public.order_items',
      'public.products',
      'sales.invoices',
    ]);
    const ordersBottom = 300 + graph.nodes.find((n) => n.id === 'public.orders')!.height;
    for (const p of Object.values(placed)) {
      expect(p.y).toBeGreaterThan(ordersBottom);
      expect(p.x).toBeGreaterThanOrEqual(500);
    }
    expect(await placeMissing(graph, { ...known, ...placed })).toEqual({});
  });
});
