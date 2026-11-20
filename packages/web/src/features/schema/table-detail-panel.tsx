import type { Column, Constraint, ForeignKey, Index, Table, TableRef } from '@kleos/shared';
import { ArrowRight, ArrowUpRight, Code, Eye, KeyRound, Plus, Table2, X } from 'lucide-react';
import type { ReactNode } from 'react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { sectionLabel } from '@/features/common/styles';
import { describeChange } from '@/features/schema-edit/describe';
import type { ColumnView } from '@/features/schema-edit/overlay';
import { TableEditDialogs } from '@/features/schema-edit/table-edit-dialogs';
import {
  AddButton,
  ColumnActions,
  IndexAction,
  StagedBadge,
  stagedTitle,
  TableActions,
  useTableEditing,
} from '@/features/schema-edit/table-editing';
import { useWorkspace } from '@/features/workspace/context';
import { formatBytes, formatInt } from '@/lib/format';
import { cn } from '@/lib/utils';
import { shortType } from './er-model';

type Props = {
  table: Table;
  foreignKeys: ForeignKey[];
  onClose(): void;
  onOpenTable(ref: TableRef): void;
  onViewData(): void;
  onOpenInQuery(): void;
};

/** "~1,204,380 rows (estimate) · 412 MB · 6 columns" */
export function relationSummary(table: Table): string {
  const parts: string[] = [];
  if (table.kind === 'view') parts.push('View');
  else if (table.kind === 'materialized') parts.push('Materialized view');
  if (table.kind !== 'view') {
    parts.push(table.rowEstimate < 0 ? 'never analyzed' : `~${formatInt(table.rowEstimate)} rows (estimate)`);
    parts.push(formatBytes(table.totalBytes));
  }
  parts.push(`${table.columns.length} ${table.columns.length === 1 ? 'column' : 'columns'}`);
  return parts.join(' · ');
}

/** "int8 · identity", "order_status · 'pending'::order_status", "timestamptz · now()" */
export function columnDetail(column: Column): string {
  const parts = [shortType(column.type)];
  if (column.identity) parts.push(column.identity === 'always' ? 'identity always' : 'identity');
  else if (column.generated) parts.push('generated');
  else if (column.default !== null) parts.push(column.default);
  return parts.join(' · ');
}

/** "btree (id) unique", from the index's own fields; the full definition is in the title. */
export function indexSummary(index: Index): string {
  return `${index.method} (${index.columns.join(', ')})${index.primary ? ' primary' : index.unique ? ' unique' : ''}`;
}

const constraintLabel: Record<Constraint['type'], string> = {
  p: 'primary key',
  f: 'foreign key',
  u: 'unique',
  c: 'check',
  x: 'exclusion',
  t: 'trigger',
  n: 'not null',
};

/** "text · 'draft'" for a column as it will be once the staged changes run. */
function stagedColumnDetail(view: ColumnView): string {
  const original = view.original;
  const retyped = view.changes.some((s) => s.change.op === 'alterColumnType' || s.change.op === 'setDefault');
  if (original && !retyped) return columnDetail(original);
  const parts = [shortType(view.type)];
  if (original?.identity) parts.push(original.identity === 'always' ? 'identity always' : 'identity');
  else if (original?.generated) parts.push('generated');
  else if (view.default !== null) parts.push(view.default);
  return parts.join(' · ');
}

/**
 * Right-side panel for the selected table or view: columns, indexes, constraints, and actions.
 * On a writable table it also stages schema changes (0.6): per-row menus, "+" on the Columns and
 * Indexes titles, and the table menu in the header. Staged changes show inline: a ghost row for
 * an added column or index, "pending" on an altered column, "drop" on a dropped one.
 */
export function TableDetailPanel({ table, foreignKeys, onClose, onOpenTable, onViewData, onOpenInQuery }: Props) {
  const { readOnly } = useWorkspace();
  const editing = useTableEditing(table);
  const { overlay, editable, actions, openDialog } = editing;
  const ownFks = foreignKeys.filter((fk) => fk.schema === table.schema && fk.table === table.name);
  const refOf = (column: string) => {
    for (const fk of ownFks) {
      const i = fk.columns.indexOf(column);
      if (i >= 0) return { schema: fk.refSchema, name: fk.refTable, column: fk.refColumns[i] ?? '' };
    }
    return null;
  };
  const liveColumns = overlay.columns.filter((c) => !c.dropped).length;
  const renamedTo = overlay.renamedBy.length > 0 ? overlay.ref.name : null;
  const ghostRow = 'bg-staged-insert/45 hover:bg-staged-insert/60 dark:hover:bg-staged-insert/60';

  return (
    <aside
      aria-label="Table details"
      className="bg-background animate-in fade-in-0 slide-in-from-right-2 flex w-[340px] shrink-0 flex-col border-l duration-200"
    >
      <div className="flex flex-col gap-2 border-b p-4">
        <div className="flex items-center gap-2.5">
          <span className="bg-brand-soft text-brand-text flex size-7 shrink-0 items-center justify-center rounded-lg">
            {table.kind === 'view' || table.kind === 'materialized' ? (
              <Eye className="size-3.5" aria-hidden="true" />
            ) : (
              <Table2 className="size-3.5" aria-hidden="true" />
            )}
          </span>
          <h2
            className={cn(
              'truncate text-[15px] font-semibold tracking-[-0.012em]',
              overlay.dropped && 'text-muted-foreground line-through',
            )}
          >
            {table.name}
          </h2>
          <Badge variant="outline" className="h-5 font-mono text-[11px]">
            {table.schema}
          </Badge>
          <span className="ml-auto flex shrink-0 items-center gap-0.5">
            {editable && <TableActions editing={editing} />}
            <Button
              variant="ghost"
              size="icon-sm"
              className="text-muted-foreground"
              aria-label="Close details"
              title="Close (Esc)"
              onClick={onClose}
            >
              <X aria-hidden="true" />
            </Button>
          </span>
        </div>
        {renamedTo && (
          <span className="flex items-center gap-1.5 text-xs">
            <StagedBadge kind="pending" />
            <span className="text-muted-foreground">Renamed to</span>
            <span className="truncate font-mono">{renamedTo}</span>
          </span>
        )}
        <span className="text-muted-foreground tabular text-xs">{relationSummary(table)}</span>
        {table.comment && (
          <p className="text-muted-foreground border-border border-l-2 pl-2 text-xs italic">{table.comment}</p>
        )}
        {overlay.dropped && (
          <div className="bg-staged-delete text-staged-delete-foreground flex items-center gap-2 rounded-lg px-2.5 py-1.5 text-xs">
            <span className="flex-1">Staged to be dropped when you apply.</span>
            {!readOnly && (
              <Button
                type="button"
                variant="outline"
                size="xs"
                onClick={() => overlay.dropped && actions.remove(overlay.dropped.id)}
              >
                Keep table
              </Button>
            )}
          </div>
        )}
      </div>

      <div className="flex min-h-0 flex-1 flex-col overflow-y-auto px-4 pt-1 pb-4">
        <SectionTitle
          count={liveColumns}
          action={editable && <AddButton label="Add column" onClick={() => openDialog({ kind: 'addColumn' })} />}
        >
          Columns
        </SectionTitle>
        {overlay.columns.map((view) => {
          const column = view.original;
          const isPk = !!column && table.primaryKey.includes(column.name);
          const ref = column && !view.dropped ? refOf(column.name) : null;
          const detail = stagedColumnDetail(view);
          return (
            <Row key={view.key} className={cn(view.addedBy && ghostRow)}>
              {isPk ? (
                <KeyRound className="text-primary-key size-3 shrink-0" role="img" aria-label="Primary key" />
              ) : ref ? (
                <ArrowUpRight className="text-brand-text size-3 shrink-0" role="img" aria-label="Foreign key" />
              ) : view.addedBy ? (
                <Plus className="text-staged-insert-foreground size-3 shrink-0" aria-hidden="true" />
              ) : (
                <span className="w-3 shrink-0" />
              )}
              <span
                className={cn(
                  'truncate',
                  isPk && 'font-semibold',
                  view.dropped && 'text-muted-foreground line-through',
                )}
                title={column && view.name !== column.name ? `Was ${column.name}` : undefined}
              >
                {view.name}
              </span>
              {view.addedBy ? (
                <StagedBadge kind="new" title={describeChange(view.addedBy.change)} />
              ) : view.dropped ? (
                <StagedBadge kind="drop" title={describeChange(view.dropped.change)} />
              ) : view.changes.length > 0 ? (
                <StagedBadge kind="pending" title={stagedTitle(view)} />
              ) : null}
              {view.nullable && !view.dropped && (
                <Badge variant="outline" className="text-muted-foreground h-[18px] px-1.5 text-[10px] font-medium">
                  nullable
                </Badge>
              )}
              {ref ? (
                <button
                  type="button"
                  className="text-brand-text hover:bg-brand-soft -mr-1 ml-auto shrink-0 truncate rounded-[4px] px-1 font-mono text-[11px] underline-offset-2 hover:underline"
                  title={`${detail} — open ${ref.schema}.${ref.name}`}
                  onClick={() => onOpenTable({ schema: ref.schema, name: ref.name })}
                >
                  → {ref.schema === table.schema ? '' : `${ref.schema}.`}
                  {ref.name}.{ref.column}
                </button>
              ) : (
                <span
                  className="text-muted-foreground ml-auto max-w-[60%] shrink-0 truncate font-mono text-[11px]"
                  title={detail}
                >
                  {detail}
                </span>
              )}
              {editable && <ColumnActions column={view} isPrimaryKey={isPk} editing={editing} />}
            </Row>
          );
        })}

        {(overlay.indexes.length > 0 || editable) && (
          <>
            <SectionTitle
              count={overlay.indexes.filter((i) => !i.dropped).length}
              action={editable && <AddButton label="Add index" onClick={() => openDialog({ kind: 'addIndex' })} />}
            >
              Indexes
            </SectionTitle>
            {overlay.indexes.length === 0 && <p className="text-muted-foreground py-1.5 text-xs">No indexes.</p>}
            {overlay.indexes.map((index) => (
              <Row key={index.key} className={cn('font-mono text-[11.5px]', index.addedBy && ghostRow)}>
                <span
                  className={cn(
                    'truncate',
                    !index.name && 'text-muted-foreground font-sans italic',
                    index.dropped && 'text-muted-foreground line-through',
                  )}
                  title={index.original?.definition}
                >
                  {index.name ?? 'name generated by Postgres'}
                </span>
                {index.addedBy && <StagedBadge kind="new" title={describeChange(index.addedBy.change)} />}
                {index.dropped && <StagedBadge kind="drop" title={describeChange(index.dropped.change)} />}
                <span className="text-muted-foreground ml-auto shrink-0">
                  {index.original
                    ? indexSummary(index.original)
                    : `${index.method} (${index.columns.join(', ')})${index.unique ? ' unique' : ''}`}
                </span>
                {editable && <IndexAction index={index} table={table} editing={editing} />}
              </Row>
            ))}
          </>
        )}

        {table.constraints.length > 0 && (
          <>
            <SectionTitle count={table.constraints.length}>Constraints</SectionTitle>
            {table.constraints.map((c) => (
              <Row key={c.name} className="flex-col items-start gap-0.5">
                <span className="flex w-full items-center gap-2">
                  <span className="truncate font-mono text-[11.5px]">{c.name}</span>
                  <span className="text-muted-foreground ml-auto shrink-0 text-[11px]">{constraintLabel[c.type]}</span>
                </span>
                <span className="text-muted-foreground font-mono text-[11px] break-all whitespace-normal select-text">
                  {c.definition}
                </span>
              </Row>
            ))}
          </>
        )}
      </div>

      <div className="bg-sidebar/60 flex gap-2 border-t px-4 py-3">
        <Button className="flex-1" onClick={onViewData}>
          View data
          <ArrowRight aria-hidden="true" />
        </Button>
        <Button variant="outline" onClick={onOpenInQuery}>
          <Code aria-hidden="true" />
          Open in query
        </Button>
      </div>

      <TableEditDialogs
        dialog={editing.dialog}
        onClose={() => openDialog(null)}
        table={table}
        overlay={overlay}
        actions={actions}
      />
    </aside>
  );
}

function SectionTitle({ children, count, action }: { children: ReactNode; count?: number; action?: ReactNode }) {
  return (
    <h3 className={cn(sectionLabel, 'mt-5 mb-1 flex items-center gap-2 first:mt-3.5')}>
      {children}
      {count !== undefined && <span className="ml-auto font-mono font-medium tracking-normal">{count}</span>}
      {action}
    </h3>
  );
}

function Row({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <div
      className={cn(
        'group/row hover:bg-foreground/[0.025] -mx-2 flex items-center gap-2 border-b px-2 py-[7px] text-xs dark:hover:bg-white/[0.03]',
        className,
      )}
    >
      {children}
    </div>
  );
}
