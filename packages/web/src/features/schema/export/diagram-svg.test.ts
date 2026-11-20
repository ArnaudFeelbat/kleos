import type { SchemaModel } from '@kleos/shared';
import { describe, expect, it } from 'vitest';
import { buildErGraph, type ErGraph } from '../er-model';
import type { XY } from '../layout';
import { col, fk, shopModel, table } from '../test-fixtures';
import { buildDiagramSvg, EXPORT_MARGIN, xmlEscape } from './diagram-svg';
import { diagramTheme } from './diagram-theme';

const SVG_NS = 'http://www.w3.org/2000/svg';

/** Positions on a grid, one column per node, as a stand-in for a saved layout. */
function grid(graph: ErGraph): Record<string, XY> {
  return Object.fromEntries(graph.nodes.map((node, i) => [node.id, { x: (i % 3) * 320, y: Math.floor(i / 3) * 260 }]));
}

function parse(svg: string): Document {
  const doc = new DOMParser().parseFromString(svg, 'image/svg+xml');
  expect(doc.getElementsByTagName('parsererror')).toHaveLength(0);
  return doc;
}

const layerIds = (doc: Document, group: string) =>
  [...doc.getElementById(group)!.children].map((g) => g.getAttribute('id'));

describe('buildDiagramSvg', () => {
  it('is a well-formed standalone SVG with every table and edge of the diagram', () => {
    const graph = buildErGraph(shopModel(), 'public', null);
    const { svg, width, height } = buildDiagramSvg({
      graph,
      positions: grid(graph),
      theme: diagramTheme(false),
      title: 'public — ER diagram',
    });
    expect(svg.startsWith('<?xml version="1.0" encoding="UTF-8"?>\n<svg xmlns="http://www.w3.org/2000/svg"')).toBe(
      true,
    );
    const doc = parse(svg);
    const root = doc.documentElement;
    expect(root.namespaceURI).toBe(SVG_NS);
    expect(root.getAttribute('width')).toBe(String(width));
    expect(root.getAttribute('height')).toBe(String(height));
    expect(root.getAttribute('viewBox')!.split(' ').slice(2)).toEqual([String(width), String(height)]);
    expect(doc.querySelector('title')!.textContent).toBe('public — ER diagram');
    // Nothing that would need a network or a file next to it.
    expect(svg).not.toMatch(/href|url\(|<image|<foreignObject|@import/);

    expect(layerIds(doc, 'tables')).toEqual([
      'table-public.categories',
      'table-public.customers',
      'table-public.order_items',
      'table-public.orders',
      'table-public.products',
      'table-sales.invoices',
    ]);
    expect(layerIds(doc, 'edges').sort()).toEqual([
      'fk-categories_parent_id_fkey',
      'fk-invoices_order_id_fkey',
      'fk-order_items_order_id_fkey',
      'fk-order_items_product_id_fkey',
      'fk-orders_customer_id_fkey',
      'fk-products_category_id_fkey',
    ]);
    // Each edge is a path plus its arrowhead; each label a pill with the referencing columns.
    for (const g of doc.getElementById('edges')!.children) {
      expect(g.querySelector('path')!.getAttribute('d')).toMatch(/^M-?[\d.]+ -?[\d.]+/);
      expect(g.querySelector('polygon')).not.toBeNull();
    }
    const labels = [...doc.getElementById('edge-labels')!.querySelectorAll('text')].map((t) => t.textContent);
    expect(labels.sort()).toEqual(['category_id', 'customer_id', 'order_id', 'order_id', 'parent_id', 'product_id']);

    const orders = doc.getElementById('table-public.orders')!;
    const texts = [...orders.querySelectorAll('text')].map((t) => t.textContent);
    expect(texts).toEqual(['orders', '3', 'id', 'int8', 'customer_id', 'uuid', 'metadata', 'jsonb?']);
  });

  it('starts each edge on the referenced row and ends it on the referencing one', () => {
    const graph = buildErGraph(shopModel(), 'public', null);
    const positions = { ...grid(graph), 'public.customers': { x: 0, y: 0 }, 'public.orders': { x: 400, y: 100 } };
    const doc = parse(buildDiagramSvg({ graph, positions, theme: diagramTheme(false), title: 't' }).svg);
    const d = doc.querySelector('#fk-orders_customer_id_fkey path')!.getAttribute('d')!;
    // customers.id is row 0: 36 header + 4 padding + 13 half row; the handle reaches 3px out of the 220px node.
    expect(d.startsWith('M223 53')).toBe(true);
    // orders.customer_id is row 1 of orders, 3px left of its side.
    expect(d.endsWith('L397 179')).toBe(true);
  });

  it('frames the drawing with the margin and a solid background in the theme colours', () => {
    const graph = buildErGraph(shopModel(), 'sales', null);
    const positions = { 'sales.invoices': { x: 400, y: 0 }, 'public.orders': { x: 0, y: 0 } };
    const dark = diagramTheme(true);
    const { svg } = buildDiagramSvg({ graph, positions, theme: dark, title: 't' });
    const doc = parse(svg);
    const [minX, minY] = doc.documentElement.getAttribute('viewBox')!.split(' ').map(Number);
    expect(minX).toBe(-1 - EXPORT_MARGIN);
    expect(minY).toBe(-1 - EXPORT_MARGIN);
    const background = doc.getElementById('background')!;
    expect(background.getAttribute('fill')).toBe(dark.background);
    expect(background.getAttribute('width')).toBe(doc.documentElement.getAttribute('width'));
    expect(svg).toContain(dark.card);
  });

  it('draws external tables schema-qualified, with their key columns, muted and dashed', () => {
    const graph = buildErGraph(shopModel(), 'sales', null);
    const theme = diagramTheme(false);
    const positions = { 'sales.invoices': { x: 400, y: 0 }, 'public.orders': { x: 0, y: 0 } };
    const doc = parse(buildDiagramSvg({ graph, positions, theme, title: 't' }).svg);
    const external = doc.getElementById('table-public.orders')!;
    expect([...external.querySelectorAll('text')].map((t) => t.textContent)).toEqual(['public.orders', 'id', 'int8']);
    const rects = [...external.querySelectorAll('rect')];
    expect(rects[0]!.getAttribute('fill')).toBe(theme.externalCard);
    expect(rects.at(-1)!.getAttribute('stroke-dasharray')).toBe('4 3');
    // The schema's own table is solid.
    const invoices = doc.getElementById('table-sales.invoices')!;
    expect(invoices.querySelector('rect[stroke-dasharray]')).toBeNull();
    expect(doc.querySelectorAll('#edges > g')).toHaveLength(1);
  });

  it('escapes names and keeps them readable', () => {
    const name = 'a&b<c>';
    const model: SchemaModel = {
      ...shopModel(),
      schemas: ['odd'],
      tables: [
        table(name, [col('id'), col(`x"y'z`, 'text')], { schema: 'odd' }),
        table('kids', [col('id'), col('parent', 'integer')], { schema: 'odd' }),
      ],
      foreignKeys: [fk('kids', 'parent', name, 'id', { schema: 'odd', refSchema: 'odd', name: 'k&<"fk">' })],
    };
    const graph = buildErGraph(model, 'odd', null);
    const { svg } = buildDiagramSvg({
      graph,
      positions: grid(graph),
      theme: diagramTheme(false),
      title: `odd & <more>`,
    });
    expect(svg).toContain('a&amp;b&lt;c&gt;');
    expect(svg).toContain('x&quot;y&apos;z');
    expect(svg).not.toContain(name);
    const doc = parse(svg);
    expect(doc.querySelector('title')!.textContent).toBe('odd & <more>');
    const texts = [...doc.querySelectorAll('text')].map((t) => t.textContent);
    expect(texts).toContain(name);
    expect(texts).toContain(`x"y'z`);
    // Layer ids stay plain for design tools.
    expect(layerIds(doc, 'tables')).toEqual(['table-odd.a_b_c_', 'table-odd.kids']);
    expect(layerIds(doc, 'edges')).toEqual(['fk-k___fk__']);
  });

  it('shortens names too long for a node with an ellipsis', () => {
    const long = 'a_really_long_table_name_that_never_fits_in_a_node';
    const model: SchemaModel = { ...shopModel(), tables: [table(long, [col('id')])], foreignKeys: [] };
    const graph = buildErGraph(model, 'public', null);
    const doc = parse(buildDiagramSvg({ graph, positions: grid(graph), theme: diagramTheme(false), title: 't' }).svg);
    const title = doc.querySelector('#tables text')!.textContent!;
    expect(title.endsWith('…')).toBe(true);
    expect(long.startsWith(title.slice(0, -1))).toBe(true);
  });

  it('leaves out nodes without a position and their edges', () => {
    const graph = buildErGraph(shopModel(), 'public', null);
    const positions = grid(graph);
    delete positions['public.orders'];
    const doc = parse(buildDiagramSvg({ graph, positions, theme: diagramTheme(false), title: 't' }).svg);
    expect(layerIds(doc, 'tables')).not.toContain('table-public.orders');
    expect(layerIds(doc, 'edges').sort()).toEqual([
      'fk-categories_parent_id_fkey',
      'fk-order_items_product_id_fkey',
      'fk-products_category_id_fkey',
    ]);
  });

  it('replaces characters XML cannot hold', () => {
    expect(xmlEscape('a\u0001b')).toBe('a�b');
  });
});

describe('diagramTheme', () => {
  it('reads hex and rgb() tokens and blends translucent ones onto what they sit on', () => {
    const theme = diagramTheme(false, {
      sidebar: '#f0f0f0',
      card: 'rgb(255 255 255)',
      'muted-foreground': 'rgba(0, 0, 0, 1)',
      edge: 'rgb(0 0 0 / 50%)',
    });
    expect(theme.background).toBe('#f0f0f0');
    expect(theme.card).toBe('#ffffff');
    expect(theme.mutedText).toBe('#000000');
    // 50% black over #f0f0f0.
    expect(theme.cardBorder).toBe('#787878');
    // Edges: muted foreground at 70% over the background.
    expect(theme.edge).toBe('#484848');
  });

  it('falls back to the app palette for missing or unreadable tokens, per appearance', () => {
    expect(diagramTheme(false, { card: 'nonsense' }).card).toBe('#ffffff');
    const dark = diagramTheme(true);
    expect(dark.dark).toBe(true);
    expect(dark.background).toBe('#0f0f12');
    expect(dark.card).toBe('#151518');
    expect(dark.primaryKey).toBe('#f59e0b');
  });
});
