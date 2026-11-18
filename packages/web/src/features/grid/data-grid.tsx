import { useVirtualizer } from '@tanstack/react-virtual';
import { ArrowDown, ArrowUp, ArrowUpRight, KeyRound, Minus, Pencil, Plus } from 'lucide-react';
import {
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type ClipboardEvent,
  type KeyboardEvent,
  type MouseEvent,
  type PointerEvent,
  type ReactNode,
} from 'react';
import type { CellValue } from '@kleos/shared';
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuLabel,
  ContextMenuSeparator,
  ContextMenuShortcut,
  ContextMenuTrigger,
} from '@/components/ui/context-menu';
import { isMonospace, isRightAligned } from '@/features/cells/classify';
import { CellValueView, NullMark } from '@/features/cells/cell-value';
import { cn } from '@/lib/utils';
import { dropSlot, indexAfterMove, LAYOUT_MAX_WIDTH, slotTarget } from './column-layout';
import { copyText, formatRows, type CopyFormat } from './copy';
import { defaultColumnWidth, gutterWidth, HEADER_HEIGHT, MIN_COL_WIDTH, ROW_HEIGHT } from './layout';
import { isCellSelected, moveSelection, selectedRows, selectionBounds, tabSelection, type MoveKey } from './selection';
import type { CellPos, GridCell, GridColumn, GridRowMeta, GridSelection } from './types';

export type DataGridProps = {
  columns: readonly GridColumn[];
  rowCount: number;
  getRowMeta(row: number): GridRowMeta;
  getCell(row: number, col: number): GridCell;
  selection: GridSelection | null;
  onSelectionChange(sel: GridSelection | null): void;
  /** Accessible name of the grid, e.g. "orders rows". */
  ariaLabel: string;
  /** Header click, e.g. to sort; Shift adds to a multi-column sort. */
  onHeaderClick?(col: number, opts: { shiftKey: boolean }): void;
  headerClickHint?: string;
  canEdit?(pos: CellPos): boolean;
  /** Cell being edited; its editor is drawn over the cell by renderEditor. */
  editing?: CellPos | null;
  onEditRequest?(pos: CellPos): void;
  renderEditor?(pos: CellPos): ReactNode;
  /** Delete / Backspace on a whole-row selection. */
  onDeleteRows?(rows: number[]): void;
  /** Called when the last rendered row is close to the end, to load the next page. */
  onEndReached?(): void;
  /** Extra context-menu entries for the focused cell. */
  contextMenuExtra?(pos: CellPos): ReactNode;
  emptyState?: ReactNode;
  className?: string;
  /** Initial viewport for environments without layout (tests). */
  initialRect?: { width: number; height: number };
  /** Column widths by key, when the caller keeps them; otherwise the grid keeps its own. */
  columnWidths?: Readonly<Record<string, number>>;
  /** A resize ended, or a double-click on the edge asked for the default width (null). */
  onColumnResize?(key: string, width: number | null): void;
  /** Reordering: move the column shown at `from` to `to` (header drag, ⌥←/⌥→, header menu). */
  onColumnMove?(from: number, to: number): void;
  /** "Reset columns" in the menu: natural order and default widths. */
  onResetColumns?(): void;
  /** Whether the caller's order or widths differ from the defaults (enables Reset columns). */
  columnsCustomized?: boolean;
};

const moveKeys: Record<string, MoveKey> = {
  ArrowUp: 'up',
  ArrowDown: 'down',
  ArrowLeft: 'left',
  ArrowRight: 'right',
  Home: 'home',
  End: 'end',
  PageUp: 'pageUp',
  PageDown: 'pageDown',
};

const isMac = typeof navigator !== 'undefined' && /Mac/.test(navigator.platform);
const mod = isMac ? '⌘' : 'Ctrl+';
const alt = isMac ? '⌥' : 'Alt+';

/**
 * The virtualized grid shared by the Data tab and query results: rows and columns are
 * both virtualized, the header and the row-number gutter are sticky, columns resize by
 * dragging their right edge. Selection is controlled by the caller; values come through
 * getCell so the caller can overlay staged edits without copying rows.
 */
export function DataGrid(props: DataGridProps) {
  const {
    columns,
    rowCount,
    getRowMeta,
    getCell,
    selection,
    onSelectionChange,
    ariaLabel,
    onHeaderClick,
    headerClickHint,
    canEdit,
    editing,
    onEditRequest,
    renderEditor,
    onDeleteRows,
    onEndReached,
    contextMenuExtra,
    emptyState,
    className,
    initialRect,
    columnWidths,
    onColumnResize,
    onColumnMove,
    onResetColumns,
    columnsCustomized,
  } = props;
  const gridId = useId();
  const scrollRef = useRef<HTMLDivElement>(null);
  const [localWidths, setLocalWidths] = useState<Record<string, number>>({});
  const widths = columnWidths ?? localWidths;
  // Width of the column being resized, drawn live and handed to the caller when the drag ends.
  const [liveWidth, setLiveWidth] = useState<{ key: string; width: number } | null>(null);
  const dragRef = useRef<{ key: string; startX: number; startWidth: number; width: number } | null>(null);
  const mouseSelectingRef = useRef(false);
  // Header drag to reorder: it starts after a few pixels, so a plain click still sorts.
  const headerDragRef = useRef<{ from: number; startX: number; pointerId: number; moved: boolean } | null>(null);
  const suppressHeaderClickRef = useRef(false);
  const [drop, setDrop] = useState<{ from: number; slot: number } | null>(null);
  // Header the context menu was opened on; null for a cell (the menu then acts on the focused column).
  const [menuCol, setMenuCol] = useState<number | null>(null);
  const [announcement, setAnnouncement] = useState('');

  const colWidths = useMemo(
    () => columns.map((c) => (liveWidth?.key === c.key ? liveWidth.width : (widths[c.key] ?? defaultColumnWidth(c)))),
    [columns, widths, liveWidth],
  );
  const lastLabel = rowCount > 0 ? getRowMeta(rowCount - 1).label : '';
  const gutter = gutterWidth(lastLabel.length > 3 ? lastLabel : '999');
  /** The n+1 column boundaries in content coordinates, for dropping a dragged header. */
  const edges = useMemo(() => {
    const out = [gutter];
    for (const w of colWidths) out.push(out[out.length - 1]! + w);
    return out;
  }, [colWidths, gutter]);
  const canReorder = Boolean(onColumnMove);
  const hasColumnMenu = canReorder || Boolean(onResetColumns);

  const rowVirtualizer = useVirtualizer({
    count: rowCount,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => ROW_HEIGHT,
    paddingStart: HEADER_HEIGHT,
    scrollPaddingStart: HEADER_HEIGHT,
    overscan: 12,
    initialRect,
  });
  const colVirtualizer = useVirtualizer({
    horizontal: true,
    count: columns.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: (i) => colWidths[i] ?? 120,
    paddingStart: gutter,
    scrollPaddingStart: gutter,
    overscan: 3,
    initialRect,
  });

  useEffect(() => {
    colVirtualizer.measure();
  }, [colVirtualizer, colWidths, gutter]);

  const virtualRows = rowVirtualizer.getVirtualItems();
  const virtualCols = colVirtualizer.getVirtualItems();
  const totalWidth = colVirtualizer.getTotalSize();
  const totalHeight = rowVirtualizer.getTotalSize();

  // Keep the focused cell in view as it moves (keyboard, Add row, failed-commit jump).
  const focusRow = selection?.focus.row;
  const focusCol = selection?.focus.col;
  useEffect(() => {
    if (focusRow === undefined || focusCol === undefined) return;
    if (focusRow < rowCount) rowVirtualizer.scrollToIndex(focusRow, { align: 'auto' });
    if (focusCol < columns.length) colVirtualizer.scrollToIndex(focusCol, { align: 'auto' });
  }, [focusRow, focusCol, rowCount, columns.length, rowVirtualizer, colVirtualizer]);

  const lastRendered = virtualRows.at(-1)?.index;
  useEffect(() => {
    if (onEndReached && lastRendered !== undefined && lastRendered >= rowCount - 40) onEndReached();
  }, [lastRendered, rowCount, onEndReached]);

  // Give focus back to the grid when an editor closes, so the keyboard keeps working.
  const wasEditing = useRef(false);
  useEffect(() => {
    if (wasEditing.current && !editing) scrollRef.current?.focus({ preventScroll: true });
    wasEditing.current = Boolean(editing);
  }, [editing]);

  const colCount = columns.length;
  const cellId = (row: number, col: number) => `${gridId}-r${row}-c${col}`;
  const editable = (pos: CellPos) => Boolean(onEditRequest && (canEdit?.(pos) ?? true));

  const selectionText = (format: CopyFormat, withHeader: boolean, wholeRows: boolean): string => {
    if (!selection) return '';
    const b = selectionBounds(selection, colCount);
    const left = wholeRows ? 0 : b.left;
    const right = wholeRows ? colCount - 1 : b.right;
    const rows: (CellValue | undefined)[][] = [];
    for (let r = b.top; r <= b.bottom; r += 1) {
      const line: (CellValue | undefined)[] = [];
      for (let c = left; c <= right; c += 1) line.push(getCell(r, c).value);
      rows.push(line);
    }
    const header = withHeader ? columns.slice(left, right + 1).map((c) => c.name) : undefined;
    return formatRows(rows, format, header);
  };

  const moveColumn = (from: number, to: number) => {
    if (!onColumnMove || from === to || from < 0 || to < 0 || from >= colCount || to >= colCount) return;
    const name = columns[from]!.name;
    onColumnMove(from, to);
    if (selection) {
      // The selection follows the moved column; a range collapses to its focused cell.
      const col = indexAfterMove(selection.focus.col, from, to);
      const focus = { row: selection.focus.row, col };
      onSelectionChange(
        selection.rows ? { anchor: { row: selection.anchor.row, col }, focus, rows: true } : { anchor: focus, focus },
      );
    }
    setAnnouncement(`Moved ${name} to column ${to + 1} of ${colCount}.`);
  };

  const resetColumns = () => {
    if (!columnWidths) setLocalWidths({});
    onResetColumns?.();
    setAnnouncement('Columns reset to their natural order and widths.');
  };

  const cancelHeaderDrag = () => {
    headerDragRef.current = null;
    setDrop(null);
  };

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (drop && e.key === 'Escape') {
      e.preventDefault();
      cancelHeaderDrag();
      return;
    }
    if (e.target !== e.currentTarget) return;
    if (e.altKey && (e.key === 'ArrowLeft' || e.key === 'ArrowRight') && canReorder) {
      e.preventDefault();
      if (selection) moveColumn(selection.focus.col, selection.focus.col + (e.key === 'ArrowLeft' ? -1 : 1));
      return;
    }
    const size = {
      rows: rowCount,
      cols: colCount,
      pageRows: Math.max(1, Math.floor((scrollRef.current?.clientHeight ?? 600) / ROW_HEIGHT) - 2),
    };
    const meta = e.metaKey || e.ctrlKey;
    if (moveKeys[e.key]) {
      e.preventDefault();
      let key = moveKeys[e.key]!;
      if (meta && key === 'up') key = 'first';
      if (meta && key === 'down') key = 'last';
      if (meta && key === 'left') key = 'home';
      if (meta && key === 'right') key = 'end';
      onSelectionChange(moveSelection(selection, key, e.shiftKey, size));
    } else if (e.key === 'Tab') {
      if (rowCount === 0) return;
      e.preventDefault();
      onSelectionChange(tabSelection(selection, e.shiftKey, size));
    } else if ((e.key === 'Enter' || e.key === 'F2') && selection) {
      e.preventDefault();
      if (editable(selection.focus)) onEditRequest?.(selection.focus);
    } else if (e.key === 'Escape') {
      if (!selection) return;
      e.preventDefault();
      const collapsed =
        !selection.rows && selection.anchor.row === selection.focus.row && selection.anchor.col === selection.focus.col;
      onSelectionChange(collapsed ? null : { anchor: selection.focus, focus: selection.focus });
    } else if (meta && e.key.toLowerCase() === 'a') {
      e.preventDefault();
      if (rowCount > 0 && colCount > 0) {
        onSelectionChange({ anchor: { row: 0, col: 0 }, focus: { row: rowCount - 1, col: colCount - 1 }, rows: true });
      }
    } else if ((e.key === 'Delete' || e.key === 'Backspace') && selection?.rows && onDeleteRows) {
      e.preventDefault();
      onDeleteRows(selectedRows(selection, colCount));
    }
  };

  const onCopy = (e: ClipboardEvent<HTMLDivElement>) => {
    if (e.target !== e.currentTarget || !selection) return;
    e.preventDefault();
    e.clipboardData.setData('text/plain', selectionText('tsv', false, false));
  };

  const posFromEvent = (target: EventTarget): { pos: CellPos; gutter: boolean } | null => {
    const el = (target as HTMLElement).closest<HTMLElement>('[data-row]');
    if (!el) return null;
    const row = Number(el.dataset.row);
    const isGutter = el.dataset.col === undefined;
    return { pos: { row, col: isGutter ? 0 : Number(el.dataset.col) }, gutter: isGutter };
  };

  const selectAt = (hit: { pos: CellPos; gutter: boolean }, extend: boolean) => {
    if (extend && selection) {
      onSelectionChange({
        anchor: selection.anchor,
        focus: hit.gutter ? { row: hit.pos.row, col: selection.focus.col } : hit.pos,
        rows: hit.gutter || selection.rows,
      });
    } else if (hit.gutter) {
      const pos = { row: hit.pos.row, col: selection?.focus.col ?? 0 };
      onSelectionChange({ anchor: pos, focus: pos, rows: true });
    } else {
      onSelectionChange({ anchor: hit.pos, focus: hit.pos });
    }
  };

  const onMouseDown = (e: MouseEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    const hit = posFromEvent(e.target);
    if (!hit) return;
    if ((e.target as HTMLElement).closest('[data-grid-editor], button, a')) return;
    selectAt(hit, e.shiftKey);
    mouseSelectingRef.current = true;
  };

  const onMouseMove = (e: MouseEvent<HTMLDivElement>) => {
    if (!mouseSelectingRef.current || e.buttons !== 1 || !selection) return;
    const hit = posFromEvent(e.target);
    if (!hit) return;
    const focus = hit.gutter ? { row: hit.pos.row, col: selection.focus.col } : hit.pos;
    if (focus.row !== selection.focus.row || focus.col !== selection.focus.col) {
      onSelectionChange({ anchor: selection.anchor, focus, rows: selection.rows });
    }
  };

  const onContextMenu = (e: MouseEvent<HTMLDivElement>) => {
    const header = hasColumnMenu ? (e.target as HTMLElement).closest<HTMLElement>('[data-header-col]') : null;
    setMenuCol(header ? Number(header.dataset.headerCol) : null);
    if (header) return;
    const hit = posFromEvent(e.target);
    if (hit && !isCellSelected(selection, hit.pos, colCount)) selectAt(hit, false);
  };

  const onDoubleClick = (e: MouseEvent<HTMLDivElement>) => {
    const hit = posFromEvent(e.target);
    if (!hit || hit.gutter) return;
    if ((e.target as HTMLElement).closest('[data-grid-editor], button, a')) return;
    if (editable(hit.pos)) onEditRequest?.(hit.pos);
  };

  const commitWidth = (key: string, width: number | null) => {
    if (!columnWidths) {
      setLocalWidths(({ [key]: _old, ...rest }) => (width === null ? rest : { ...rest, [key]: width }));
    }
    onColumnResize?.(key, width);
  };

  const startResize = (e: PointerEvent<HTMLDivElement>, key: string, width: number) => {
    e.preventDefault();
    e.stopPropagation();
    e.currentTarget.setPointerCapture?.(e.pointerId);
    dragRef.current = { key, startX: e.clientX, startWidth: width, width };
  };
  const moveResize = (e: PointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current;
    if (!drag) return;
    const next = Math.min(
      LAYOUT_MAX_WIDTH,
      Math.max(MIN_COL_WIDTH, Math.round(drag.startWidth + e.clientX - drag.startX)),
    );
    if (next === drag.width) return;
    drag.width = next;
    setLiveWidth({ key: drag.key, width: next });
  };
  const endResize = () => {
    const drag = dragRef.current;
    dragRef.current = null;
    if (drag && drag.width !== drag.startWidth) commitWidth(drag.key, drag.width);
    setLiveWidth(null);
  };

  /** Pointer x in the scrolled content's coordinates (the space of `edges`). */
  const contentX = (clientX: number) => {
    const el = scrollRef.current;
    return el ? clientX - el.getBoundingClientRect().left + el.scrollLeft : clientX;
  };
  const startHeaderDrag = (e: PointerEvent<HTMLDivElement>, index: number) => {
    suppressHeaderClickRef.current = false;
    if (!canReorder || e.button !== 0) return;
    headerDragRef.current = { from: index, startX: e.clientX, pointerId: e.pointerId, moved: false };
  };
  const onPointerMove = (e: PointerEvent<HTMLDivElement>) => {
    const d = headerDragRef.current;
    if (!d || e.pointerId !== d.pointerId) return;
    const el = scrollRef.current;
    if (!d.moved) {
      if (Math.abs(e.clientX - d.startX) < 5) return;
      d.moved = true;
      // Captured only once it is a drag, so a plain click still reaches the header button.
      el?.setPointerCapture?.(e.pointerId);
    }
    if (el) {
      // Scroll when the pointer nears either side, so a column can travel past the viewport.
      const rect = el.getBoundingClientRect();
      if (rect.width > 0 && e.clientX < rect.left + gutter + 24) el.scrollLeft -= 24;
      else if (rect.width > 0 && e.clientX > rect.right - 24) el.scrollLeft += 24;
    }
    const slot = dropSlot(edges, contentX(e.clientX));
    setDrop((cur) => (cur?.slot === slot && cur.from === d.from ? cur : { from: d.from, slot }));
  };
  const onPointerUp = (e: PointerEvent<HTMLDivElement>) => {
    const d = headerDragRef.current;
    if (!d || e.pointerId !== d.pointerId) return;
    cancelHeaderDrag();
    if (!d.moved) return;
    suppressHeaderClickRef.current = true;
    moveColumn(d.from, slotTarget(d.from, dropSlot(edges, contentX(e.clientX))));
  };

  const activeId =
    selection && selection.focus.row < rowCount && selection.focus.col < colCount
      ? cellId(selection.focus.row, selection.focus.col)
      : undefined;
  const bounds = selection ? selectionBounds(selection, colCount) : null;
  const editorTop = editing ? HEADER_HEIGHT + editing.row * ROW_HEIGHT : 0;
  const editorLeft = editing ? gutter + colWidths.slice(0, editing.col).reduce((a, b) => a + b, 0) : 0;
  const editorWidth = editing ? Math.max(colWidths[editing.col] ?? 0, 300) : 0;

  const copyMenu = (format: CopyFormat, withHeader: boolean, wholeRows: boolean) => {
    void copyText(selectionText(format, withHeader, wholeRows));
  };

  const headerTitle = canReorder
    ? [headerClickHint, `Drag to reorder; ${alt}← ${alt}→ move the selected column`].filter(Boolean).join(' · ')
    : headerClickHint;

  return (
    <>
      <ContextMenu>
        <ContextMenuTrigger asChild>
          <div
            ref={scrollRef}
            role="grid"
            tabIndex={0}
            aria-label={ariaLabel}
            aria-rowcount={rowCount + 1}
            aria-colcount={colCount + 1}
            aria-multiselectable="true"
            aria-activedescendant={editing ? undefined : activeId}
            className={cn(
              'relative min-h-0 min-w-0 flex-1 overflow-auto text-xs outline-none [container-type:inline-size]',
              'focus-visible:ring-ring/35 focus-visible:ring-2 focus-visible:ring-inset',
              drop && 'cursor-grabbing select-none',
              className,
            )}
            onKeyDown={onKeyDown}
            onPointerMove={onPointerMove}
            onPointerUp={onPointerUp}
            onPointerCancel={cancelHeaderDrag}
            onCopy={onCopy}
            onMouseDown={onMouseDown}
            onMouseMove={onMouseMove}
            onMouseUp={() => (mouseSelectingRef.current = false)}
            onDoubleClick={onDoubleClick}
            onContextMenu={onContextMenu}
          >
            <div className="relative" style={{ width: totalWidth, height: Math.max(totalHeight, HEADER_HEIGHT) }}>
              <div
                role="row"
                aria-rowindex={1}
                className="bg-sidebar sticky top-0 z-[2] flex"
                style={{ height: HEADER_HEIGHT, width: totalWidth }}
              >
                <div
                  role="columnheader"
                  aria-colindex={1}
                  className="bg-sidebar text-muted-foreground sticky left-0 z-[3] flex items-center justify-end border-r border-b px-2.5 font-mono text-[11px] shadow-[0_1px_0_var(--border)]"
                  style={{ width: gutter, minWidth: gutter }}
                >
                  #
                </div>
                {virtualCols.map((vc) => {
                  const col = columns[vc.index]!;
                  const sortLabel = col.sort ? (col.sort.dir === 'asc' ? 'ascending' : 'descending') : undefined;
                  const headerBody = (
                    <>
                      <span className="flex min-w-0 items-center gap-1">
                        {col.primaryKey && (
                          <KeyRound
                            className="text-primary-key size-[11px] shrink-0"
                            role="img"
                            aria-label="Primary key"
                          />
                        )}
                        <span className="text-foreground truncate text-[12px] font-semibold tracking-[-0.005em]">
                          {col.name}
                        </span>
                        {col.sort && (
                          <span className="text-brand-text inline-flex shrink-0 items-center">
                            {col.sort.dir === 'asc' ? (
                              <ArrowUp className="size-3" role="img" aria-label="Sorted ascending" />
                            ) : (
                              <ArrowDown className="size-3" role="img" aria-label="Sorted descending" />
                            )}
                            {col.sort.of > 1 && <sub className="font-mono text-[9px]">{col.sort.position}</sub>}
                          </span>
                        )}
                      </span>
                      <span className="text-muted-foreground block truncate font-mono text-[10.5px] leading-4 font-normal">
                        {col.typeLabel}
                      </span>
                    </>
                  );
                  const dragged = drop?.from === vc.index;
                  return (
                    <div
                      key={col.key}
                      role="columnheader"
                      aria-colindex={vc.index + 2}
                      aria-sort={sortLabel ?? 'none'}
                      data-header-col={vc.index}
                      className={cn(
                        'bg-sidebar absolute top-0 flex h-full flex-col justify-center border-r border-b select-none',
                        isRightAligned(col.kind) && 'items-end text-right',
                        dragged && 'bg-brand-soft shadow-[inset_0_-2px_0_var(--brand)]',
                      )}
                      style={{ left: vc.start, width: vc.size }}
                      onPointerDown={(e) => startHeaderDrag(e, vc.index)}
                    >
                      {onHeaderClick ? (
                        <button
                          type="button"
                          tabIndex={-1}
                          title={headerTitle}
                          className={cn(
                            'hover:bg-foreground/[0.04] dark:hover:bg-white/[0.04] flex h-full w-full min-w-0 flex-col justify-center px-2.5 text-left',
                            isRightAligned(col.kind) && 'items-end text-right',
                          )}
                          onClick={(e) => {
                            if (suppressHeaderClickRef.current) {
                              suppressHeaderClickRef.current = false;
                              return;
                            }
                            onHeaderClick(vc.index, { shiftKey: e.shiftKey });
                          }}
                        >
                          {headerBody}
                        </button>
                      ) : (
                        <div className="flex min-w-0 flex-col px-2.5" title={headerTitle}>
                          {headerBody}
                        </div>
                      )}
                      <div
                        role="separator"
                        aria-orientation="vertical"
                        aria-label={`Resize ${col.name}`}
                        className="after:bg-brand absolute top-0 -right-1 z-[1] h-full w-2 cursor-col-resize after:absolute after:inset-y-1.5 after:left-[3px] after:w-0.5 after:rounded-full after:opacity-0 after:transition-opacity hover:after:opacity-70"
                        onPointerDown={(e) => startResize(e, col.key, vc.size)}
                        onPointerMove={moveResize}
                        onPointerUp={endResize}
                        onPointerCancel={endResize}
                        onDoubleClick={(e) => {
                          e.stopPropagation();
                          commitWidth(col.key, null);
                        }}
                      />
                    </div>
                  );
                })}
              </div>

              {rowCount === 0 && emptyState && (
                <div className="text-muted-foreground sticky left-0 flex w-[100cqw] justify-center px-6 py-10 text-[13px]">
                  {emptyState}
                </div>
              )}

              {virtualRows.map((vr) => {
                const meta = getRowMeta(vr.index);
                const rowSelected = Boolean(bounds && vr.index >= bounds.top && vr.index <= bounds.bottom);
                return (
                  <div
                    key={meta.key}
                    role="row"
                    aria-rowindex={vr.index + 2}
                    aria-selected={selection?.rows ? rowSelected : undefined}
                    className={cn(
                      'group/row absolute left-0 flex',
                      !meta.status && 'hover:bg-foreground/[0.025] dark:hover:bg-white/[0.03]',
                      meta.status === 'insert' && 'bg-staged-insert text-staged-insert-foreground',
                      meta.status === 'delete' && 'bg-staged-delete text-staged-delete-foreground',
                    )}
                    style={{ top: vr.start, height: ROW_HEIGHT, width: totalWidth }}
                  >
                    <div
                      role="rowheader"
                      data-row={vr.index}
                      aria-colindex={1}
                      className={cn(
                        'text-muted-foreground group-hover/row:text-foreground sticky left-0 z-[1] flex items-center justify-end gap-1 border-r border-b px-2.5 font-mono text-[11px]',
                        rowSelected && selection?.rows
                          ? 'bg-sidebar text-brand-text group-hover/row:text-brand-text font-medium shadow-[inset_0_0_0_999px_var(--brand-soft),inset_-2px_0_0_var(--brand)]'
                          : 'bg-sidebar',
                        meta.status === 'insert' && 'bg-staged-insert text-staged-insert-foreground',
                        meta.status === 'delete' && 'bg-staged-delete text-staged-delete-foreground',
                        meta.status === 'update' && 'text-staged-update-foreground',
                      )}
                      style={{ width: gutter, minWidth: gutter }}
                    >
                      <RowStatusIcon status={meta.status} />
                      {meta.label}
                    </div>
                    {virtualCols.map((vc) => {
                      const col = columns[vc.index]!;
                      const cell = getCell(vr.index, vc.index);
                      const pos = { row: vr.index, col: vc.index };
                      const selected = isCellSelected(selection, pos, colCount);
                      const isFocus = selection?.focus.row === vr.index && selection.focus.col === vc.index;
                      const right = isRightAligned(col.kind);
                      return (
                        <div
                          key={col.key}
                          id={cellId(vr.index, vc.index)}
                          role="gridcell"
                          aria-colindex={vc.index + 2}
                          aria-selected={selected}
                          aria-invalid={cell.error ? true : undefined}
                          data-row={vr.index}
                          data-col={vc.index}
                          title={cell.error ?? (cell.changed ? `Was ${cell.was ?? 'NULL'}` : undefined)}
                          className={cn(
                            'absolute top-0 flex h-full items-center gap-1 overflow-hidden border-r border-b px-2.5 whitespace-nowrap',
                            right && 'justify-end',
                            isMonospace(col.kind) && 'font-mono',
                            selected && !isFocus && 'bg-brand-soft',
                            isFocus && 'bg-[color-mix(in_srgb,var(--brand)_6%,transparent)]',
                            cell.changed &&
                              'bg-staged-update text-staged-update-foreground shadow-[inset_3px_0_0_var(--staged-update-line)]',
                            meta.status === 'delete' && 'line-through',
                          )}
                          style={{ left: vc.start, width: vc.size }}
                        >
                          <span className={cn('min-w-0 truncate', right && 'text-right')}>
                            {cell.value === undefined ? (
                              <NullMark label="DEFAULT" className="text-current opacity-80" />
                            ) : (
                              <CellValueView kind={col.kind} value={cell.value} />
                            )}
                          </span>
                          {cell.link && meta.status !== 'delete' && (
                            <button
                              type="button"
                              tabIndex={-1}
                              className="text-muted-foreground/80 hover:text-brand-text hover:bg-brand-soft inline-flex size-4 shrink-0 items-center justify-center rounded-[4px]"
                              aria-label={cell.link.label}
                              title={cell.link.label}
                              onClick={cell.link.onOpen}
                            >
                              <ArrowUpRight className="size-3" aria-hidden="true" />
                            </button>
                          )}
                          {isFocus && (
                            <span
                              aria-hidden="true"
                              className="ring-brand pointer-events-none absolute inset-0 rounded-[2px] ring-2 ring-inset"
                            />
                          )}
                          {cell.error && (
                            <span
                              aria-hidden="true"
                              className="ring-destructive pointer-events-none absolute inset-0 ring-2 ring-inset"
                            />
                          )}
                        </div>
                      );
                    })}
                  </div>
                );
              })}

              {drop && (
                <div
                  aria-hidden="true"
                  data-drop-indicator=""
                  className="bg-brand pointer-events-none absolute top-0 z-[5] w-0.5 rounded-full shadow-[0_0_0_1px_var(--background)]"
                  style={{ left: edges[drop.slot]! - 1, height: Math.max(totalHeight, HEADER_HEIGHT) }}
                />
              )}

              {editing && renderEditor && (
                <div
                  data-grid-editor=""
                  className="absolute z-[4]"
                  style={{ top: editorTop, left: editorLeft, width: editorWidth }}
                  onMouseDown={(e) => e.stopPropagation()}
                  onDoubleClick={(e) => e.stopPropagation()}
                >
                  {renderEditor(editing)}
                </div>
              )}
            </div>
          </div>
        </ContextMenuTrigger>
        <ContextMenuContent className="w-64">
          {menuCol === null ? (
            <>
              <ContextMenuItem disabled={!selection} onSelect={() => copyMenu('tsv', false, false)}>
                Copy
                <ContextMenuShortcut>{mod}C</ContextMenuShortcut>
              </ContextMenuItem>
              <ContextMenuItem disabled={!selection} onSelect={() => copyMenu('csv', true, true)}>
                Copy rows as CSV
              </ContextMenuItem>
              <ContextMenuItem disabled={!selection} onSelect={() => copyMenu('tsv', true, true)}>
                Copy rows as TSV
              </ContextMenuItem>
              {selection && contextMenuExtra && (
                <>
                  <ContextMenuSeparator />
                  {contextMenuExtra(selection.focus)}
                </>
              )}
              {hasColumnMenu && <ContextMenuSeparator />}
            </>
          ) : (
            <ContextMenuLabel className="text-muted-foreground truncate font-mono text-xs">
              {columns[menuCol]?.name}
            </ContextMenuLabel>
          )}
          {hasColumnMenu && (
            <ColumnMenuItems
              col={menuCol ?? selection?.focus.col ?? null}
              colCount={colCount}
              canReorder={canReorder}
              canReset={Boolean(columnsCustomized) || Object.keys(localWidths).length > 0}
              onMove={moveColumn}
              onReset={onResetColumns ? resetColumns : undefined}
            />
          )}
        </ContextMenuContent>
      </ContextMenu>
      <span className="sr-only" aria-live="polite">
        {announcement}
      </span>
    </>
  );
}

/** Column entries of the grid menu: move the column left or right, reset every column. */
function ColumnMenuItems(props: {
  col: number | null;
  colCount: number;
  canReorder: boolean;
  canReset: boolean;
  onMove(from: number, to: number): void;
  onReset: (() => void) | undefined;
}) {
  const { col, colCount, canReorder, canReset, onMove, onReset } = props;
  return (
    <>
      {canReorder && (
        <>
          <ContextMenuItem disabled={col === null || col <= 0} onSelect={() => col !== null && onMove(col, col - 1)}>
            Move column left
            <ContextMenuShortcut>{alt}←</ContextMenuShortcut>
          </ContextMenuItem>
          <ContextMenuItem
            disabled={col === null || col >= colCount - 1}
            onSelect={() => col !== null && onMove(col, col + 1)}
          >
            Move column right
            <ContextMenuShortcut>{alt}→</ContextMenuShortcut>
          </ContextMenuItem>
        </>
      )}
      {onReset && (
        <ContextMenuItem disabled={!canReset} onSelect={onReset}>
          Reset columns
        </ContextMenuItem>
      )}
    </>
  );
}

function RowStatusIcon({ status }: { status: GridRowMeta['status'] }) {
  if (status === 'update') return <Pencil className="size-[11px]" role="img" aria-label="Changed" />;
  if (status === 'insert') return <Plus className="size-[11px]" role="img" aria-label="New row" />;
  if (status === 'delete') return <Minus className="size-[11px]" role="img" aria-label="Deleted" />;
  return null;
}
