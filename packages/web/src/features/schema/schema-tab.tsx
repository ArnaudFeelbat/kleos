import '@xyflow/react/dist/style.css';
import './er-diagram.css';
import { tableKey, type SchemaModel, type TableRef } from '@kleos/shared';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  Background,
  BackgroundVariant,
  MarkerType,
  Panel,
  ReactFlow,
  ReactFlowProvider,
  useNodesInitialized,
  useReactFlow,
  type Edge,
  type NodeChangeset,
  type NodeTypes,
} from '@xyflow/react';
import { ArrowUpRight, KeyRound, LayoutGrid, Maximize, Minus, Plus, Search } from 'lucide-react';
import { useCallback, useEffect, useId, useMemo, useRef, useState, type ReactNode } from 'react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Skeleton } from '@/components/ui/skeleton';
import { useWorkspace } from '@/features/workspace/context';
import { findRelation, selectStarSql } from '@/features/workspace/sidebar-model';
import { TabToolbar } from '@/features/workspace/tab-toolbar';
import { api, errorText, queryKeys } from '@/lib/api';
import { formatInt } from '@/lib/format';
import { buildErGraph, NEIGHBOUR_ONLY_THRESHOLD, type ErGraph } from './er-model';
import { layoutWithElk, placeMissing, type XY } from './layout';
import { TableDetailPanel } from './table-detail-panel';
import { TableNode, type TableFlowNode } from './table-node';

const nodeTypes: NodeTypes = { table: TableNode };
const SAVE_DELAY_MS = 600;

/**
 * Schema tab: ER diagram of the current schema (React Flow + elkjs, positions saved per connection
 * and schema), a focus search, auto layout, and the detail panel of the selected table.
 */
export function SchemaTab() {
  const { schemaModel, currentSchema } = useWorkspace();
  if (!schemaModel) {
    return (
      <div className="flex flex-1 flex-col gap-3 p-6" aria-label="Loading schema">
        <Skeleton className="h-40 w-56" />
        <Skeleton className="h-28 w-56" />
      </div>
    );
  }
  return (
    <ReactFlowProvider key={currentSchema}>
      <ErDiagram model={schemaModel} schema={currentSchema} />
    </ReactFlowProvider>
  );
}

function ErDiagram({ model, schema }: { model: SchemaModel; schema: string }) {
  const ws = useWorkspace();
  const { connection, selectedTable, openTable, openInQuery, activeTab, visible } = ws;
  const queryClient = useQueryClient();
  const { fitView, zoomIn, zoomOut, setCenter, getInternalNode } = useReactFlow<TableFlowNode>();

  const selectedKey = selectedTable && selectedTable.schema === schema ? tableKey(selectedTable) : null;
  const tableCount = useMemo(() => model.tables.filter((t) => t.schema === schema).length, [model, schema]);
  const limited = tableCount > NEIGHBOUR_ONLY_THRESHOLD;
  // The selection only changes which tables are drawn in neighbour-only mode.
  const graphSelection = limited ? selectedTable : null;
  const graph = useMemo(() => buildErGraph(model, schema, graphSelection), [model, schema, graphSelection]);

  // --- Positions: saved layout, then elk for tables without one; drags and auto layout save. ---
  const layout = useQuery({
    queryKey: queryKeys.layout(connection.id, schema),
    queryFn: () => api.getLayout(connection.id, schema),
    staleTime: Infinity,
  });
  const [positions, setPositions] = useState<Record<string, XY> | null>(null);
  if (positions === null && !layout.isPending) {
    setPositions(layout.data?.positions ?? {});
  }

  const latest = useRef<Record<string, XY>>({});
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const flushSave = useCallback(() => {
    if (saveTimer.current) clearTimeout(saveTimer.current);
    saveTimer.current = null;
    const payload = { positions: latest.current };
    queryClient.setQueryData(queryKeys.layout(connection.id, schema), payload);
    api.saveLayout(connection.id, schema, payload).catch((err: unknown) => {
      toast.error('Could not save the diagram layout', { description: errorText(err) });
    });
  }, [connection.id, schema, queryClient]);
  const scheduleSave = useCallback(() => {
    if (saveTimer.current) clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(flushSave, SAVE_DELAY_MS);
  }, [flushSave]);
  useEffect(() => {
    latest.current = positions ?? {};
  }, [positions]);
  useEffect(
    () => () => {
      if (saveTimer.current) flushSave();
    },
    [flushSave],
  );

  const missing = positions ? graph.nodes.filter((n) => !positions[n.id]).map((n) => n.id) : [];
  const missingKey = missing.join('|');
  useEffect(() => {
    if (!positions || !missingKey) return;
    let cancelled = false;
    const firstLayout = Object.keys(positions).length === 0;
    placeMissing(graph, positions)
      .then((placed) => {
        if (cancelled) return;
        setPositions((p) => ({ ...placed, ...p }));
        if (firstLayout && !limited) {
          latest.current = { ...placed, ...latest.current };
          scheduleSave();
        }
      })
      .catch((err: unknown) => toast.error('Automatic layout failed', { description: errorText(err) }));
    return () => {
      cancelled = true;
    };
  }, [graph, positions, missingKey, limited, scheduleSave]);

  // --- React Flow nodes: rebuilt from graph + positions + selection, adjusted while rendering. ---
  const [nodes, setNodes] = useState<TableFlowNode[]>([]);
  const desired = useMemo(() => ({ graph, positions, selectedKey }), [graph, positions, selectedKey]);
  const [synced, setSynced] = useState<typeof desired | null>(null);
  if (synced !== desired) {
    setSynced(desired);
    setNodes((prev) => toFlowNodes(graph, positions ?? {}, selectedKey, prev));
  }
  const edges = useMemo(() => toFlowEdges(graph, selectedKey), [graph, selectedKey]);

  const onNodesChange = useCallback((changes: NodeChangeset<TableFlowNode>) => {
    setNodes((current) => changes.applyTo(current));
  }, []);

  // --- Focus: center a table found by the search box (and the selection in neighbour-only mode). ---
  const [focusRequest, setFocusRequest] = useState<{ id: string; n: number } | null>(null);
  const focusTable = useCallback(
    (ref: TableRef) => {
      openTable(ref);
      setFocusRequest((r) => ({ id: tableKey(ref), n: (r?.n ?? 0) + 1 }));
    },
    [openTable],
  );
  // In neighbour-only mode every selection redraws the diagram, so it is centered too.
  const centerOn = limited ? selectedKey : (focusRequest?.id ?? null);
  const centerKey = centerOn ? `${centerOn}#${focusRequest?.n ?? 0}` : null;
  useEffect(() => {
    if (!centerOn || !centerKey) return;
    let frame = 0;
    let tries = 0;
    const attempt = () => {
      const node = getInternalNode(centerOn);
      const width = node?.measured.width;
      const height = node?.measured.height;
      if (node && width && height) {
        const { x, y } = node.internals.positionAbsolute;
        void setCenter(x + width / 2, y + height / 2, { zoom: 1, duration: 300 });
      } else if (tries++ < 30) {
        frame = requestAnimationFrame(attempt);
      }
    };
    attempt();
    return () => cancelAnimationFrame(frame);
  }, [centerOn, centerKey, getInternalNode, setCenter]);

  // --- Detail panel: follows the selection; Escape or the close button hides it. ---
  const selectedRelation = selectedKey ? findRelation(model, selectedTable) : undefined;
  const [closedFor, setClosedFor] = useState<string | null>(null);
  const panelOpen = !!selectedRelation && closedFor !== selectedKey;
  useEffect(() => {
    if (!panelOpen || !visible || activeTab !== 'schema') return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !e.defaultPrevented) setClosedFor(selectedKey);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [panelOpen, visible, activeTab, selectedKey]);

  async function autoLayout() {
    try {
      const placed = await layoutWithElk(graph);
      setPositions((p) => ({ ...p, ...placed }));
      latest.current = { ...latest.current, ...placed };
      flushSave();
      requestAnimationFrame(() => void fitView({ padding: 0.15, duration: 300 }));
    } catch (err) {
      toast.error('Automatic layout failed', { description: errorText(err) });
    }
  }

  const empty = tableCount === 0;

  return (
    <div className="flex min-h-0 flex-1">
      <TabToolbar tab="schema">
        <FocusSearch model={model} schema={schema} onFocus={focusTable} />
        <Button variant="outline" size="sm" onClick={() => void autoLayout()} disabled={graph.nodes.length === 0}>
          <LayoutGrid aria-hidden="true" />
          Auto layout
        </Button>
      </TabToolbar>

      <section aria-label="ER diagram" className="kleos-er relative min-w-0 flex-1">
        <ReactFlow<TableFlowNode, Edge>
          nodes={nodes}
          edges={edges}
          nodeTypes={nodeTypes}
          onNodesChange={onNodesChange}
          onNodeClick={(_, node) => {
            setClosedFor(null);
            openTable(node.data.table);
          }}
          onNodeDoubleClick={(_, node) => openTable(node.data.table, 'data')}
          onNodeDragStop={(_, _node, dragged) => {
            const moved: Record<string, XY> = {};
            for (const n of dragged) moved[n.id] = { x: Math.round(n.position.x), y: Math.round(n.position.y) };
            setPositions((p) => ({ ...p, ...moved }));
            latest.current = { ...latest.current, ...moved };
            scheduleSave();
          }}
          elementsSelectable={false}
          nodesConnectable={false}
          edgesFocusable={false}
          deleteKeyCode={null}
          minZoom={0.1}
          maxZoom={2}
          proOptions={{ hideAttribution: true }}
        >
          <Background variant={BackgroundVariant.Dots} gap={18} size={1} />
          <FitOnFirstLayout />
          <Panel position="top-right">
            <Legend />
          </Panel>
          {limited && (
            <Panel position="top-center">
              <p className="bg-warning-bg border-warning-line text-foreground max-w-md rounded-lg border px-3 py-2 text-xs">
                {schema} has {formatInt(tableCount)} tables, so only the selected table and its neighbours are drawn.
                Pick a table in the sidebar or with “Focus a table”.
              </p>
            </Panel>
          )}
          <Panel position="bottom-left" className="flex items-end gap-3">
            <div className="bg-card flex flex-col overflow-hidden rounded-lg border">
              <ZoomButton label="Zoom in" onClick={() => void zoomIn({ duration: 200 })}>
                <Plus />
              </ZoomButton>
              <ZoomButton label="Zoom out" onClick={() => void zoomOut({ duration: 200 })}>
                <Minus />
              </ZoomButton>
              <ZoomButton label="Fit to view" onClick={() => void fitView({ padding: 0.15, duration: 300 })} last>
                <Maximize />
              </ZoomButton>
            </div>
            <p className="text-muted-foreground mb-0.5 text-[11px]">
              Drag a table to pin it · positions saved for {connection.nickname} / {schema}
              {graph.external.length > 0 &&
                ` · ${graph.external.length} foreign ${graph.external.length === 1 ? 'key' : 'keys'} to other schemas not drawn`}
            </p>
          </Panel>
        </ReactFlow>
        {(empty || (limited && graph.nodes.length === 0)) && (
          <div className="text-muted-foreground pointer-events-none absolute inset-0 flex items-center justify-center text-sm">
            {empty ? `No tables in ${schema}.` : 'Select a table to draw it and its neighbours.'}
          </div>
        )}
      </section>

      {panelOpen && selectedRelation && (
        <TableDetailPanel
          table={selectedRelation}
          foreignKeys={model.foreignKeys}
          onClose={() => setClosedFor(selectedKey)}
          onOpenTable={(ref) => {
            setClosedFor(null);
            if (ref.schema === schema) focusTable(ref);
            else openTable(ref);
          }}
          onViewData={() => openTable(selectedRelation, 'data')}
          onOpenInQuery={() => openInQuery(selectStarSql(selectedRelation))}
        />
      )}
    </div>
  );
}

/** Keeps measured sizes of nodes that persist; positions come from the working layout. */
function toFlowNodes(
  graph: ErGraph,
  positions: Record<string, XY>,
  selectedKey: string | null,
  previous: TableFlowNode[],
): TableFlowNode[] {
  const prevById = new Map(previous.map((n) => [n.id, n]));
  const result: TableFlowNode[] = [];
  for (const n of graph.nodes) {
    const position = positions[n.id];
    if (!position) continue;
    const prev = prevById.get(n.id);
    result.push({
      ...prev,
      id: n.id,
      type: 'table',
      position: prev?.dragging ? prev.position : position,
      data: { ...n.data, isSelected: n.id === selectedKey },
      ariaLabel: `Table ${n.ref.name}`,
      initialWidth: n.width,
      initialHeight: n.height,
    });
  }
  return result;
}

function toFlowEdges(graph: ErGraph, selectedKey: string | null): Edge[] {
  return graph.edges.map((e) => {
    const active = e.source === selectedKey || e.target === selectedKey;
    return {
      id: e.id,
      source: e.source,
      sourceHandle: e.sourceHandle,
      target: e.target,
      targetHandle: e.targetHandle,
      type: 'smoothstep',
      label: e.label,
      labelBgPadding: [4, 2] as [number, number],
      labelBgBorderRadius: 4,
      markerStart: { type: MarkerType.ArrowClosed, width: 14, height: 14, color: 'var(--muted-foreground)' },
      className: active ? 'kleos-edge-active' : undefined,
      zIndex: active ? 1 : 0,
      ariaLabel: `From ${e.fk.table}.${e.fk.columns.join(', ')} to ${e.fk.refTable}.${e.fk.refColumns.join(', ')}`,
    };
  });
}

/** Fits the viewport once, when the first nodes have been measured. */
function FitOnFirstLayout() {
  const initialized = useNodesInitialized();
  const { fitView } = useReactFlow();
  const done = useRef(false);
  useEffect(() => {
    if (initialized && !done.current) {
      done.current = true;
      void fitView({ padding: 0.15, maxZoom: 1 });
    }
  }, [initialized, fitView]);
  return null;
}

function ZoomButton({
  label,
  onClick,
  last,
  children,
}: {
  label: string;
  onClick(): void;
  last?: boolean;
  children: ReactNode;
}) {
  return (
    <Button
      variant="ghost"
      size="icon"
      aria-label={label}
      title={label}
      onClick={onClick}
      className={last ? 'rounded-none' : 'rounded-none border-b'}
    >
      {children}
    </Button>
  );
}

function Legend() {
  return (
    <div className="bg-card flex items-center gap-3.5 rounded-lg border px-3 py-2 text-[11px]">
      <span className="flex items-center gap-1.5">
        <KeyRound className="text-primary-key size-3" aria-hidden="true" />
        Primary key
      </span>
      <span className="flex items-center gap-1.5">
        <ArrowUpRight className="text-muted-foreground size-3" aria-hidden="true" />
        Foreign key
      </span>
      <span>
        <span className="font-mono">type?</span> nullable
      </span>
    </div>
  );
}

/** "Focus a table…": a text box with the schema's tables as suggestions; Enter takes the best match. */
function FocusSearch({ model, schema, onFocus }: { model: SchemaModel; schema: string; onFocus(ref: TableRef): void }) {
  const [text, setText] = useState('');
  const listId = useId();
  const names = useMemo(
    () =>
      model.tables
        .filter((t) => t.schema === schema)
        .map((t) => t.name)
        .sort(),
    [model, schema],
  );

  function bestMatch(q: string): string | undefined {
    const lower = q.trim().toLowerCase();
    if (!lower) return undefined;
    return (
      names.find((n) => n.toLowerCase() === lower) ??
      names.find((n) => n.toLowerCase().startsWith(lower)) ??
      names.find((n) => n.toLowerCase().includes(lower))
    );
  }

  return (
    <div className="relative w-[220px]">
      <Search className="text-muted-foreground absolute top-2 left-2.5 size-4" aria-hidden="true" />
      <Input
        aria-label="Focus a table"
        placeholder="Focus a table…"
        className="h-8 pl-8"
        list={listId}
        value={text}
        onChange={(e) => {
          const value = e.target.value;
          setText(value);
          // Picking a suggestion from the datalist puts its exact name in the box.
          if (names.includes(value)) onFocus({ schema, name: value });
        }}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault();
            const match = bestMatch(text);
            if (match) {
              setText(match);
              onFocus({ schema, name: match });
            } else {
              toast.info(`No table in ${schema} matches “${text.trim()}”`);
            }
          } else if (e.key === 'Escape') {
            setText('');
          }
        }}
      />
      <datalist id={listId}>
        {names.map((n) => (
          <option key={n} value={n} />
        ))}
      </datalist>
    </div>
  );
}
