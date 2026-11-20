import type { DdlChange } from '@kleos/shared';
import { KeyRound, Plus, X } from 'lucide-react';
import { useId, useState, type FormEvent } from 'react';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { sectionLabel } from '@/features/common/styles';
import { useWorkspace } from '@/features/workspace/context';
import { cn } from '@/lib/utils';
import { CodeInput, Field, TypeSuggestions } from './form-bits';
import {
  createTableChange,
  draftOf,
  emptyColumnDraft,
  hasErrors,
  typeSuggestions,
  validateNewTable,
  type ColumnDraft,
  type NewTableDraft,
  type NewTableErrors,
} from './model';

type CreateTable = Extract<DdlChange, { op: 'createTable' }>;

type Props = {
  open: boolean;
  onOpenChange(open: boolean): void;
  /** Schema picked when the dialog opens (the schema tab's current one). */
  defaultSchema?: string;
  /** A staged createTable to edit instead of a new one. */
  initial?: CreateTable;
  onSubmit(change: CreateTable): void;
};

/** "New table…": schema, name and a column grid; stages one createTable. */
export function NewTableDialog({ open, onOpenChange, defaultSchema, initial, onSubmit }: Props) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[760px]">
        {open && (
          <NewTableForm
            defaultSchema={defaultSchema}
            initial={initial}
            onSubmit={onSubmit}
            onCancel={() => onOpenChange(false)}
          />
        )}
      </DialogContent>
    </Dialog>
  );
}

function NewTableForm({
  defaultSchema,
  initial,
  onSubmit,
  onCancel,
}: Pick<Props, 'defaultSchema' | 'initial' | 'onSubmit'> & { onCancel(): void }) {
  const { schemaModel, currentSchema } = useWorkspace();
  const ids = useId();
  const schemas = schemaModel?.schemas ?? [];
  const [draft, setDraft] = useState<NewTableDraft>(() =>
    initial ? draftOf(initial) : { schema: defaultSchema ?? currentSchema, name: '', columns: [emptyColumnDraft()] },
  );
  // Errors show once Stage was tried, then follow every keystroke.
  const [tried, setTried] = useState(false);
  const existing = (schemaModel?.tables ?? [])
    .concat(schemaModel?.views ?? [])
    .filter((t) => t.schema === draft.schema)
    .map((t) => t.name);
  const errors = validateNewTable(draft, existing);
  const shown: NewTableErrors = tried ? errors : { rows: {} };

  const setColumn = (id: string, patch: Partial<ColumnDraft>) =>
    setDraft((d) => ({ ...d, columns: d.columns.map((c) => (c.id === id ? { ...c, ...patch } : c)) }));
  const addColumn = () => setDraft((d) => ({ ...d, columns: [...d.columns, emptyColumnDraft()] }));
  const removeColumn = (id: string) => setDraft((d) => ({ ...d, columns: d.columns.filter((c) => c.id !== id) }));

  const submit = (e: FormEvent) => {
    e.preventDefault();
    setTried(true);
    if (hasErrors(errors)) return;
    onSubmit(createTableChange(draft));
  };

  const typesId = `${ids}-types`;
  const grid = 'grid grid-cols-[minmax(0,1.1fr)_minmax(0,1.1fr)_64px_minmax(0,1fr)_40px_28px] items-center gap-x-2';

  return (
    <form onSubmit={submit} noValidate className="flex min-w-0 flex-col gap-4">
      <DialogHeader>
        <DialogTitle>{initial ? 'Edit new table' : 'New table'}</DialogTitle>
        <DialogDescription>Stages a CREATE TABLE. Nothing runs until you apply the pending changes.</DialogDescription>
      </DialogHeader>

      <div className="grid grid-cols-[180px_minmax(0,1fr)] gap-3">
        <Field id={`${ids}-schema`} label="Schema">
          <Select value={draft.schema} onValueChange={(schema) => setDraft((d) => ({ ...d, schema }))}>
            <SelectTrigger id={`${ids}-schema`} size="sm" className="w-full font-mono text-xs">
              <SelectValue />
            </SelectTrigger>
            <SelectContent position="popper">
              {(schemas.includes(draft.schema) ? schemas : [draft.schema, ...schemas]).map((s) => (
                <SelectItem key={s} value={s} className="font-mono text-xs">
                  {s}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </Field>
        <Field id={`${ids}-name`} label="Table name" error={shown.name}>
          <CodeInput
            id={`${ids}-name`}
            autoFocus
            className="h-7"
            value={draft.name}
            placeholder="e.g. invoices"
            aria-invalid={!!shown.name || undefined}
            aria-describedby={shown.name ? `${ids}-name-error` : undefined}
            onChange={(e) => setDraft((d) => ({ ...d, name: e.target.value }))}
          />
        </Field>
      </div>

      <div className="flex min-w-0 flex-col gap-1.5" role="group" aria-label="Columns">
        <div className={cn(grid, sectionLabel, 'text-[10.5px]')} aria-hidden="true">
          <span>Column</span>
          <span>Type</span>
          <span>Nullable</span>
          <span>Default</span>
          <span className="flex justify-center" title="Primary key">
            <KeyRound className="text-primary-key size-3" />
          </span>
          <span />
        </div>
        <div className="flex max-h-[42vh] flex-col gap-1.5 overflow-y-auto">
          {draft.columns.map((c, i) => {
            const n = i + 1;
            const rowErr = shown.rows[c.id];
            return (
              <div key={c.id} className="flex flex-col gap-0.5">
                <div className={grid}>
                  <CodeInput
                    aria-label={`Column ${n} name`}
                    className="h-7"
                    value={c.name}
                    aria-invalid={!!rowErr?.name || undefined}
                    onChange={(e) => setColumn(c.id, { name: e.target.value })}
                  />
                  <CodeInput
                    aria-label={`Column ${n} type`}
                    className="h-7"
                    list={typesId}
                    value={c.type}
                    placeholder="text"
                    aria-invalid={!!rowErr?.type || undefined}
                    onChange={(e) => setColumn(c.id, { type: e.target.value })}
                  />
                  <span className="flex justify-center">
                    <Checkbox
                      aria-label={`Column ${n} nullable`}
                      checked={c.primaryKey ? false : c.nullable}
                      disabled={c.primaryKey}
                      onCheckedChange={(v) => setColumn(c.id, { nullable: v === true })}
                    />
                  </span>
                  <CodeInput
                    aria-label={`Column ${n} default`}
                    className="h-7"
                    value={c.default}
                    placeholder="none"
                    onChange={(e) => setColumn(c.id, { default: e.target.value })}
                  />
                  <span className="flex justify-center">
                    <Checkbox
                      aria-label={`Column ${n} primary key`}
                      checked={c.primaryKey}
                      onCheckedChange={(v) => setColumn(c.id, { primaryKey: v === true })}
                    />
                  </span>
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon-xs"
                    className="text-muted-foreground"
                    aria-label={`Remove column ${n}`}
                    onClick={() => removeColumn(c.id)}
                  >
                    <X aria-hidden="true" />
                  </Button>
                </div>
                {(rowErr?.name || rowErr?.type) && (
                  <span className="text-destructive text-[11px]">
                    {[rowErr.name, rowErr.type].filter(Boolean).join(' ')}
                  </span>
                )}
              </div>
            );
          })}
        </div>
        <TypeSuggestions id={typesId} types={typeSuggestions(schemaModel)} />
        <div className="flex items-center gap-3">
          <Button type="button" variant="outline" size="xs" onClick={addColumn}>
            <Plus aria-hidden="true" />
            Add column
          </Button>
          {shown.columns ? (
            <span role="alert" className="text-destructive text-[11px]">
              {shown.columns}
            </span>
          ) : (
            <span className="text-muted-foreground text-[11px]">
              Primary-key columns are always NOT NULL. Empty rows are ignored.
            </span>
          )}
        </div>
      </div>

      <DialogFooter>
        <Button type="button" variant="outline" size="sm" onClick={onCancel}>
          Cancel
        </Button>
        <Button type="submit" size="sm">
          {initial ? 'Update table' : 'Stage table'}
        </Button>
      </DialogFooter>
    </form>
  );
}
