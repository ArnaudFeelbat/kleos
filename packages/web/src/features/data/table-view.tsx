import { useMutation, useQuery, useQueryClient, type Query } from '@tanstack/react-query';
import { ChevronLeft, ChevronRight, Lock, PanelRight, Plus, RefreshCw, Trash, Undo2 } from 'lucide-react';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { toast } from 'sonner';
import {
  tableKey,
  type CellValue,
  type Column,
  type ColumnMeta,
  type ForeignKey,
  type RowsPage,
  type RowsRequest,
  type SchemaModel,
  type Table,
  type TableRef,
} from '@kleos/shared';
import { Button } from '@/components/ui/button';
import { ContextMenuItem } from '@/components/ui/context-menu';
import { Skeleton } from '@/components/ui/skeleton';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { CellEditor, type EditAdvance, type EditResult } from '@/features/cells/cell-editor';
import { classifyType, typeLabel, type CellKind } from '@/features/cells/classify';
import { DataGrid } from '@/features/grid/data-grid';
import { selectedRows, tabSelection } from '@/features/grid/selection';
import type { CellPos, GridCell, GridColumn, GridRowMeta, GridSelection } from '@/features/grid/types';
import { ValueInspector } from '@/features/grid/value-inspector';
import { api, ApiError, errorText, queryKeys } from '@/lib/api';
import { FilterBar } from './filter-bar';
import { chipsToFilters, foreignKeysByColumn, foreignKeyTarget, type FilterChip } from './filters';
import { PendingPanel } from './pending-panel';
import { renderPendingSql } from './pending-sql';
import {
  buildEdits,
  rowKeyOf,
  stageReducer,
  stageSize,
  type StageAction,
  type StagedUpdate,
  type StageTarget,
} from './staging';
import { groupDigits, nextSort, PAGE_SIZE, pageCount, updateTableView, useTableView } from './table-state';

const isMac = typeof navigator !== 'undefined' && /Mac/.test(navigator.platform);

/** One column of the Data tab, merged from the page's ColumnMeta and the introspected Column. */
type DataColumn = {
  meta: ColumnMeta;
  kind: CellKind;
  schema: Column | undefined;
  primaryKey: boolean;
  fk: ForeignKey | undefined;
  enumValues: string[] | undefined;
  /** Can be set by UPDATE (not generated, not identity ALWAYS, not bytea). */
  updatable: boolean;
};

export type TableViewProps = {
  sid: string;
  table: TableRef;
  /** Introspected table or view; undefined while the schema loads. */
  info: Table | undefined;
  schemaModel: SchemaModel | undefined;
  readOnly: boolean;
  /** True while the Data tab is the visible workspace tab (⌘S belongs to it). */
  active: boolean;
  openTable(ref: TableRef): void;
};

/** Why editing is off for this table, or null when it is on. */
export function editBlockReason(info: Table | undefined, readOnly: boolean): string | null {
  if (readOnly) return 'Read-only connection: editing is off.';
  if (!info) return null;
  if (info.kind === 'view' || info.kind === 'materialized') return 'Views are read-only here; edit the base table.';
  if (info.primaryKey.length === 0) return 'No primary key: rows can’t be identified safely, so editing is off.';
  return null;
}

/** Rows of one table: paging, sorting, filters, type-aware cells and staged edits. */
export function TableView({ sid, table, info, schemaModel, readOnly, active, openTable }: TableViewProps) {
  const queryClient = useQueryClient();
  const tk = tableKey(table);
  const [view, update] = useTableView(sid, tk);
  const [selection, setSelection] = useState<GridSelection | null>(null);
  const [editing, setEditing] = useState<CellPos | null>(null);
  const [inspectorOpen, setInspectorOpen] = useState(true);
  const stage = view.stage;
  const dispatch = useCallback(
    (action: StageAction) => update((s) => ({ ...s, stage: stageReducer(s.stage, action) })),
    [update],
  );

  // ---- rows and counts -------------------------------------------------------------
  const filters = useMemo(() => chipsToFilters(view.chips), [view.chips]);
  const where = view.where.trim() || undefined;
  const rowsReq = useMemo<RowsRequest>(
    () => ({ table, limit: PAGE_SIZE, offset: view.page * PAGE_SIZE, sort: view.sort, filters, where }),
    [table, view.page, view.sort, filters, where],
  );
  const rowsQuery = useQuery({
    queryKey: queryKeys.rows(sid, rowsReq),
    queryFn: () => api.rows(sid, rowsReq),
    // Keep the previous page on screen while the next one loads, but never another table's rows.
    placeholderData: (
      prev: RowsPage | undefined,
      prevQuery: Query<RowsPage, Error, RowsPage, readonly unknown[]> | undefined,
    ) => {
      const prevReq = prevQuery?.queryKey[2] as RowsRequest | undefined;
      return prevReq && tableKey(prevReq.table) === tk ? prev : undefined;
    },
  });
  const countBase = useMemo(() => ({ table, filters, where }), [table, filters, where]);
  const estimate = useQuery({
    queryKey: queryKeys.count(sid, { ...countBase, exact: false }),
    queryFn: () => api.count(sid, { ...countBase, exact: false }),
  });
  const countKey = JSON.stringify([tk, filters, where ?? '']);
  const [exactFor, setExactFor] = useState<string | null>(null);
  const exact = useQuery({
    queryKey: queryKeys.count(sid, { ...countBase, exact: true }),
    queryFn: () => api.count(sid, { ...countBase, exact: true }),
    enabled: exactFor === countKey,
  });

  // ---- columns ------------------------------------------------------------------
  const page = rowsQuery.data;
  const serverRows = useMemo(() => page?.rows ?? [], [page]);
  const columns = useMemo<DataColumn[]>(() => {
    const metas: ColumnMeta[] =
      page?.columns ??
      info?.columns.map((c) => ({
        name: c.name,
        type: c.type,
        typeName: c.typeName,
        typeOid: c.typeOid,
        typeCategory: c.typeCategory,
      })) ??
      [];
    const byName = new Map(info?.columns.map((c) => [c.name, c]));
    const fks = foreignKeysByColumn(schemaModel, table);
    const pk = new Set(info?.primaryKey ?? []);
    return metas.map((meta) => {
      const schemaCol = byName.get(meta.name);
      const kind = classifyType(meta);
      const enumValues =
        schemaCol?.enumValues ?? schemaModel?.enums.find((e) => e.name === meta.typeName)?.values ?? undefined;
      return {
        meta,
        kind,
        schema: schemaCol,
        primaryKey: pk.has(meta.name),
        fk: fks.get(meta.name),
        enumValues,
        updatable: kind !== 'bytea' && !schemaCol?.generated && schemaCol?.identity !== 'always',
      };
    });
  }, [page?.columns, info, schemaModel, table]);
  const colIndex = useMemo(() => new Map(columns.map((c, i) => [c.meta.name, i])), [columns]);
  const typeInfo = useMemo(() => Object.fromEntries(columns.map((c) => [c.meta.name, c.meta])), [columns]);

  const blockReason = editBlockReason(info, readOnly);
  const pkNames = useMemo(() => info?.primaryKey ?? [], [info]);
  const canEditTable = !blockReason && !!info && pkNames.every((c) => colIndex.has(c));

  // ---- staged edits over the page -------------------------------------------------
  const rowObject = useCallback(
    (row: readonly CellValue[]) => Object.fromEntries(columns.map((c, i) => [c.meta.name, row[i] ?? null])),
    [columns],
  );
  const rowKeys = useMemo(
    () => (canEditTable ? serverRows.map((r) => rowKeyOf(pkNames, rowObject(r))) : []),
    [canEditTable, serverRows, pkNames, rowObject],
  );
  const updatesByKey = useMemo(() => new Map<string, StagedUpdate>(stage.updates.map((u) => [u.rowKey, u])), [stage]);
  const deleted = useMemo(() => new Set(stage.deletes.map((d) => d.rowKey)), [stage]);
  const counts = stageSize(stage);
  const rowCount = serverRows.length + stage.inserts.length;
  const offset = view.page * PAGE_SIZE;

  const gridColumns = useMemo<GridColumn[]>(() => {
    return columns.map((c) => {
      const sortIdx = view.sort.findIndex((s) => s.column === c.meta.name);
      const label = typeLabel(c.meta);
      return {
        key: c.meta.name,
        name: c.meta.name,
        kind: c.kind,
        typeLabel: c.fk ? `${label} → ${c.fk.refTable}` : label,
        primaryKey: c.primaryKey,
        sort: sortIdx === -1 ? null : { dir: view.sort[sortIdx]!.dir, position: sortIdx + 1, of: view.sort.length },
      };
    });
  }, [columns, view.sort]);

  const followForeignKey = useCallback(
    (fk: ForeignKey, row: readonly CellValue[]) => {
      const target = foreignKeyTarget(fk, rowObject(row), () => crypto.randomUUID());
      if (!target) return;
      updateTableView(sid, tableKey(target.table), (s) => ({ ...s, chips: target.chips, where: '', page: 0 }));
      openTable(target.table);
    },
    [rowObject, sid, openTable],
  );

  const getRowMeta = useCallback(
    (i: number): GridRowMeta => {
      if (i < serverRows.length) {
        const rk = rowKeys[i];
        const status =
          rk !== undefined && deleted.has(rk) ? 'delete' : rk !== undefined && updatesByKey.has(rk) ? 'update' : null;
        return { key: rk ?? `row:${offset + i}`, label: String(offset + i + 1), status };
      }
      const ins = stage.inserts[i - serverRows.length]!;
      return { key: `new:${ins.id}`, label: 'new', status: 'insert' };
    },
    [serverRows.length, rowKeys, deleted, updatesByKey, offset, stage.inserts],
  );

  const getCell = useCallback(
    (i: number, c: number): GridCell => {
      const col = columns[c]!;
      const name = col.meta.name;
      const err = stage.error;
      if (i < serverRows.length) {
        const row = serverRows[i]!;
        const original = row[c] ?? null;
        const rk = rowKeys[i];
        const upd = rk === undefined ? undefined : updatesByKey.get(rk);
        const changed = !!upd && name in upd.set;
        const cell: GridCell = changed ? { value: upd.set[name]!, changed: true, was: original } : { value: original };
        if (err?.target && rk !== undefined) {
          const t = err.target;
          const hit =
            (t.type === 'update' && t.rowKey === rk && t.column === name) ||
            (t.type === 'delete' && t.rowKey === rk && c === 0);
          if (hit) cell.error = `${err.code} ${err.message}`;
        }
        if (col.fk && !changed && original !== null) {
          const fk = col.fk;
          cell.link = { label: `Open ${fk.refTable} ${original}`, onOpen: () => followForeignKey(fk, row) };
        }
        return cell;
      }
      const ins = stage.inserts[i - serverRows.length]!;
      const cell: GridCell = { value: name in ins.values ? ins.values[name]! : undefined };
      if (err?.target?.type === 'insert' && err.target.id === ins.id && (err.column ? err.column === name : c === 0)) {
        cell.error = `${err.code} ${err.message}`;
      }
      return cell;
    },
    [columns, serverRows, rowKeys, updatesByKey, stage, followForeignKey],
  );

  const canEdit = useCallback(
    (pos: CellPos) => {
      if (!canEditTable) return false;
      const col = columns[pos.col];
      if (!col?.updatable) return false;
      if (pos.row >= serverRows.length) return true;
      const rk = rowKeys[pos.row];
      return rk !== undefined && !deleted.has(rk);
    },
    [canEditTable, columns, serverRows.length, rowKeys, deleted],
  );

  // ---- editing ----------------------------------------------------------------------
  const applyEdit = (pos: CellPos, result: EditResult) => {
    const col = columns[pos.col]!;
    if (pos.row >= serverRows.length) {
      const ins = stage.inserts[pos.row - serverRows.length]!;
      dispatch({
        type: 'setInsertCell',
        id: ins.id,
        column: col.meta.name,
        value: result.type === 'default' ? undefined : result.value,
      });
      return;
    }
    if (result.type === 'default') return;
    const row = serverRows[pos.row]!;
    const rk = rowKeys[pos.row]!;
    const keyValues = Object.fromEntries(pkNames.map((p) => [p, row[colIndex.get(p)!] ?? null]));
    dispatch({
      type: 'setCell',
      rowKey: rk,
      key: keyValues,
      column: col.meta.name,
      value: result.value,
      original: row[pos.col] ?? null,
    });
  };

  const finishEdit = (pos: CellPos, result: EditResult, advance: EditAdvance) => {
    applyEdit(pos, result);
    setEditing(null);
    if (advance !== 0) {
      setSelection(tabSelection({ anchor: pos, focus: pos }, advance < 0, { rows: rowCount, cols: columns.length }));
    }
  };

  const revertCell = (pos: CellPos) => {
    const rk = rowKeys[pos.row];
    if (rk !== undefined) dispatch({ type: 'revertCell', rowKey: rk, column: columns[pos.col]!.meta.name });
    setEditing(null);
  };

  const renderEditor = (pos: CellPos) => {
    const col = columns[pos.col];
    if (!col) return null;
    const cell = getCell(pos.row, pos.col);
    const isInsert = pos.row >= serverRows.length;
    return (
      <CellEditor
        key={`${pos.row}:${pos.col}`}
        column={{
          name: col.meta.name,
          kind: col.kind,
          typeName: col.meta.typeName,
          typeLabel: typeLabel(col.meta),
          nullable: col.schema?.nullable ?? true,
          enumValues: col.enumValues,
        }}
        value={cell.value}
        isInsert={isInsert}
        onSubmit={(result, advance) => finishEdit(pos, result, advance)}
        onCancel={() => setEditing(null)}
        onRevert={cell.changed ? () => revertCell(pos) : undefined}
      />
    );
  };

  const addRow = () => {
    const id = crypto.randomUUID();
    const row = rowCount;
    dispatch({ type: 'addInsert', id });
    // Start on the first column that has no default to fall back on.
    const first = columns.findIndex((c) => c.updatable && !c.schema?.default && !c.schema?.identity && !c.primaryKey);
    const pos = { row, col: Math.max(0, first) };
    setSelection({ anchor: pos, focus: pos });
  };

  const rowsInSelection = selection ? selectedRows(selection, columns.length) : [];
  const selectedServerKeys = rowsInSelection
    .filter((r) => r < serverRows.length)
    .map((r) => rowKeys[r])
    .filter((k): k is string => k !== undefined);
  const allSelectedDeleted =
    selectedServerKeys.length > 0 &&
    selectedServerKeys.every((k) => deleted.has(k)) &&
    rowsInSelection.every((r) => r < serverRows.length);

  const deleteRows = (rows: number[]) => {
    if (!canEditTable || rows.length === 0) return;
    const keys = rows.filter((r) => r < serverRows.length).map((r) => rowKeys[r]!);
    if (keys.length > 0 && keys.every((k) => deleted.has(k)) && rows.every((r) => r < serverRows.length)) {
      dispatch({ type: 'restoreRows', rowKeys: keys });
      return;
    }
    const toDelete = rows
      .filter((r) => r < serverRows.length && !deleted.has(rowKeys[r]!))
      .map((r) => {
        const row = serverRows[r]!;
        return {
          rowKey: rowKeys[r]!,
          key: Object.fromEntries(pkNames.map((p) => [p, row[colIndex.get(p)!] ?? null])),
        };
      });
    if (toDelete.length > 0) dispatch({ type: 'deleteRows', rows: toDelete });
    const insertIds = rows.filter((r) => r >= serverRows.length).map((r) => stage.inserts[r - serverRows.length]!.id);
    if (insertIds.length > 0) {
      dispatch({ type: 'removeInserts', ids: insertIds });
      setSelection(null);
    }
  };

  // ---- commit -------------------------------------------------------------------------
  const commit = useMutation({
    mutationFn: async () => {
      const built = buildEdits(stage, table);
      try {
        return await api.applyEdits(sid, built.edits);
      } catch (err) {
        throw Object.assign(err instanceof Error ? err : new Error(String(err)), { targets: built.targets });
      }
    },
    onSuccess: (result) => {
      dispatch({ type: 'discard' });
      setSelection(null);
      toast.success(`Committed ${result.applied} change${result.applied === 1 ? '' : 's'}`);
      void queryClient.invalidateQueries({ queryKey: ['rows', sid] });
      void queryClient.invalidateQueries({ queryKey: ['count', sid] });
    },
    onError: (err: Error & { targets?: StageTarget[] }) => {
      const body = err instanceof ApiError ? err.body : { code: 'KLEOS_HTTP', message: errorText(err) };
      const targets = err.targets ?? [];
      dispatch({ type: 'commitFailed', error: body, targets });
      // Jump to the failing cell when it is on this page.
      const target = body.editIndex === undefined ? undefined : targets[body.editIndex];
      const pos = target ? cellOfTarget(target, body.column) : null;
      if (pos) setSelection({ anchor: pos, focus: pos });
    },
  });
  const commitNow = commit.mutate;
  const committing = commit.isPending;

  function cellOfTarget(t: StageTarget, column: string | undefined): CellPos | null {
    const col = column ?? (t.type === 'update' ? t.column : undefined);
    const c = col === undefined ? 0 : (colIndex.get(col) ?? 0);
    if (t.type === 'insert') {
      const idx = stage.inserts.findIndex((i) => i.id === t.id);
      return idx === -1 ? null : { row: serverRows.length + idx, col: c };
    }
    const row = rowKeys.indexOf(t.rowKey);
    return row === -1 ? null : { row, col: c };
  }

  useEffect(() => {
    if (!active) return;
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 's') {
        e.preventDefault();
        if (counts.total > 0 && !committing) commitNow();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [active, counts.total, committing, commitNow]);

  // ---- view changes ---------------------------------------------------------------
  const setPage = (p: number) => {
    setSelection(null);
    setEditing(null);
    update((s) => ({ ...s, page: Math.max(0, p) }));
  };
  const onHeaderClick = (c: number, { shiftKey }: { shiftKey: boolean }) => {
    const name = columns[c]?.meta.name;
    if (!name) return;
    setSelection(null);
    update((s) => ({ ...s, sort: nextSort(s.sort, name, shiftKey), page: 0 }));
  };
  const setChips = (chips: FilterChip[]) => {
    setSelection(null);
    update((s) => ({ ...s, chips, page: 0 }));
  };
  const setWhere = (w: string) => {
    setSelection(null);
    update((s) => ({ ...s, where: w, page: 0 }));
  };

  const reload = () => {
    void rowsQuery.refetch();
    void estimate.refetch();
    if (exactFor === countKey) void exact.refetch();
  };

  // ---- footer numbers -----------------------------------------------------------------
  const exactCount = exactFor === countKey ? exact.data?.count : undefined;
  const total = exactCount ?? estimate.data?.count;
  const totalPages = page && !page.hasMore ? String(view.page + 1) : total ? pageCount(total) : null;
  const firstRow = serverRows.length === 0 ? 0 : offset + 1;
  const lastRow = offset + serverRows.length;

  // ---- inspector --------------------------------------------------------------------
  const focus = selection?.focus;
  const focusCol = focus ? columns[focus.col] : undefined;
  const inspector =
    inspectorOpen && focus && focusCol && focus.row < rowCount ? (
      <ValueInspector
        key={`${focus.row}:${focus.col}`}
        columnName={focusCol.meta.name}
        subtitle={inspectorSubtitle(focusCol, focus.row, serverRows, pkNames, colIndex, offset)}
        kind={focusCol.kind}
        value={getCell(focus.row, focus.col).value}
        onClose={() => setInspectorOpen(false)}
        actions={
          canEdit(focus) ? (
            <>
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="h-7 text-xs"
                onClick={() => setEditing(focus)}
              >
                Edit{focusCol.kind === 'json' ? ' JSON' : ''}
              </Button>
              {(focusCol.schema?.nullable ?? true) && (
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  className="h-7 text-xs"
                  onClick={() => applyEdit(focus, { type: 'value', value: null })}
                >
                  Set null
                </Button>
              )}
              {focus.row >= serverRows.length && (
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  className="h-7 text-xs"
                  onClick={() => applyEdit(focus, { type: 'default' })}
                >
                  Set default
                </Button>
              )}
            </>
          ) : undefined
        }
      />
    ) : null;

  const contextMenuExtra = (pos: CellPos) => {
    const col = columns[pos.col];
    if (!col) return null;
    const value = getCell(pos.row, pos.col).value;
    return (
      <>
        {value !== undefined && (
          <ContextMenuItem
            onSelect={() =>
              setChips([
                ...view.chips,
                value === null
                  ? { id: crypto.randomUUID(), column: col.meta.name, op: 'isNull', value: '' }
                  : { id: crypto.randomUUID(), column: col.meta.name, op: 'eq', value },
              ])
            }
          >
            Filter {col.meta.name} {value === null ? 'is null' : '= this value'}
          </ContextMenuItem>
        )}
        {canEdit(pos) && <ContextMenuItem onSelect={() => setEditing(pos)}>Edit cell</ContextMenuItem>}
        {canEdit(pos) && (col.schema?.nullable ?? true) && (
          <ContextMenuItem onSelect={() => applyEdit(pos, { type: 'value', value: null })}>Set null</ContextMenuItem>
        )}
        {canEditTable && (
          <ContextMenuItem variant="destructive" onSelect={() => deleteRows(selection ? rowsInSelection : [pos.row])}>
            {allSelectedDeleted ? 'Restore rows' : 'Delete rows'}
          </ContextMenuItem>
        )}
      </>
    );
  };

  const errorLocation = (() => {
    const err = stage.error;
    if (!err?.target) return err?.column ?? null;
    const t = err.target;
    if (t.type === 'insert') return `New row${err.column ? ` · ${err.column}` : ''}`;
    const keyText = (JSON.parse(t.rowKey) as CellValue[]).map((v) => v ?? 'NULL').join(', ');
    return `Row ${keyText}${err.column ? ` · ${err.column}` : ''}`;
  })();

  const loading = rowsQuery.isPending;
  const failed = rowsQuery.isError;

  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col">
      <div className="flex flex-wrap items-center gap-3 border-b px-4 py-2.5">
        <div className="flex items-center gap-1.5 text-[13px]">
          <span className="text-muted-foreground">{table.schema}</span>
          <span className="text-muted-foreground">/</span>
          <b className="font-semibold">{table.name}</b>
        </div>
        {blockReason && (
          <span className="text-muted-foreground inline-flex items-center gap-1.5 text-xs" role="note">
            <Lock className="size-3.5" aria-hidden="true" />
            {blockReason}
          </span>
        )}
        <span className="flex-1" />
        {canEditTable && (
          <>
            <Button type="button" variant="outline" size="sm" onClick={addRow}>
              <Plus aria-hidden="true" />
              Add row
            </Button>
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  disabled={rowsInSelection.length === 0}
                  onClick={() => deleteRows(rowsInSelection)}
                >
                  {allSelectedDeleted ? <Undo2 aria-hidden="true" /> : <Trash aria-hidden="true" />}
                  {allSelectedDeleted ? 'Restore' : 'Delete'}
                </Button>
              </TooltipTrigger>
              <TooltipContent>
                {allSelectedDeleted ? 'Restore the selected rows' : 'Stage deleting the selected rows'} (⌫ on a row
                selection)
              </TooltipContent>
            </Tooltip>
          </>
        )}
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              type="button"
              variant="outline"
              size="icon-sm"
              aria-label={inspectorOpen ? 'Hide value panel' : 'Show value panel'}
              aria-pressed={inspectorOpen}
              onClick={() => setInspectorOpen((o) => !o)}
            >
              <PanelRight aria-hidden="true" />
            </Button>
          </TooltipTrigger>
          <TooltipContent>Value panel</TooltipContent>
        </Tooltip>
        <Tooltip>
          <TooltipTrigger asChild>
            <Button type="button" variant="outline" size="icon-sm" aria-label="Reload rows" onClick={reload}>
              <RefreshCw className={rowsQuery.isFetching ? 'animate-spin' : undefined} aria-hidden="true" />
            </Button>
          </TooltipTrigger>
          <TooltipContent>Reload rows (staged edits are kept)</TooltipContent>
        </Tooltip>
      </div>

      <FilterBar
        columns={columns.map((c) => ({ name: c.meta.name, kind: c.kind }))}
        chips={view.chips}
        onChipsChange={setChips}
        where={view.where}
        onWhereChange={setWhere}
      />

      <div className="flex min-h-0 flex-1">
        {failed ? (
          <div className="flex-1 p-4">
            <div
              role="alert"
              className="bg-error-bg border-error-line flex flex-col gap-1 rounded-lg border px-3.5 py-3"
            >
              <b className="font-semibold">Couldn’t load rows</b>
              <span className="font-mono text-xs">{errorText(rowsQuery.error)}</span>
              {rowsQuery.error instanceof ApiError && rowsQuery.error.body.hint && (
                <span className="text-muted-foreground text-xs">Hint: {rowsQuery.error.body.hint}</span>
              )}
            </div>
          </div>
        ) : loading && columns.length === 0 ? (
          <div className="flex flex-1 flex-col gap-2 p-4" aria-busy="true" aria-label="Loading rows">
            {Array.from({ length: 8 }, (_, i) => (
              <Skeleton key={i} className="h-6 w-full" />
            ))}
          </div>
        ) : (
          <DataGrid
            columns={gridColumns}
            rowCount={rowCount}
            getRowMeta={getRowMeta}
            getCell={getCell}
            selection={selection}
            onSelectionChange={(s) => {
              setSelection(s);
              setEditing(null);
            }}
            ariaLabel={`${table.name} rows`}
            onHeaderClick={onHeaderClick}
            headerClickHint="Sort (Shift-click to add to the sort)"
            canEdit={canEdit}
            editing={editing}
            onEditRequest={setEditing}
            renderEditor={renderEditor}
            onDeleteRows={canEditTable ? deleteRows : undefined}
            contextMenuExtra={contextMenuExtra}
            className={rowsQuery.isPlaceholderData ? 'opacity-60' : undefined}
            emptyState={
              loading
                ? 'Loading rows…'
                : view.chips.length > 0 || where
                  ? 'No rows match these filters.'
                  : 'This table is empty.'
            }
          />
        )}
        {inspector}
      </div>

      {(counts.total > 0 || stage.error) && (
        <PendingPanel
          counts={counts}
          sql={renderPendingSql(stage, table, typeInfo)}
          error={stage.error}
          errorLocation={errorLocation}
          committing={committing}
          onDiscard={() => {
            dispatch({ type: 'discard' });
            setEditing(null);
          }}
          onCommit={() => commitNow()}
        />
      )}

      <footer className="flex flex-wrap items-center gap-3 border-t px-4 py-2 text-xs">
        <span>
          Rows {groupDigits(String(firstRow))}–{groupDigits(String(lastRow))}
          {total && !total.startsWith('-') ? (
            <>
              {' '}
              of <span className="font-mono">
                {exactCount ? groupDigits(exactCount) : `~${groupDigits(total)}`}
              </span>{' '}
              <span className="text-muted-foreground">{exactCount ? '(exact)' : '(planner estimate)'}</span>
            </>
          ) : estimate.isPending ? (
            <span className="text-muted-foreground"> · estimating…</span>
          ) : null}
        </span>
        {!exactCount && (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="h-7 px-1 underline underline-offset-[3px]"
            disabled={exact.isFetching}
            onClick={() => setExactFor(countKey)}
          >
            {exact.isFetching ? 'Counting…' : 'Count exactly'}
          </Button>
        )}
        {exact.isError && exactFor === countKey && <span className="text-destructive">{errorText(exact.error)}</span>}
        <span className="flex-1" />
        <span className="text-muted-foreground">{PAGE_SIZE} per page</span>
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              type="button"
              variant="outline"
              size="icon-sm"
              className="size-7"
              aria-label="Previous page"
              disabled={view.page === 0}
              onClick={() => setPage(view.page - 1)}
            >
              <ChevronLeft aria-hidden="true" />
            </Button>
          </TooltipTrigger>
          <TooltipContent>Previous page</TooltipContent>
        </Tooltip>
        <span className="font-mono" aria-label={`Page ${view.page + 1}${totalPages ? ` of ${totalPages}` : ''}`}>
          {groupDigits(String(view.page + 1))}
          {totalPages ? ` / ${groupDigits(totalPages)}` : ''}
        </span>
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              type="button"
              variant="outline"
              size="icon-sm"
              className="size-7"
              aria-label="Next page"
              disabled={!page?.hasMore}
              onClick={() => setPage(view.page + 1)}
            >
              <ChevronRight aria-hidden="true" />
            </Button>
          </TooltipTrigger>
          <TooltipContent>Next page</TooltipContent>
        </Tooltip>
      </footer>
      <span className="sr-only" aria-live="polite">
        {counts.total > 0
          ? `${counts.total} staged change${counts.total === 1 ? '' : 's'}; ${isMac ? '⌘S' : 'Ctrl+S'} commits`
          : ''}
      </span>
    </div>
  );
}

function inspectorSubtitle(
  col: DataColumn,
  row: number,
  serverRows: readonly (readonly CellValue[])[],
  pk: readonly string[],
  colIndex: Map<string, number>,
  offset: number,
): string {
  const type = typeLabel(col.meta);
  if (row >= serverRows.length) return `${type} · new row`;
  const values = serverRows[row]!;
  if (pk.length === 1) {
    const v = values[colIndex.get(pk[0]!) ?? -1];
    if (v !== undefined) return `${type} · row ${pk[0]} ${v ?? 'NULL'}`;
  }
  return `${type} · row ${offset + row + 1}`;
}
