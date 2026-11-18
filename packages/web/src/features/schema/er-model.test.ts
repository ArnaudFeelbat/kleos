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
    ]);
    expect(graph.limited).toBe(false);
    expect(graph.total).toBe(5);
    expect(graph.edges).toHaveLength(5);
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

  it('scopes to the picked schema and lists cross-schema keys as external', () => {
    const graph = buildErGraph(shopModel(), 'sales', null);
    expect(graph.nodes.map((n) => n.id)).toEqual(['sales.invoices']);
    expect(graph.edges).toEqual([]);
    expect(graph.external.map((f) => f.name)).toEqual(['invoices_order_id_fkey']);
    expect(graph.nodes[0]!.data.references.order_id).toEqual({ schema: 'public', table: 'orders', column: 'id' });
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
      ]);
      // Only edges between drawn tables; order_items -> products is left out.
      expect(graph.edges.map((e) => e.fk.name).sort()).toEqual([
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
    expect(Object.keys(placed).sort()).toEqual(['public.categories', 'public.order_items', 'public.products']);
    const ordersBottom = 300 + graph.nodes.find((n) => n.id === 'public.orders')!.height;
    for (const p of Object.values(placed)) {
      expect(p.y).toBeGreaterThan(ordersBottom);
      expect(p.x).toBeGreaterThanOrEqual(500);
    }
    expect(await placeMissing(graph, { ...known, ...placed })).toEqual({});
  });
});
