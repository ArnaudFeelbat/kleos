import { tableKey, type Column, type ForeignKey, type SchemaModel, type Table, type TableRef } from '@kleos/shared';

/** Above this many tables in a schema, only the selected table and its neighbours are drawn (spec). */
export const NEIGHBOUR_ONLY_THRESHOLD = 150;

/** Node geometry, shared by the node component and the elk layout so both agree on sizes. */
export const NODE_WIDTH = 220;
export const HEADER_HEIGHT = 36;
export const ROW_HEIGHT = 26;
export const BODY_PADDING = 8;

export function nodeHeight(columnCount: number): number {
  return HEADER_HEIGHT + BODY_PADDING + columnCount * ROW_HEIGHT;
}

/** Foreign key of a column, possibly to a table in another schema. */
export type ColumnRef = { schema: string; table: string; column: string };

export type TableNodeData = {
  table: Table;
  /** Column name -> what it references (first FK wins for a column in several FKs). */
  references: Record<string, ColumnRef>;
  primaryKey: string[];
};

export type ErNode = {
  id: string;
  ref: TableRef;
  data: TableNodeData;
  width: number;
  height: number;
};

export type ErEdge = {
  id: string;
  /** The referenced (parent) table; edges run parent -> child so elk puts parents on the left. */
  source: string;
  sourceHandle: string;
  /** The referencing (child) table. */
  target: string;
  targetHandle: string;
  label: string;
  fk: ForeignKey;
};

export type ErGraph = {
  nodes: ErNode[];
  edges: ErEdge[];
  /** Tables of the schema in total. */
  total: number;
  /** True when neighbour-only mode applies (the schema has more tables than the threshold). */
  limited: boolean;
  /** FKs from this schema's tables to tables of other schemas: kept on the column, not drawn. */
  external: ForeignKey[];
};

/** Handle ids: the right side of a column row is where references start, the left where they land. */
export const outHandle = (column: string) => `${column}:out`;
export const inHandle = (column: string) => `${column}:in`;

export function edgeId(fk: ForeignKey): string {
  return `${fk.schema}.${fk.table}.${fk.name}`;
}

function columnReferences(table: Table, fks: ForeignKey[]): Record<string, ColumnRef> {
  const refs: Record<string, ColumnRef> = {};
  for (const fk of fks) {
    if (fk.schema !== table.schema || fk.table !== table.name) continue;
    fk.columns.forEach((col, i) => {
      if (refs[col]) return;
      refs[col] = { schema: fk.refSchema, table: fk.refTable, column: fk.refColumns[i] ?? fk.refColumns[0] ?? '' };
    });
  }
  return refs;
}

/** Tables directly linked to `key` by a foreign key, either way, within `keys`. */
export function neighbours(key: string, fks: ForeignKey[]): Set<string> {
  const found = new Set<string>();
  for (const fk of fks) {
    const from = `${fk.schema}.${fk.table}`;
    const to = `${fk.refSchema}.${fk.refTable}`;
    if (from === key) found.add(to);
    if (to === key) found.add(from);
  }
  found.delete(key);
  return found;
}

/**
 * Nodes and edges of one schema's ER diagram. Edges join only tables of this schema; FKs to other
 * schemas are listed in `external` and shown on the column (icon + detail-panel link) instead.
 * Above `threshold` tables only `selected` and its neighbours are kept (none when nothing is selected).
 */
export function buildErGraph(
  model: SchemaModel,
  schema: string,
  selected: TableRef | null,
  threshold = NEIGHBOUR_ONLY_THRESHOLD,
): ErGraph {
  const tables = model.tables.filter((t) => t.schema === schema).sort((a, b) => a.name.localeCompare(b.name));
  const inSchema = new Set(tables.map((t) => tableKey(t)));
  const limited = tables.length > threshold;

  let keep = inSchema;
  if (limited) {
    keep = new Set();
    const selectedKey = selected ? tableKey(selected) : null;
    if (selectedKey && inSchema.has(selectedKey)) {
      keep.add(selectedKey);
      for (const n of neighbours(selectedKey, model.foreignKeys)) if (inSchema.has(n)) keep.add(n);
    }
  }

  const nodes: ErNode[] = tables
    .filter((t) => keep.has(tableKey(t)))
    .map((t) => ({
      id: tableKey(t),
      ref: { schema: t.schema, name: t.name },
      data: { table: t, references: columnReferences(t, model.foreignKeys), primaryKey: t.primaryKey },
      width: NODE_WIDTH,
      height: nodeHeight(t.columns.length),
    }));

  const edges: ErEdge[] = [];
  const external: ForeignKey[] = [];
  for (const fk of model.foreignKeys) {
    if (fk.schema !== schema) continue;
    const child = `${fk.schema}.${fk.table}`;
    const parent = `${fk.refSchema}.${fk.refTable}`;
    if (!inSchema.has(parent)) {
      if (inSchema.has(child)) external.push(fk);
      continue;
    }
    if (!keep.has(child) || !keep.has(parent)) continue;
    edges.push({
      id: edgeId(fk),
      source: parent,
      sourceHandle: outHandle(fk.refColumns[0] ?? ''),
      target: child,
      targetHandle: inHandle(fk.columns[0] ?? ''),
      label: fk.columns.join(', '),
      fk,
    });
  }

  return { nodes, edges, total: tables.length, limited, external };
}

const typeAliases: [RegExp, string][] = [
  [/^bigint\b/, 'int8'],
  [/^integer\b/, 'int4'],
  [/^smallint\b/, 'int2'],
  [/^boolean\b/, 'bool'],
  [/^double precision\b/, 'float8'],
  [/^real\b/, 'float4'],
  [/^timestamp\((\d+)\) with time zone/, 'timestamptz($1)'],
  [/^timestamp with time zone/, 'timestamptz'],
  [/^timestamp\((\d+)\) without time zone/, 'timestamp($1)'],
  [/^timestamp without time zone/, 'timestamp'],
  [/^time\((\d+)\) with time zone/, 'timetz($1)'],
  [/^time with time zone/, 'timetz'],
  [/^time\((\d+)\) without time zone/, 'time($1)'],
  [/^time without time zone/, 'time'],
  [/^character varying/, 'varchar'],
  [/^character\b/, 'char'],
  [/^bit varying/, 'varbit'],
];

/** Compact type names as in the design: "bigint" -> "int8", "timestamp with time zone[]" -> "timestamptz[]". */
export function shortType(type: string): string {
  const arrays = /((\[\])+)$/.exec(type)?.[1] ?? '';
  let base = arrays ? type.slice(0, -arrays.length) : type;
  for (const [pattern, replacement] of typeAliases) {
    if (pattern.test(base)) {
      base = base.replace(pattern, replacement);
      break;
    }
  }
  return base + arrays;
}

/** Type label in a node row: "text[]?" for a nullable column. */
export function columnTypeLabel(column: Column): string {
  return shortType(column.type) + (column.nullable ? '?' : '');
}
