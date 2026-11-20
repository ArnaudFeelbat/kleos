import type { Table } from '@kleos/shared';
import { Ellipsis, Plus, Trash, Undo2, X } from 'lucide-react';
import { useMemo, useState } from 'react';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { useWorkspace } from '@/features/workspace/context';
import { cn } from '@/lib/utils';
import { describeChange } from './describe';
import { stagedOn, tableOverlay, type ColumnView, type IndexView, type TableOverlay } from './overlay';
import { useSchemaEdit, type SchemaEditActions } from './store';
import type { EditDialog } from './table-edit-dialogs';

export type TableEditing = {
  /** False on read-only sessions and for views: no editing controls at all. */
  editable: boolean;
  overlay: TableOverlay;
  actions: SchemaEditActions;
  dialog: EditDialog | null;
  openDialog(dialog: EditDialog | null): void;
};

/** The selected table with its staged changes laid over it, and what the panel may offer. */
export function useTableEditing(table: Table): TableEditing {
  const { sid, readOnly } = useWorkspace();
  const [state, actions] = useSchemaEdit(sid);
  const overlay = useMemo(() => tableOverlay(table, state.changes), [table, state.changes]);
  const [dialog, openDialog] = useState<EditDialog | null>(null);
  const editable = !readOnly && (table.kind === 'table' || table.kind === 'partitioned') && !overlay.dropped;
  return { editable, overlay, actions, dialog, openDialog };
}

const pill =
  'inline-flex h-[18px] shrink-0 items-center rounded-full px-1.5 text-[10px] font-medium shadow-[inset_0_0_0_1px_color-mix(in_srgb,currentColor_22%,transparent)]';

/** A staged state on a row: "new", "pending" (renamed or altered) or "drop". The title lists the changes. */
export function StagedBadge({ kind, title }: { kind: 'new' | 'pending' | 'drop'; title?: string }) {
  return (
    <span
      title={title}
      className={cn(
        pill,
        kind === 'new' && 'bg-staged-insert text-staged-insert-foreground',
        kind === 'pending' && 'bg-staged-update text-staged-update-foreground',
        kind === 'drop' && 'bg-staged-delete text-staged-delete-foreground',
      )}
    >
      {kind}
    </span>
  );
}

export function stagedTitle(column: ColumnView): string {
  return column.changes.map((s) => describeChange(s.change)).join('\n');
}

const menuButton =
  'text-muted-foreground -my-1 -mr-1 opacity-0 group-hover/row:opacity-100 group-focus-within/row:opacity-100 focus-visible:opacity-100 data-[state=open]:opacity-100';

/** "⋯" on a column row: rename, type, NULL, default, drop — or undo for staged rows. */
export function ColumnActions({
  column,
  isPrimaryKey,
  editing,
}: {
  column: ColumnView;
  isPrimaryKey: boolean;
  editing: TableEditing;
}) {
  const { actions, openDialog, overlay } = editing;
  const label = `Actions for column ${column.name}`;
  const trigger = (
    <DropdownMenuTrigger asChild>
      <Button type="button" variant="ghost" size="icon-xs" className={menuButton} aria-label={label}>
        <Ellipsis aria-hidden="true" />
      </Button>
    </DropdownMenuTrigger>
  );

  if (column.addedBy) {
    const added = column.addedBy;
    return (
      <DropdownMenu>
        {trigger}
        <DropdownMenuContent align="end">
          <DropdownMenuItem onSelect={() => openDialog({ kind: 'addColumn', editing: added })}>
            Edit new column…
          </DropdownMenuItem>
          <DropdownMenuItem onSelect={() => actions.remove(added.id)}>Remove from pending changes</DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    );
  }
  if (column.dropped) {
    const dropped = column.dropped;
    return (
      <DropdownMenu>
        {trigger}
        <DropdownMenuContent align="end">
          <DropdownMenuItem onSelect={() => actions.remove(dropped.id)}>Keep column</DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    );
  }

  const nullStaged = stagedOn(column, 'setNotNull');
  const automatic = !!column.original && (column.original.identity !== null || column.original.generated);
  return (
    <DropdownMenu>
      {trigger}
      <DropdownMenuContent align="end" className="min-w-44">
        <DropdownMenuItem onSelect={() => openDialog({ kind: 'renameColumn', column })}>Rename…</DropdownMenuItem>
        <DropdownMenuItem onSelect={() => openDialog({ kind: 'changeType', column })}>Change type…</DropdownMenuItem>
        {!(isPrimaryKey && column.nullable === false) && (
          <DropdownMenuItem
            onSelect={() =>
              // Picking the opposite of a staged setting undoes it rather than stacking a second one.
              nullStaged
                ? actions.remove(nullStaged.id)
                : actions.stage({ op: 'setNotNull', table: overlay.ref, column: column.name, notNull: column.nullable })
            }
          >
            {column.nullable ? 'Forbid NULL' : 'Allow NULL'}
          </DropdownMenuItem>
        )}
        {!automatic && (
          <DropdownMenuItem onSelect={() => openDialog({ kind: 'setDefault', column })}>
            {column.default === null ? 'Set default…' : 'Change default…'}
          </DropdownMenuItem>
        )}
        {!automatic && column.default !== null && (
          <DropdownMenuItem
            onSelect={() => actions.stage({ op: 'setDefault', table: overlay.ref, column: column.name, default: null })}
          >
            Drop default
          </DropdownMenuItem>
        )}
        {column.changes.length > 0 && (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuItem
              onSelect={() => {
                for (const s of column.changes) actions.remove(s.id);
              }}
            >
              <Undo2 aria-hidden="true" />
              Undo staged changes
            </DropdownMenuItem>
          </>
        )}
        <DropdownMenuSeparator />
        <DropdownMenuItem variant="destructive" onSelect={() => openDialog({ kind: 'dropColumn', column })}>
          <Trash aria-hidden="true" />
          Drop column…
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/** "⋯" in the panel header: rename or drop the table. */
export function TableActions({ editing }: { editing: TableEditing }) {
  const { openDialog, overlay } = editing;
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          className="text-muted-foreground"
          aria-label={`Actions for table ${overlay.ref.name}`}
        >
          <Ellipsis aria-hidden="true" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        <DropdownMenuItem onSelect={() => openDialog({ kind: 'addColumn' })}>Add column…</DropdownMenuItem>
        <DropdownMenuItem onSelect={() => openDialog({ kind: 'addIndex' })}>Add index…</DropdownMenuItem>
        <DropdownMenuItem onSelect={() => openDialog({ kind: 'renameTable' })}>Rename table…</DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem variant="destructive" onSelect={() => openDialog({ kind: 'dropTable' })}>
          <Trash aria-hidden="true" />
          Drop table…
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/** The small "+" beside a section title (Columns, Indexes). */
export function AddButton({ label, onClick }: { label: string; onClick(): void }) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          size="icon-xs"
          className="text-muted-foreground hover:text-foreground -my-1 ml-auto"
          aria-label={label}
          onClick={onClick}
        >
          <Plus aria-hidden="true" />
        </Button>
      </TooltipTrigger>
      <TooltipContent>{label}</TooltipContent>
    </Tooltip>
  );
}

/**
 * Indexes Postgres won't drop on their own: the primary key's, and those backing a unique or
 * exclusion constraint (same name). Constraint editing is out of scope for 0.6.
 */
export function indexBacksConstraint(index: IndexView, table: Table): boolean {
  return !!index.original && (index.original.primary || table.constraints.some((c) => c.name === index.name));
}

/** Drop, keep (undo a staged drop) or remove a staged new index. */
export function IndexAction({ index, table, editing }: { index: IndexView; table: Table; editing: TableEditing }) {
  const { actions, overlay } = editing;
  const name = index.name ?? 'new index';
  let button: { label: string; tip: string; icon: typeof Trash; onClick(): void } | null = null;
  if (index.addedBy) {
    const added = index.addedBy;
    button = {
      label: `Remove new index ${name}`,
      tip: 'Remove from pending changes',
      icon: X,
      onClick: () => actions.remove(added.id),
    };
  } else if (index.dropped) {
    const dropped = index.dropped;
    button = { label: `Keep index ${name}`, tip: 'Keep index', icon: Undo2, onClick: () => actions.remove(dropped.id) };
  } else if (!indexBacksConstraint(index, table) && index.name) {
    const indexName = index.name;
    button = {
      label: `Drop index ${name}`,
      tip: 'Stage dropping this index',
      icon: Trash,
      onClick: () => actions.stage({ op: 'dropIndex', schema: overlay.ref.schema, name: indexName, cascade: false }),
    };
  }
  if (!button) return null;
  const Icon = button.icon;
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          size="icon-xs"
          className={cn(menuButton, (index.addedBy || index.dropped) && 'opacity-100')}
          aria-label={button.label}
          onClick={button.onClick}
        >
          <Icon aria-hidden="true" />
        </Button>
      </TooltipTrigger>
      <TooltipContent>{button.tip}</TooltipContent>
    </Tooltip>
  );
}
