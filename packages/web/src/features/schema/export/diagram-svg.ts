import { getSmoothStepPath, Position } from '@xyflow/react';
import {
  BODY_PADDING,
  HEADER_HEIGHT,
  ROW_HEIGHT,
  columnTypeLabel,
  inHandle,
  outHandle,
  type ErGraph,
  type ErNode,
} from '../er-model';
import type { XY } from '../layout';
import type { DiagramTheme } from './diagram-theme';

/** Space around the drawing's bounding box. */
export const EXPORT_MARGIN = 40;
/** Column handles are 6px squares centred on the node's side (er-diagram.css); edges end on their outer side. */
const HANDLE_REACH = 3;
const RADIUS = 10;

/** System stacks: no embedded fonts, the file stays small and opens anywhere. */
const SANS = "-apple-system, BlinkMacSystemFont, 'Segoe UI', 'Helvetica Neue', Helvetica, Arial, sans-serif";
const MONO = "ui-monospace, 'SF Mono', SFMono-Regular, Menlo, Consolas, 'Liberation Mono', monospace";

/** Lucide's paths (24×24, 2px stroke) for the glyphs the diagram shows. */
const ICONS = {
  table: '<path d="M3 9h18"/><path d="M9 3v18"/><rect x="3" y="3" width="18" height="18" rx="2"/>',
  external:
    '<path d="M15 3h6v6"/><path d="M10 14 21 3"/><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/>',
  primaryKey:
    '<path d="M2.586 17.414A2 2 0 0 0 2 18.828V21a1 1 0 0 0 1 1h3a1 1 0 0 0 1-1v-1a1 1 0 0 1 1-1h1a1 1 0 0 0 1-1v-1a1 1 0 0 1 1-1h.172a2 2 0 0 0 1.414-.586l.814-.814a6.5 6.5 0 1 0-4-4z"/><circle cx="16.5" cy="7.5" r=".5"/>',
  foreignKey: '<path d="M7 7h10v10"/><path d="M7 17 17 7"/>',
};

export type DiagramSvgInput = {
  graph: Pick<ErGraph, 'nodes' | 'edges'>;
  /** Top-left corner of each node, as drawn. Nodes without one are left out, with their edges. */
  positions: Record<string, XY>;
  theme: DiagramTheme;
  /** Document title, e.g. "public — ER diagram". */
  title: string;
};

export type DiagramSvg = { svg: string; width: number; height: number };

// XML 1.0 refuses these even escaped; identifiers can technically hold them.
// eslint-disable-next-line no-control-regex
const invalidXmlChars = /[\u0000-\u0008\u000B\u000C\u000E-\u001F￾￿]/g;

/** Text or attribute value, escaped for XML. */
export function xmlEscape(text: string): string {
  return text
    .replace(invalidXmlChars, '�')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

/**
 * Rough advance width of `text` in the system sans-serif, enough to shorten long names before
 * they overflow a node (no DOM measuring, so the builder stays pure and testable).
 */
function sansWidth(text: string, size: number, bold = false): number {
  let em = 0;
  for (const ch of text) {
    if (/[iljtfr.,:;'|!()[\]\s]/.test(ch)) em += 0.3;
    else if (/[mwMW@]/.test(ch)) em += 0.85;
    else if (/[A-Z]/.test(ch)) em += 0.68;
    else em += 0.55;
  }
  return em * size * (bold ? 1.06 : 1);
}

const monoWidth = (text: string, size: number) => [...text].length * 0.6 * size;

/** Cuts `text` with an ellipsis so that `measure` fits `max`. */
function fit(text: string, max: number, measure: (t: string) => number): string {
  if (measure(text) <= max) return text;
  const chars = [...text];
  while (chars.length > 1 && measure(chars.join('') + '…') > max) chars.pop();
  return chars.join('') + '…';
}

const n = (v: number) => String(Math.round(v * 100) / 100);

function icon(kind: keyof typeof ICONS, x: number, y: number, size: number, color: string): string {
  return (
    `<g transform="translate(${n(x)} ${n(y)}) scale(${n(size / 24)})" fill="none" stroke="${color}" ` +
    `stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${ICONS[kind]}</g>`
  );
}

/** Centre line of column `index`'s row: header, half the body padding, then rows. */
function rowCenter(top: number, index: number): number {
  return top + HEADER_HEIGHT + BODY_PADDING / 2 + index * ROW_HEIGHT + ROW_HEIGHT / 2;
}

function handlePoint(node: ErNode, at: XY, handle: string): XY | null {
  const index = node.data.table.columns.findIndex((c) => handle === outHandle(c.name) || handle === inHandle(c.name));
  if (index < 0) return null;
  const right = handle.endsWith(':out');
  return { x: right ? at.x + node.width + HANDLE_REACH : at.x - HANDLE_REACH, y: rowCenter(at.y, index) };
}

type Box = { minX: number; minY: number; maxX: number; maxY: number };

function grow(box: Box, x: number, y: number): void {
  box.minX = Math.min(box.minX, x);
  box.minY = Math.min(box.minY, y);
  box.maxX = Math.max(box.maxX, x);
  box.maxY = Math.max(box.maxY, y);
}

function drawTable(node: ErNode, at: XY, theme: DiagramTheme): string {
  const { x, y } = at;
  const { width: w, height: h } = node;
  const { table, primaryKey, references, external } = node.data;
  const parts: string[] = [];
  const headerPath =
    `M${n(x)} ${n(y + HEADER_HEIGHT)}V${n(y + RADIUS)}A${RADIUS} ${RADIUS} 0 0 1 ${n(x + RADIUS)} ${n(y)}` +
    `H${n(x + w - RADIUS)}A${RADIUS} ${RADIUS} 0 0 1 ${n(x + w)} ${n(y + RADIUS)}V${n(y + HEADER_HEIGHT)}Z`;
  const ruleY = y + HEADER_HEIGHT - 0.5;
  const titleY = y + HEADER_HEIGHT / 2 + 13 * 0.35;

  if (external) {
    parts.push(
      `<rect x="${n(x)}" y="${n(y)}" width="${n(w)}" height="${n(h)}" rx="${RADIUS}" fill="${theme.externalCard}"/>`,
    );
    parts.push(
      `<line x1="${n(x)}" y1="${n(ruleY)}" x2="${n(x + w)}" y2="${n(ruleY)}" stroke="${theme.headerRule}" stroke-dasharray="3 2"/>`,
    );
    parts.push(icon('external', x + 10, y + (HEADER_HEIGHT - 14) / 2, 14, theme.mutedText));
    const schemaPart = `${table.schema}.`;
    const room = w - 30 - 10;
    const name = fit(table.name, room - sansWidth(schemaPart, 13), (t) => sansWidth(t, 13, true));
    parts.push(
      `<text x="${n(x + 30)}" y="${n(titleY)}" font-size="13" fill="${theme.mutedText}">` +
        `${xmlEscape(schemaPart)}<tspan font-weight="500" fill="${theme.externalName}">${xmlEscape(name)}</tspan></text>`,
    );
  } else {
    parts.push(`<rect x="${n(x)}" y="${n(y)}" width="${n(w)}" height="${n(h)}" rx="${RADIUS}" fill="${theme.card}"/>`);
    parts.push(`<path d="${headerPath}" fill="${theme.header}"/>`);
    parts.push(`<line x1="${n(x)}" y1="${n(ruleY)}" x2="${n(x + w)}" y2="${n(ruleY)}" stroke="${theme.headerRule}"/>`);
    parts.push(icon('table', x + 10, y + (HEADER_HEIGHT - 14) / 2, 14, theme.mutedText));
    const count = String(table.columns.length);
    const countWidth = monoWidth(count, 10.5);
    const name = fit(table.name, w - 30 - 10 - countWidth - 6, (t) => sansWidth(t, 13, true));
    parts.push(
      `<text x="${n(x + 30)}" y="${n(titleY)}" font-size="13" font-weight="600" fill="${theme.text}">${xmlEscape(name)}</text>`,
    );
    parts.push(
      `<text x="${n(x + w - 10)}" y="${n(titleY)}" font-family="${MONO}" font-size="10.5" text-anchor="end" fill="${theme.mutedText}">${count}</text>`,
    );
  }

  table.columns.forEach((column, i) => {
    const cy = rowCenter(y, i);
    const isPk = primaryKey.includes(column.name);
    const ref = references[column.name];
    if (isPk) parts.push(icon('primaryKey', x + 10, cy - 6, 12, theme.primaryKey));
    else if (ref) parts.push(icon('foreignKey', x + 10, cy - 6, 12, theme.foreignKey));
    // The type keeps at most 45% of the row, as on screen; the name gets what is left.
    const type = fit(columnTypeLabel(column), (w - 20) * 0.45, (t) => monoWidth(t, 11));
    const nameRoom = w - 10 - monoWidth(type, 11) - 8 - 28;
    const name = fit(column.name, nameRoom, (t) => sansWidth(t, 12, isPk));
    const nameColor = external ? theme.mutedText : isPk ? theme.text : theme.columnText;
    parts.push(
      `<text x="${n(x + 28)}" y="${n(cy + 12 * 0.35)}" font-size="12"${isPk ? ' font-weight="600"' : ''} fill="${nameColor}">${xmlEscape(name)}</text>`,
    );
    parts.push(
      `<text x="${n(x + w - 10)}" y="${n(cy + 11 * 0.35)}" font-family="${MONO}" font-size="11" text-anchor="end" fill="${theme.mutedText}">${xmlEscape(type)}</text>`,
    );
  });

  // Outline last, over the header's corners: a 1px ring outside the card, or a dashed one inside.
  parts.push(
    external
      ? `<rect x="${n(x + 0.5)}" y="${n(y + 0.5)}" width="${n(w - 1)}" height="${n(h - 1)}" rx="${RADIUS - 0.5}" fill="none" stroke="${theme.externalBorder}" stroke-dasharray="4 3"/>`
      : `<rect x="${n(x - 0.5)}" y="${n(y - 0.5)}" width="${n(w + 1)}" height="${n(h + 1)}" rx="${RADIUS + 0.5}" fill="none" stroke="${theme.cardBorder}"/>`,
  );
  return parts.join('');
}

/** Layer name for design tools: letters, digits, `_ . -` only, unique. */
function layerId(prefix: string, name: string, used: Set<string>): string {
  const base = `${prefix}-${name.replace(/[^A-Za-z0-9_.-]/g, '_')}`;
  let id = base;
  for (let i = 2; used.has(id); i++) id = `${base}-${i}`;
  used.add(id);
  return id;
}

/**
 * A standalone SVG of the diagram as drawn: tables with their header and columns (name, type,
 * key glyph), external tables muted with a dashed outline, and the edges along the same
 * smooth-step routes React Flow draws, arrowhead on the referenced table, label at mid-route.
 * Solid background, no external references, system fonts: it opens in browsers and design tools.
 */
export function buildDiagramSvg({ graph, positions, theme, title }: DiagramSvgInput): DiagramSvg {
  const nodes = graph.nodes.filter((node) => positions[node.id]);
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const box: Box = { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity };
  const used = new Set<string>();

  const edgeParts: string[] = [];
  const labelParts: string[] = [];
  for (const edge of graph.edges) {
    const source = byId.get(edge.source);
    const target = byId.get(edge.target);
    if (!source || !target) continue;
    const from = handlePoint(source, positions[source.id]!, edge.sourceHandle);
    const to = handlePoint(target, positions[target.id]!, edge.targetHandle);
    if (!from || !to) continue;
    const [path, labelX, labelY] = getSmoothStepPath({
      sourceX: from.x,
      sourceY: from.y,
      sourcePosition: Position.Right,
      targetX: to.x,
      targetY: to.y,
      targetPosition: Position.Left,
    });
    const coords = path.match(/-?\d+(?:\.\d+)?(?:e-?\d+)?/gi)?.map(Number) ?? [];
    for (let i = 0; i + 1 < coords.length; i += 2) grow(box, coords[i]!, coords[i + 1]!);
    // markerStart of the diagram: a closed arrow pointing into the referenced table's handle.
    const head = `${n(from.x)},${n(from.y)} ${n(from.x + 5.25)},${n(from.y - 4.2)} ${n(from.x + 5.25)},${n(from.y + 4.2)}`;
    edgeParts.push(
      `<g id="${layerId('fk', edge.fk.name, used)}"><path d="${path}"/>` +
        `<polygon points="${head}" fill="${theme.edge}" stroke-width="1" stroke-linejoin="round"/></g>`,
    );
    if (edge.label) {
      const width = monoWidth(edge.label, 10.5) + 12;
      const height = 19;
      const left = labelX - width / 2;
      const top = labelY - height / 2;
      grow(box, left, top);
      grow(box, left + width, top + height);
      labelParts.push(
        `<rect x="${n(left)}" y="${n(top)}" width="${n(width)}" height="${height}" rx="6" fill="${theme.labelFill}" stroke="${theme.labelBorder}"/>` +
          `<text x="${n(labelX)}" y="${n(labelY + 10.5 * 0.35)}" text-anchor="middle">${xmlEscape(edge.label)}</text>`,
      );
    }
  }

  const tableParts: string[] = [];
  for (const node of nodes) {
    const at = positions[node.id]!;
    grow(box, at.x - 1, at.y - 1);
    grow(box, at.x + node.width + 1, at.y + node.height + 1);
    tableParts.push(`<g id="${layerId('table', node.id, used)}">${drawTable(node, at, theme)}</g>`);
  }

  if (box.minX === Infinity) Object.assign(box, { minX: 0, minY: 0, maxX: 0, maxY: 0 });
  const minX = Math.floor(box.minX - EXPORT_MARGIN);
  const minY = Math.floor(box.minY - EXPORT_MARGIN);
  const width = Math.ceil(box.maxX + EXPORT_MARGIN) - minX;
  const height = Math.ceil(box.maxY + EXPORT_MARGIN) - minY;

  const svg = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    `<svg xmlns="http://www.w3.org/2000/svg" version="1.1" width="${width}" height="${height}" viewBox="${minX} ${minY} ${width} ${height}" font-family="${SANS}">`,
    `<title>${xmlEscape(title)}</title>`,
    `<rect id="background" x="${minX}" y="${minY}" width="${width}" height="${height}" fill="${theme.background}"/>`,
    `<g id="edges" fill="none" stroke="${theme.edge}" stroke-width="1.5">${edgeParts.join('')}</g>`,
    `<g id="edge-labels" font-family="${MONO}" font-size="10.5" font-weight="500" fill="${theme.mutedText}">${labelParts.join('')}</g>`,
    `<g id="tables">${tableParts.join('')}</g>`,
    '</svg>',
    '',
  ].join('\n');
  return { svg, width, height };
}
