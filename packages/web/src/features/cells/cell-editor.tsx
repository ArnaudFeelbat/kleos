import { useId, useState, type KeyboardEvent, type ReactNode } from 'react';
import type { CellValue } from '@kleos/shared';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Textarea } from '@/components/ui/textarea';
import { cn } from '@/lib/utils';
import { isRightAligned, type CellKind } from './classify';
import { NullMark } from './cell-value';
import { formatJsonExact, parseJsonExact } from './json';
import { boolValue } from './preview';
import { normalizeInput, validateCellInput } from './validate';

/** What an editor needs to know about its column. */
export type EditableColumn = {
  name: string;
  kind: CellKind;
  typeName: string;
  /** Short label for the header of the editor, e.g. "numeric(12,2)". */
  typeLabel: string;
  nullable: boolean;
  enumValues?: readonly string[];
};

/** A staged value: text or NULL, or DEFAULT (inserts only). */
export type EditResult = { type: 'value'; value: CellValue } | { type: 'default' };

/** +1 when the user left with Tab, -1 with Shift+Tab, so the grid can move on. */
export type EditAdvance = 1 | -1 | 0;

export type CellEditorProps = {
  column: EditableColumn;
  /** Current value; undefined means the cell currently holds DEFAULT (new rows). */
  value: CellValue | undefined;
  isInsert: boolean;
  onSubmit(result: EditResult, advance: EditAdvance): void;
  onCancel(): void;
  /** Shown when the cell has a staged change, to restore the original value. */
  onRevert?: () => void;
};

const isMac = typeof navigator !== 'undefined' && /Mac/.test(navigator.platform);
const modEnter = isMac ? '⌘↵' : 'Ctrl+↵';

/**
 * Type-aware editor for one cell: validated text input, text area for text, tri-state
 * bool, enum dropdown, JSON editor, array literal input, read-only notice for bytea.
 * Every editor offers Set null, and Set default on inserts.
 */
export function CellEditor({ column, value, isInsert, onSubmit, onCancel, onRevert }: CellEditorProps) {
  const id = useId();
  const errorId = `${id}-error`;
  const { kind } = column;
  const [text, setText] = useState(value ?? '');
  const [touched, setTouched] = useState(false);
  const error = validateCellInput(text, { kind, typeName: column.typeName, enumValues: column.enumValues });
  const shownError = touched ? error : null;
  const multiline = kind === 'text' || kind === 'json';

  const submitText = (advance: EditAdvance) => {
    setTouched(true);
    if (error) return;
    onSubmit({ type: 'value', value: normalizeInput(text, kind) }, advance);
  };

  const onKeyDown = (e: KeyboardEvent) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      onCancel();
    } else if (e.key === 'Enter' && (!multiline || e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      e.stopPropagation();
      submitText(0);
    } else if (e.key === 'Tab') {
      e.preventDefault();
      e.stopPropagation();
      submitText(e.shiftKey ? -1 : 1);
    }
  };

  const setNull = () => onSubmit({ type: 'value', value: null }, 0);
  const setDefault = () => onSubmit({ type: 'default' }, 0);

  let field: ReactNode;
  let usesSave = true;
  if (kind === 'bytea') {
    usesSave = false;
    field = <p className="text-muted-foreground text-xs">bytea values are read-only in this version.</p>;
  } else if (kind === 'bool') {
    usesSave = false;
    const current = value === undefined ? undefined : value === null ? null : boolValue(value);
    const options: { label: ReactNode; name: string; result: CellValue }[] = [
      { label: 'true', name: 'true', result: 'true' },
      { label: 'false', name: 'false', result: 'false' },
      { label: <NullMark />, name: 'NULL', result: null },
    ];
    field = (
      <div role="radiogroup" aria-label={`${column.name} value`} className="flex gap-1">
        {options.map((o, i) => {
          const checked = o.result === null ? current === null : current === (o.result === 'true');
          return (
            <Button
              key={o.name}
              type="button"
              role="radio"
              aria-checked={checked}
              aria-label={o.name}
              variant="outline"
              size="sm"
              autoFocus={checked || (current === undefined && i === 0)}
              className={cn('h-7 px-2.5 text-xs', checked && 'ring-ring ring-2')}
              disabled={o.result === null && !column.nullable}
              onClick={() => onSubmit({ type: 'value', value: o.result }, 0)}
              onKeyDown={(e) => {
                if (e.key === 'Escape') {
                  e.preventDefault();
                  e.stopPropagation();
                  onCancel();
                }
              }}
            >
              {o.label}
            </Button>
          );
        })}
      </div>
    );
  } else if (kind === 'enum' && column.enumValues && column.enumValues.length > 0) {
    usesSave = false;
    field = (
      <Select defaultOpen value={value ?? undefined} onValueChange={(v) => onSubmit({ type: 'value', value: v }, 0)}>
        <SelectTrigger
          size="sm"
          className="h-7 w-full text-xs"
          aria-label={`${column.name} value`}
          onKeyDown={(e) => {
            if (e.key === 'Escape') {
              e.preventDefault();
              e.stopPropagation();
              onCancel();
            }
          }}
        >
          <SelectValue placeholder={value === null ? 'NULL' : 'Pick a value'} />
        </SelectTrigger>
        <SelectContent>
          {column.enumValues.map((v) => (
            <SelectItem key={v} value={v} className="text-xs">
              {v}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    );
  } else if (multiline) {
    field = (
      <Textarea
        autoFocus
        aria-label={`${column.name} value`}
        aria-invalid={shownError ? true : undefined}
        aria-describedby={shownError ? errorId : undefined}
        value={text}
        rows={kind === 'json' ? 8 : 4}
        spellCheck={false}
        onChange={(e) => setText(e.target.value)}
        onBlur={() => setTouched(true)}
        onKeyDown={onKeyDown}
        className={cn(
          'max-h-72 min-h-20 resize-y px-2 py-1.5 text-xs md:text-xs',
          kind === 'json' && 'field-sizing-fixed font-mono',
        )}
      />
    );
  } else {
    field = (
      <Input
        autoFocus
        aria-label={`${column.name} value`}
        aria-invalid={shownError ? true : undefined}
        aria-describedby={shownError ? errorId : undefined}
        value={text}
        spellCheck={false}
        placeholder={placeholderFor(kind)}
        onChange={(e) => setText(e.target.value)}
        onBlur={() => setTouched(true)}
        onKeyDown={onKeyDown}
        className={cn('h-7 px-2 font-mono text-xs md:text-xs', isRightAligned(kind) && 'text-right')}
      />
    );
  }

  return (
    <div
      className="bg-popover text-popover-foreground flex w-full flex-col gap-2 rounded-md border p-2 shadow-lg"
      role="group"
      aria-label={`Edit ${column.name}`}
    >
      <div className="flex items-baseline gap-2 text-xs">
        <span className="font-mono font-medium">{column.name}</span>
        <span className="text-muted-foreground font-mono text-[10.5px]">{column.typeLabel}</span>
        {kind === 'timestamptz' && <span className="text-muted-foreground ml-auto text-[11px]">Offset required</span>}
      </div>
      {field}
      {shownError && (
        <p id={errorId} className="text-destructive text-xs">
          {shownError}
        </p>
      )}
      {kind === 'json' && !error && text.trim() !== '' && (
        <Button
          type="button"
          variant="ghost"
          size="xs"
          className="self-start"
          onClick={() => {
            const node = parseJsonExact(text);
            if (node) setText(formatJsonExact(node));
          }}
        >
          Format JSON
        </Button>
      )}
      <div className="flex flex-wrap items-center gap-1">
        {kind !== 'bytea' && (
          <Button
            type="button"
            variant="outline"
            size="xs"
            onClick={setNull}
            disabled={!column.nullable}
            title={column.nullable ? undefined : `${column.name} is NOT NULL`}
          >
            Set null
          </Button>
        )}
        {isInsert && (
          <Button type="button" variant="outline" size="xs" onClick={setDefault}>
            Set default
          </Button>
        )}
        {onRevert && (
          <Button type="button" variant="ghost" size="xs" onClick={onRevert}>
            Revert
          </Button>
        )}
        <span className="flex-1" />
        <Button type="button" variant="ghost" size="xs" onClick={onCancel}>
          {usesSave ? 'Cancel' : 'Close'}
        </Button>
        {usesSave && (
          <Button type="button" size="xs" onClick={() => submitText(0)} title={multiline ? modEnter : '↵'}>
            Stage
            <kbd className="font-mono text-[10px] opacity-70">{multiline ? modEnter : '↵'}</kbd>
          </Button>
        )}
      </div>
    </div>
  );
}

function placeholderFor(kind: CellKind): string | undefined {
  switch (kind) {
    case 'date':
      return 'YYYY-MM-DD';
    case 'timestamp':
      return 'YYYY-MM-DD HH:MM:SS';
    case 'timestamptz':
      return 'YYYY-MM-DD HH:MM:SS+00';
    case 'array':
      return '{a,b,c}';
    case 'uuid':
      return '00000000-0000-0000-0000-000000000000';
    default:
      return undefined;
  }
}
