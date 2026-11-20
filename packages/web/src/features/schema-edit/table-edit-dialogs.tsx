import { indexMethods, type DdlChange, type Table } from '@kleos/shared';
import { useId, useState, type FormEvent, type ReactNode } from 'react';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { useWorkspace } from '@/features/workspace/context';
import { cn } from '@/lib/utils';
import { CheckField, CodeInput, Field, TypeSuggestions } from './form-bits';
import { columnSpecOf, identifierProblem, typeSuggestions } from './model';
import type { ColumnView, TableOverlay } from './overlay';
import type { SchemaEditActions, StagedDdl } from './store';

/** Which editing dialog of the detail panel is open. */
export type EditDialog =
  | { kind: 'addColumn'; editing?: StagedDdl }
  | { kind: 'renameColumn'; column: ColumnView }
  | { kind: 'changeType'; column: ColumnView }
  | { kind: 'setDefault'; column: ColumnView }
  | { kind: 'dropColumn'; column: ColumnView }
  | { kind: 'renameTable' }
  | { kind: 'dropTable' }
  | { kind: 'addIndex' };

type Props = {
  dialog: EditDialog | null;
  onClose(): void;
  table: Table;
  overlay: TableOverlay;
  actions: SchemaEditActions;
};

/** The detail panel's editing dialogs. Each one stages a change; nothing runs until Apply. */
export function TableEditDialogs({ dialog, onClose, table, overlay, actions }: Props) {
  const stage = (change: DdlChange) => {
    actions.stage(change);
    onClose();
  };
  const liveNames = overlay.columns.filter((c) => !c.dropped).map((c) => c.name);
  const props = { onClose, overlay, stage };
  return (
    <Dialog open={dialog !== null} onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="sm:max-w-md">
        {dialog?.kind === 'addColumn' && (
          <AddColumnForm
            {...props}
            hasRows={table.rowEstimate !== 0}
            editing={dialog.editing}
            takenNames={liveNames}
            onUpdate={(id, change) => {
              actions.update(id, change);
              onClose();
            }}
          />
        )}
        {dialog?.kind === 'renameColumn' && (
          <RenameColumnForm {...props} column={dialog.column} takenNames={liveNames} />
        )}
        {dialog?.kind === 'changeType' && <ChangeTypeForm {...props} column={dialog.column} />}
        {dialog?.kind === 'setDefault' && <SetDefaultForm {...props} column={dialog.column} />}
        {dialog?.kind === 'dropColumn' && <DropColumnForm {...props} column={dialog.column} />}
        {dialog?.kind === 'renameTable' && <RenameTableForm {...props} />}
        {dialog?.kind === 'dropTable' && <DropTableForm {...props} />}
        {dialog?.kind === 'addIndex' && <AddIndexForm {...props} columns={liveNames} />}
      </DialogContent>
    </Dialog>
  );
}

type FormProps = { onClose(): void; overlay: TableOverlay; stage(change: DdlChange): void };

const stagesNote = 'Nothing runs until you apply the pending changes.';

function DialogForm({
  title,
  description,
  submitLabel,
  destructive,
  canSubmit = true,
  onSubmit,
  onCancel,
  children,
}: {
  title: ReactNode;
  description: ReactNode;
  submitLabel: string;
  destructive?: boolean;
  canSubmit?: boolean;
  /** Each form checks itself here; errors show once staging was tried, then follow every keystroke. */
  onSubmit(): void;
  onCancel(): void;
  children: ReactNode;
}) {
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (canSubmit) onSubmit();
  };
  return (
    <form onSubmit={submit} noValidate className="flex min-w-0 flex-col gap-4">
      <DialogHeader>
        <DialogTitle>{title}</DialogTitle>
        <DialogDescription>{description}</DialogDescription>
      </DialogHeader>
      {children}
      <DialogFooter>
        <Button type="button" variant="outline" size="sm" onClick={onCancel}>
          Cancel
        </Button>
        <Button type="submit" size="sm" variant={destructive ? 'destructive' : 'default'} disabled={!canSubmit}>
          {submitLabel}
        </Button>
      </DialogFooter>
    </form>
  );
}

function Mono({ children }: { children: ReactNode }) {
  return <span className="text-foreground font-mono text-[12.5px]">{children}</span>;
}

function AddColumnForm({
  overlay,
  stage,
  onClose,
  editing,
  takenNames,
  hasRows,
  onUpdate,
}: FormProps & {
  editing?: StagedDdl;
  takenNames: string[];
  hasRows: boolean;
  onUpdate(id: string, change: DdlChange): void;
}) {
  const ids = useId();
  const { schemaModel } = useWorkspace();
  const initial = editing?.change.op === 'addColumn' ? editing.change.column : null;
  const [name, setName] = useState(initial?.name ?? '');
  const [type, setType] = useState(initial?.type ?? '');
  const [def, setDef] = useState(initial?.default ?? '');
  const [nullable, setNullable] = useState(initial?.nullable ?? true);
  const [tried, setTried] = useState(false);
  const others = takenNames.filter((n) => n !== initial?.name);
  const nameError =
    identifierProblem(name, 'Column name') ??
    (others.includes(name) ? `${overlay.ref.name} already has a column named ${name}.` : null);
  const typeError = type.trim() === '' ? 'Type is required.' : null;
  const notNullRisk = !nullable && def.trim() === '' && hasRows;

  return (
    <DialogForm
      title={editing ? 'Edit new column' : `Add column to ${overlay.ref.name}`}
      description={`Stages ALTER TABLE … ADD COLUMN. ${stagesNote}`}
      submitLabel={editing ? 'Update column' : 'Stage column'}
      onCancel={onClose}
      onSubmit={() => {
        setTried(true);
        if (nameError || typeError) return;
        const change: DdlChange = {
          op: 'addColumn',
          table: editing?.change.op === 'addColumn' ? editing.change.table : overlay.ref,
          column: columnSpecOf({ name, type, nullable, default: def }),
        };
        if (editing) onUpdate(editing.id, change);
        else stage(change);
      }}
    >
      <Field id={`${ids}-name`} label="Name" error={tried ? nameError : null}>
        <CodeInput
          id={`${ids}-name`}
          autoFocus
          value={name}
          aria-invalid={(tried && !!nameError) || undefined}
          onChange={(e) => setName(e.target.value)}
        />
      </Field>
      <Field
        id={`${ids}-type`}
        label="Type"
        error={tried ? typeError : null}
        hint="Any Postgres type, e.g. varchar(80) or int[]."
      >
        <CodeInput
          id={`${ids}-type`}
          list={`${ids}-types`}
          value={type}
          placeholder="text"
          aria-invalid={(tried && !!typeError) || undefined}
          onChange={(e) => setType(e.target.value)}
        />
      </Field>
      <TypeSuggestions id={`${ids}-types`} types={typeSuggestions(schemaModel)} />
      <Field
        id={`${ids}-default`}
        label="Default"
        hint="A SQL expression, e.g. now() or 'draft'. Leave empty for none."
      >
        <CodeInput id={`${ids}-default`} value={def} placeholder="none" onChange={(e) => setDef(e.target.value)} />
      </Field>
      <CheckField
        id={`${ids}-nullable`}
        label="Allow NULL"
        checked={nullable}
        onChange={setNullable}
        hint={notNullRisk ? 'Without a default, a NOT NULL column can’t be added to a table that has rows.' : undefined}
      />
    </DialogForm>
  );
}

function RenameColumnForm({
  overlay,
  stage,
  onClose,
  column,
  takenNames,
}: FormProps & { column: ColumnView; takenNames: string[] }) {
  const ids = useId();
  const [name, setName] = useState(column.name);
  const [tried, setTried] = useState(false);
  const error =
    identifierProblem(name, 'New name') ??
    (name === column.name
      ? 'Pick a different name.'
      : takenNames.includes(name)
        ? `${overlay.ref.name} already has a column named ${name}.`
        : null);
  return (
    <DialogForm
      title="Rename column"
      description={
        <>
          Stages renaming <Mono>{column.name}</Mono>. {stagesNote}
        </>
      }
      submitLabel="Stage rename"
      onCancel={onClose}
      onSubmit={() => {
        setTried(true);
        if (!error) stage({ op: 'renameColumn', table: overlay.ref, column: column.name, newName: name });
      }}
    >
      <Field id={`${ids}-name`} label="New name" error={tried ? error : null}>
        <CodeInput
          id={`${ids}-name`}
          autoFocus
          value={name}
          aria-invalid={(tried && !!error) || undefined}
          onFocus={(e) => e.target.select()}
          onChange={(e) => setName(e.target.value)}
        />
      </Field>
    </DialogForm>
  );
}

function ChangeTypeForm({ overlay, stage, onClose, column }: FormProps & { column: ColumnView }) {
  const ids = useId();
  const { schemaModel } = useWorkspace();
  const [type, setType] = useState(column.type);
  const [using, setUsing] = useState('');
  const [tried, setTried] = useState(false);
  const error =
    type.trim() === ''
      ? 'Type is required.'
      : type.trim().toLowerCase() === column.type.toLowerCase()
        ? `${column.name} already has this type.`
        : null;
  return (
    <DialogForm
      title="Change column type"
      description={
        <>
          Stages ALTER COLUMN <Mono>{column.name}</Mono> TYPE. Postgres rewrites the table when the storage changes.{' '}
          {stagesNote}
        </>
      }
      submitLabel="Stage type change"
      onCancel={onClose}
      onSubmit={() => {
        setTried(true);
        if (error) return;
        stage({
          op: 'alterColumnType',
          table: overlay.ref,
          column: column.name,
          type: type.trim(),
          using: using.trim() === '' ? null : using.trim(),
        });
      }}
    >
      <Field id={`${ids}-type`} label="New type" error={tried ? error : null}>
        <CodeInput
          id={`${ids}-type`}
          autoFocus
          list={`${ids}-types`}
          value={type}
          aria-invalid={(tried && !!error) || undefined}
          onFocus={(e) => e.target.select()}
          onChange={(e) => setType(e.target.value)}
        />
      </Field>
      <TypeSuggestions id={`${ids}-types`} types={typeSuggestions(schemaModel)} />
      <Field
        id={`${ids}-using`}
        label="Using (optional)"
        hint="An expression converting the old values, when Postgres can’t cast them by itself."
      >
        <CodeInput
          id={`${ids}-using`}
          value={using}
          placeholder={`${column.name}::${type.trim() || 'type'}`}
          onChange={(e) => setUsing(e.target.value)}
        />
      </Field>
    </DialogForm>
  );
}

function SetDefaultForm({ overlay, stage, onClose, column }: FormProps & { column: ColumnView }) {
  const ids = useId();
  const [def, setDef] = useState(column.default ?? '');
  const [tried, setTried] = useState(false);
  const error = def.trim() === '' ? 'Enter an expression, or use “Drop default” instead.' : null;
  return (
    <DialogForm
      title="Set default"
      description={
        <>
          Stages a new default for <Mono>{column.name}</Mono>; existing rows keep their values. {stagesNote}
        </>
      }
      submitLabel="Stage default"
      onCancel={onClose}
      onSubmit={() => {
        setTried(true);
        if (!error) stage({ op: 'setDefault', table: overlay.ref, column: column.name, default: def.trim() });
      }}
    >
      <Field
        id={`${ids}-default`}
        label="Default expression"
        error={tried ? error : null}
        hint="e.g. now(), 0 or 'draft'"
      >
        <CodeInput
          id={`${ids}-default`}
          autoFocus
          value={def}
          aria-invalid={(tried && !!error) || undefined}
          onChange={(e) => setDef(e.target.value)}
        />
      </Field>
    </DialogForm>
  );
}

function DropColumnForm({ overlay, stage, onClose, column }: FormProps & { column: ColumnView }) {
  const ids = useId();
  const [cascade, setCascade] = useState(false);
  return (
    <DialogForm
      title={`Drop column ${column.name}?`}
      description={
        <>
          Stages dropping <Mono>{column.name}</Mono> from <Mono>{overlay.ref.name}</Mono>. Its values are deleted when
          you apply. {stagesNote}
        </>
      }
      submitLabel="Stage drop"
      destructive
      onCancel={onClose}
      onSubmit={() => stage({ op: 'dropColumn', table: overlay.ref, column: column.name, cascade })}
    >
      <CheckField
        id={`${ids}-cascade`}
        label="Also drop dependent objects (CASCADE)"
        checked={cascade}
        onChange={setCascade}
        hint="Views, indexes and constraints that use the column. Without it, Postgres refuses if any exist."
      />
    </DialogForm>
  );
}

function RenameTableForm({ overlay, stage, onClose }: FormProps) {
  const ids = useId();
  const { schemaModel } = useWorkspace();
  const [name, setName] = useState(overlay.ref.name);
  const [tried, setTried] = useState(false);
  const taken = (schemaModel?.tables ?? [])
    .concat(schemaModel?.views ?? [])
    .some((t) => t.schema === overlay.ref.schema && t.name === name);
  const error =
    identifierProblem(name, 'New name') ??
    (name === overlay.ref.name
      ? 'Pick a different name.'
      : taken
        ? `${overlay.ref.schema} already has a table or view named ${name}.`
        : null);
  return (
    <DialogForm
      title="Rename table"
      description={
        <>
          Stages renaming <Mono>{overlay.ref.name}</Mono>. Views follow the new name; saved queries and application code
          don’t. {stagesNote}
        </>
      }
      submitLabel="Stage rename"
      onCancel={onClose}
      onSubmit={() => {
        setTried(true);
        if (!error) stage({ op: 'renameTable', table: overlay.ref, newName: name });
      }}
    >
      <Field id={`${ids}-name`} label="New name" error={tried ? error : null}>
        <CodeInput
          id={`${ids}-name`}
          autoFocus
          value={name}
          aria-invalid={(tried && !!error) || undefined}
          onFocus={(e) => e.target.select()}
          onChange={(e) => setName(e.target.value)}
        />
      </Field>
    </DialogForm>
  );
}

function DropTableForm({ overlay, stage, onClose }: FormProps) {
  const ids = useId();
  const [typed, setTyped] = useState('');
  const [cascade, setCascade] = useState(false);
  const matches = typed === overlay.ref.name;
  return (
    <DialogForm
      title={`Drop table ${overlay.ref.name}?`}
      description={
        <>
          Stages dropping{' '}
          <Mono>
            {overlay.ref.schema}.{overlay.ref.name}
          </Mono>{' '}
          with all its rows. This can’t be undone once applied. {stagesNote}
        </>
      }
      submitLabel="Stage drop"
      destructive
      canSubmit={matches}
      onCancel={onClose}
      onSubmit={() => stage({ op: 'dropTable', table: overlay.ref, cascade })}
    >
      <Field
        id={`${ids}-confirm`}
        label={
          <>
            Type <Mono>{overlay.ref.name}</Mono> to confirm
          </>
        }
      >
        <CodeInput id={`${ids}-confirm`} autoFocus value={typed} onChange={(e) => setTyped(e.target.value)} />
      </Field>
      <CheckField
        id={`${ids}-cascade`}
        label="Also drop dependent objects (CASCADE)"
        checked={cascade}
        onChange={setCascade}
        hint="Views and foreign keys of other tables that depend on it. Without it, Postgres refuses if any exist."
      />
    </DialogForm>
  );
}

function AddIndexForm({ overlay, stage, onClose, columns }: FormProps & { columns: string[] }) {
  const ids = useId();
  const [picked, setPicked] = useState<string[]>([]);
  const [unique, setUnique] = useState(false);
  const [method, setMethod] = useState<(typeof indexMethods)[number]>('btree');
  const [name, setName] = useState('');
  const [tried, setTried] = useState(false);
  const toggle = (c: string) => setPicked((p) => (p.includes(c) ? p.filter((x) => x !== c) : [...p, c]));
  const columnsError =
    picked.length === 0
      ? 'Pick at least one column.'
      : method === 'hash' && picked.length > 1
        ? 'A hash index covers a single column.'
        : null;
  const uniqueError = unique && method !== 'btree' ? 'Only btree indexes can be unique.' : null;
  const nameError = name.trim() === '' ? null : identifierProblem(name, 'Name');
  const errors = columnsError ?? uniqueError ?? nameError;
  return (
    <DialogForm
      title={`Add index on ${overlay.ref.name}`}
      description={`Stages CREATE INDEX (not concurrently: it runs inside the transaction and locks writes while it builds). ${stagesNote}`}
      submitLabel="Stage index"
      onCancel={onClose}
      onSubmit={() => {
        setTried(true);
        if (errors) return;
        stage({
          op: 'createIndex',
          table: overlay.ref,
          name: name.trim() === '' ? null : name,
          columns: picked,
          unique,
          method,
        });
      }}
    >
      <div className="flex flex-col gap-1.5">
        <span id={`${ids}-cols`} className="text-xs font-medium">
          Columns, in index order
        </span>
        <div
          role="group"
          aria-labelledby={`${ids}-cols`}
          className="flex max-h-48 flex-col overflow-y-auto rounded-md p-1 shadow-[0_0_0_1px_var(--edge)]"
        >
          {columns.map((c) => {
            const pos = picked.indexOf(c);
            return (
              <button
                key={c}
                type="button"
                role="checkbox"
                aria-checked={pos >= 0}
                onClick={() => toggle(c)}
                className={cn(
                  'hover:bg-foreground/[0.04] flex items-center gap-2 rounded-[5px] px-2 py-1 text-left font-mono text-xs outline-none focus-visible:ring-[3px] focus-visible:ring-ring/30',
                  pos >= 0 && 'bg-brand-soft hover:bg-brand-soft',
                )}
              >
                <span
                  aria-hidden="true"
                  className={cn(
                    'flex size-4 items-center justify-center rounded-[4px] text-[10px] font-semibold',
                    pos >= 0 ? 'bg-primary text-primary-foreground' : 'shadow-[inset_0_0_0_1px_var(--edge)]',
                  )}
                >
                  {pos >= 0 ? pos + 1 : ''}
                </span>
                {c}
              </button>
            );
          })}
        </div>
        {tried && columnsError ? (
          <span className="text-destructive text-[11px]">{columnsError}</span>
        ) : (
          <span className="text-muted-foreground text-[11px]">
            {picked.length > 0 ? `(${picked.join(', ')})` : 'Click columns in the order the index should use.'}
          </span>
        )}
      </div>
      <div className="grid grid-cols-2 gap-3">
        <Field id={`${ids}-method`} label="Method">
          <Select value={method} onValueChange={(v) => setMethod(v as typeof method)}>
            <SelectTrigger id={`${ids}-method`} size="sm" className="w-full font-mono text-xs">
              <SelectValue />
            </SelectTrigger>
            <SelectContent position="popper">
              {indexMethods.map((m) => (
                <SelectItem key={m} value={m} className="font-mono text-xs">
                  {m}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </Field>
        <Field id={`${ids}-name`} label="Name (optional)" error={tried ? nameError : null}>
          <CodeInput
            id={`${ids}-name`}
            className="h-7"
            value={name}
            placeholder="generated"
            onChange={(e) => setName(e.target.value)}
          />
        </Field>
      </div>
      <CheckField
        id={`${ids}-unique`}
        label="Unique"
        checked={unique}
        onChange={setUnique}
        hint={tried && uniqueError ? <span className="text-destructive">{uniqueError}</span> : undefined}
      />
    </DialogForm>
  );
}
