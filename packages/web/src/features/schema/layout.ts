import ELK from 'elkjs/lib/elk.bundled.js';

export type XY = { x: number; y: number };
export type LayoutInput = {
  nodes: { id: string; width: number; height: number }[];
  edges: { id: string; source: string; target: string }[];
};

let elk: InstanceType<typeof ELK> | null = null;

/**
 * Layered left-to-right layout from elkjs. Edges run parent -> child, so referenced tables sit on
 * the left. Unlinked tables are packed as separate components. Returns top-left positions by id.
 */
export async function layoutWithElk({ nodes, edges }: LayoutInput): Promise<Record<string, XY>> {
  if (nodes.length === 0) return {};
  elk ??= new ELK();
  const ids = new Set(nodes.map((n) => n.id));
  const result = await elk.layout({
    id: 'root',
    layoutOptions: {
      'elk.algorithm': 'layered',
      'elk.direction': 'RIGHT',
      'elk.layered.spacing.nodeNodeBetweenLayers': '90',
      'elk.spacing.nodeNode': '40',
      'elk.spacing.componentComponent': '60',
      'elk.separateConnectedComponents': 'true',
      'elk.aspectRatio': '1.6',
      'elk.layered.nodePlacement.strategy': 'BRANDES_KOEPF',
    },
    children: nodes.map((n) => ({ id: n.id, width: n.width, height: n.height })),
    // Self-references don't affect placement; elk also rejects edges to unknown nodes.
    edges: edges
      .filter((e) => e.source !== e.target && ids.has(e.source) && ids.has(e.target))
      .map((e) => ({ id: e.id, sources: [e.source], targets: [e.target] })),
  });
  const positions: Record<string, XY> = {};
  for (const child of result.children ?? []) {
    positions[child.id] = { x: Math.round(child.x ?? 0), y: Math.round(child.y ?? 0) };
  }
  return positions;
}

/**
 * Positions for the nodes that have none yet. With no position at all, the whole graph is laid
 * out by elk; otherwise only the missing nodes are, and the block is placed below the existing
 * ones so tables added since the last save never land on top of pinned ones.
 */
export async function placeMissing(input: LayoutInput, known: Record<string, XY>): Promise<Record<string, XY>> {
  const missing = input.nodes.filter((n) => !known[n.id]);
  if (missing.length === 0) return {};
  const placed = input.nodes.filter((n) => known[n.id]);
  if (placed.length === 0) return layoutWithElk(input);
  const ids = new Set(missing.map((n) => n.id));
  const sub = await layoutWithElk({
    nodes: missing,
    edges: input.edges.filter((e) => ids.has(e.source) && ids.has(e.target)),
  });
  const minX = Math.min(...placed.map((n) => known[n.id]!.x));
  const bottom = Math.max(...placed.map((n) => known[n.id]!.y + n.height));
  const offset = { x: minX, y: bottom + 80 };
  const result: Record<string, XY> = {};
  for (const [id, p] of Object.entries(sub)) result[id] = { x: p.x + offset.x, y: p.y + offset.y };
  return result;
}
