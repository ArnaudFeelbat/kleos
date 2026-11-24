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
  getViewportForBounds,
  useReactFlow,
  type Edge,
  type Rect,
  type NodeChangeset,
  type NodeTypes,
} from '@xyflow/react';
import {
  ArrowUpRight,
  Info,
  KeyRound,
  LayoutGrid,
  Maximize,
  Minus,
  Network,
  Plus,
  Search,
  Waypoints,
} from 'lucide-react';
import { useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Skeleton } from '@/components/ui/skeleton';
import { EmptyState } from '@/features/common/empty-state';
import { NewTableButton } from '@/features/schema-edit/new-table-button';
import { SchemaPendingPanel } from '@/features/schema-edit/schema-pending-panel';
import { useWorkspace } from '@/features/workspace/context';
import { findRelation, selectStarSql } from '@/features/workspace/sidebar-model';
import { TabToolbar } from '@/features/workspace/tab-toolbar';
import { api, errorText, queryKeys } from '@/lib/api';
import { formatInt } from '@/lib/format';
import { cn } from '@/lib/utils';
import { buildErGraph, NEIGHBOUR_ONLY_THRESHOLD, type ErGraph } from './er-model';
import { ExportDiagramMenu } from './export/export-diagram-menu';
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
      <div className="bg-sidebar flex flex-1 flex-wrap content-start gap-8 p-10" aria-label="Loading schema">
        {[5, 3, 4].map((rows, i) => (
          <div key={i} className="surface-raised flex w-56 flex-col gap-2.5 rounded-[10px] p-3">
            <Skeleton className="h-4 w-28" />
            {Array.from({ length: rows }, (_, r) => (
              <Skeleton key={r} className={r % 2 ? 'h-2.5 w-36' : 'h-2.5 w-44'} />
            ))}
          </div>
        ))}
      </div>
    );
  }
  return (
    <>
      <ReactFlowProvider key={currentSchema}>
        <ErDiagram model={schemaModel} schema={currentSchema} />
      </ReactFlowProvider>
      {/* Staged schema changes (0.6): below the diagram and the detail panel, like the data tab's. */}
      <SchemaPendingPanel />
    </>
  );
}

/**
 * How a table brought into focus is framed: all of it, centered, with a margin; zoomed out as
 * far as a long table needs, never magnified past 125 % (a small table would fill the screen).
 */
// React Flow 13 reads a plain number of padding as pixels (v12 read it as a fraction): say %.
export const TABLE_FOCUS = { padding: '10%', maxZoom: 1.25 } as const;

const MIN_ZOOM = 0.1;
const MAX_ZOOM = 2;

/**
 * The viewport that shows `bounds` (flow coordinates) centered in a pane of that size, with the
 * padding and a zoom cap. Applied with setViewport, which moves the view at once: React Flow 13's
 * fitView only queues the move until the next nodes update, so on our controlled nodes it never
 * ran for F or Fit to view (only when a selection happened to redraw the nodes).
 */
type FramingOptions = { padding: `${number}%`; maxZoom: number };

export function framingViewport(
  bounds: Rect,
  pane: { width: number; height: number },
  { padding, maxZoom }: FramingOptions,
) {
  return getViewportForBounds(bounds, pane.width, pane.height, MIN_ZOOM, maxZoom, padding);
}

/** Fit to view: the zoom controls' button that shows every table (up to the diagram's max zoom). */
const FIT_ALL = { padding: '7%', maxZoom: MAX_ZOOM } as const;

function ErDiagram({ model, schema }: { model: SchemaModel; schema: string }) {
  const ws = useWorkspace();
  const { connection, selectedTable, openTable, openInQuery, activeTab, visible } = ws;
  const queryClient = useQueryClient();
  const { fitView, zoomIn, zoomOut, getNodesBounds, getNodes, setViewport } = useReactFlow<TableFlowNode>();
  const paneRef = useRef<HTMLElement>(null);

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
  const centerSelected = useCallback(() => {
    if (selectedKey) setFocusRequest((r) => ({ id: selectedKey, n: (r?.n ?? 0) + 1 }));
  }, [selectedKey]);

  // A table selected from outside the diagram (sidebar, ⌘K) while the diagram is in front is
  // brought into view; a click on a table in the diagram leaves the view where it is.
  const clickedKey = useRef<string | null>(null);
  const diagramInFront = visible && activeTab === 'schema';
  useEffect(() => {
    if (!selectedKey || limited || !diagramInFront) return;
    if (clickedKey.current === selectedKey) {
      clickedKey.current = null;
      return;
    }
    setFocusRequest((r) => ({ id: selectedKey, n: (r?.n ?? 0) + 1 }));
    // Only selection changes matter here, not the tab coming to the front.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedKey, limited]);

  // F centers the selected table, like the detail panel's button.
  useEffect(() => {
    if (!diagramInFront || !selectedKey) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'f' || e.metaKey || e.ctrlKey || e.altKey || e.defaultPrevented) return;
      const target = e.target as HTMLElement | null;
      if (target?.closest('input, textarea, select, [contenteditable="true"], [role="dialog"]')) return;
      e.preventDefault();
      centerSelected();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [diagramInFront, selectedKey, centerSelected]);

  // In neighbour-only mode every selection redraws the diagram, so it is centered too.
  const centerOn = limited ? selectedKey : (focusRequest?.id ?? null);
  const centerKey = centerOn ? `${centerOn}#${focusRequest?.n ?? 0}` : null;
  // React Flow hands out new helper functions whenever the viewport moves; read them through a
  // ref so only a new focus request (centerKey) frames a table — not every zoom, which would snap
  // the view back onto the last focused table.
  const flow = useRef({ getNodesBounds, getNodes, setViewport });
  useLayoutEffect(() => {
    flow.current = { getNodesBounds, getNodes, setViewport };
  });
  // Set once the view has been framed, by the first drawing or by anything else.
  const firstFitDone = useRef(false);
  /**
   * Moves the view to show `bounds`, centered, at once (animated). False when it can't yet:
   * the pane or the tables have no size (React Flow re-measures nodes after each redraw).
   */
  const frame = useCallback((bounds: Rect, options: FramingOptions): boolean => {
    const box = paneRef.current?.getBoundingClientRect();
    if (!box?.width || !box.height || !bounds.width || !bounds.height) return false;
    firstFitDone.current = true;
    void flow.current.setViewport(framingViewport(bounds, box, options), { duration: 300 });
    return true;
  }, []);
  // The first drawing shows every table, never magnified past 100 %. Immediate, like every
  // other framing: a queued fitView here would fire on the next nodes update — typically the
  // first selection — and undo that selection's framing. Skipped once anything framed the
  // view (a table picked before the diagram finished measuring, F, Fit to view).
  const initialized = useNodesInitialized();
  useEffect(() => {
    if (!initialized || firstFitDone.current) return;
    const ids = flow.current.getNodes().map((n) => n.id);
    if (ids.length === 0) return;
    firstFitDone.current = true;
    const bounds = flow.current.getNodesBounds(ids);
    const box = paneRef.current?.getBoundingClientRect();
    if (box?.width && box.height && bounds.width && bounds.height) {
      void flow.current.setViewport(framingViewport(bounds, box, { padding: FIT_ALL.padding, maxZoom: 1 }));
    }
  }, [initialized]);
  const fitAll = useCallback(() => {
    // By id, so React Flow measures from its internal nodes: our controlled node objects carry
    // no size, and their bounds would cover only the tables' top-left corners.
    const ids = flow.current.getNodes().map((n) => n.id);
    if (ids.length > 0) frame(flow.current.getNodesBounds(ids), FIT_ALL);
  }, [frame]);
  useEffect(() => {
    if (!centerOn || !centerKey) return;
    // Timers, not animation frames: Electron pauses frames for a window behind others, and a
    // table picked there should still be framed. Retried until the table has its size again
    // (a selection redraws the nodes, which React Flow then re-measures), for up to ~2 s.
    let timer: ReturnType<typeof setTimeout> | undefined;
    let tries = 0;
    const attempt = () => {
      if (frame(flow.current.getNodesBounds([centerOn]), TABLE_FOCUS)) return;
      if (tries++ < 80) timer = setTimeout(attempt, 25);
    };
    // A short wait first: selecting may have just opened the detail panel, narrowing the canvas.
    timer = setTimeout(attempt, 50);
    return () => clearTimeout(timer);
  }, [centerOn, centerKey, frame]);

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
      requestAnimationFrame(() => void fitView({ padding: FIT_ALL.padding, duration: 300 }));
    } catch (err) {
      toast.error('Automatic layout failed', { description: errorText(err) });
    }
  }

  const empty = tableCount === 0;

  return (
    <div className="flex min-h-0 flex-1">
      <TabToolbar tab="schema">
        <NewTableButton schema={schema} />
        <FocusSearch model={model} schema={schema} onFocus={focusTable} />
        <Button variant="outline" size="sm" onClick={() => void autoLayout()} disabled={graph.nodes.length === 0}>
          <LayoutGrid aria-hidden="true" />
          Auto layout
        </Button>
        <ExportDiagramMenu graph={graph} schema={schema} />
      </TabToolbar>

      <section ref={paneRef} aria-label="ER diagram" className="kleos-er relative min-w-0 flex-1">
        <ReactFlow<TableFlowNode, Edge>
          nodes={nodes}
          edges={edges}
          nodeTypes={nodeTypes}
          onNodesChange={onNodesChange}
          onNodeClick={(_, node) => {
            setClosedFor(null);
            clickedKey.current = node.id;
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
          minZoom={MIN_ZOOM}
          maxZoom={MAX_ZOOM}
          proOptions={{ hideAttribution: true }}
        >
          <Background variant={BackgroundVariant.Dots} gap={18} size={1} />
          <Panel position="top-right">
            <Legend />
          </Panel>
          {limited && (
            <Panel position="top-center">
              <p className="bg-warning-bg border-warning-line text-foreground flex max-w-md items-start gap-2 rounded-lg border px-3 py-2 text-xs shadow-[var(--elev-1)]">
                <Info className="text-warning mt-px size-3.5 shrink-0" aria-hidden="true" />
                <span>
                  {schema} has {formatInt(tableCount)} tables, so only the selected table and its neighbours are drawn.
                  Pick a table in the sidebar or with “Focus a table”.
                </span>
              </p>
            </Panel>
          )}
          <Panel position="bottom-left" className="flex items-end gap-3">
            <div role="group" aria-label="Zoom" className="surface-raised flex flex-col overflow-hidden rounded-lg">
              <ZoomButton label="Zoom in" onClick={() => void zoomIn({ duration: 200 })}>
                <Plus />
              </ZoomButton>
              <ZoomButton label="Zoom out" onClick={() => void zoomOut({ duration: 200 })}>
                <Minus />
              </ZoomButton>
              <ZoomButton label="Fit to view" onClick={fitAll} last>
                <Maximize />
              </ZoomButton>
            </div>
            <p className="bg-background/70 text-muted-foreground mb-0.5 rounded-full px-2.5 py-1 text-[11px] backdrop-blur-sm">
              Drag a table to pin it · positions saved for {connection.nickname} / {schema}
              {graph.external.length > 0 &&
                ` · ${graph.external.length} foreign ${graph.external.length === 1 ? 'key' : 'keys'} to other schemas not drawn`}
            </p>
          </Panel>
        </ReactFlow>
        {(empty || (limited && graph.nodes.length === 0)) && (
          <div className="pointer-events-none absolute inset-0 flex">
            {empty ? (
              <EmptyState
                icon={Network}
                title={`No tables in ${schema}.`}
                hint={
                  ws.readOnly
                    ? 'Pick another schema in the sidebar.'
                    : 'Pick another schema in the sidebar, or start one with “New table…” in the toolbar.'
                }
              />
            ) : (
              <EmptyState
                icon={Waypoints}
                title="Select a table to draw it and its neighbours."
                hint="Use the sidebar or “Focus a table” in the toolbar."
              />
            )}
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
          onCenter={centerSelected}
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
      labelBgPadding: [6, 3] as [number, number],
      labelBgBorderRadius: 6,
      markerStart: {
        type: MarkerType.ArrowClosed,
        width: 14,
        height: 14,
        color: active ? 'var(--brand)' : 'var(--muted-foreground)',
      },
      className: active ? 'kleos-edge-active' : undefined,
      zIndex: active ? 1 : 0,
      ariaLabel: `From ${e.fk.table}.${e.fk.columns.join(', ')} to ${e.fk.refTable}.${e.fk.refColumns.join(', ')}`,
    };
  });
}

/** Fits the viewport once, when the first nodes have been measured. */
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
      size="icon-sm"
      aria-label={label}
      title={label}
      onClick={onClick}
      className={cn('text-muted-foreground hover:text-foreground rounded-none', !last && 'border-b')}
    >
      {children}
    </Button>
  );
}

function Legend() {
  return (
    <div className="bg-background/80 text-muted-foreground flex items-center gap-3 rounded-full px-3 py-1 text-[11px] shadow-[0_0_0_1px_var(--edge)] backdrop-blur-sm">
      <span className="flex items-center gap-1.5">
        <KeyRound className="text-primary-key size-3" aria-hidden="true" />
        Primary key
      </span>
      <span className="bg-border h-3 w-px" aria-hidden="true" />
      <span className="flex items-center gap-1.5">
        <ArrowUpRight className="text-brand-text size-3" aria-hidden="true" />
        Foreign key
      </span>
      <span className="bg-border h-3 w-px" aria-hidden="true" />
      <span>
        <span className="text-foreground/80 font-mono">type?</span> nullable
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
      <Search
        className="text-muted-foreground absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2"
        aria-hidden="true"
      />
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
