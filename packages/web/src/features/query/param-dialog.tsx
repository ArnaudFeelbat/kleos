import { useId, useState, type FormEvent } from 'react';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Toggle } from '@/components/ui/toggle';
import { kbdOnPrimary } from '@/features/common/styles';
import { cn } from '@/lib/utils';
import type { ParamValues } from './params';

type ParamDialogProps = {
  open: boolean;
  /** Placeholders to ask for, in order ("$1", ":customer"). */
  keys: string[];
  /** Values to start from; a key set to null starts as NULL. */
  initial: ParamValues;
  /** What the submit button does: "Run", "Run all", "Explain". */
  action: string;
  /** e.g. "2 parameters in 1 statement". */
  description: string;
  onSubmit(values: ParamValues): void;
  onCancel(): void;
};

/**
 * Asks for the values of a statement's placeholders before it runs. Enter runs, Esc cancels;
 * each value can be NULL. The values are bound by Postgres, never pasted into the SQL.
 */
export function ParamDialog({ open, onCancel, ...form }: ParamDialogProps) {
  return (
    <Dialog open={open} onOpenChange={(o) => !o && onCancel()}>
      <DialogContent className="sm:max-w-md">{open && <ParamForm {...form} onCancel={onCancel} />}</DialogContent>
    </Dialog>
  );
}

type Field = { text: string; isNull: boolean };

function ParamForm({ keys, initial, action, description, onSubmit, onCancel }: Omit<ParamDialogProps, 'open'>) {
  const id = useId();
  const [fields, setFields] = useState<Record<string, Field>>(() =>
    Object.fromEntries(
      keys.map((k) => [k, { text: initial[k] ?? '', isNull: k in initial && initial[k] === null }] as const),
    ),
  );
  const firstEnabled = keys.find((k) => !fields[k]!.isNull);
  const set = (key: string, patch: Partial<Field>) => setFields((f) => ({ ...f, [key]: { ...f[key]!, ...patch } }));
  const submit = (e: FormEvent) => {
    e.preventDefault();
    onSubmit(Object.fromEntries(keys.map((k) => [k, fields[k]!.isNull ? null : fields[k]!.text])));
  };
  return (
    <form onSubmit={submit} className="flex flex-col gap-4">
      <DialogHeader>
        <DialogTitle>Parameters</DialogTitle>
        <DialogDescription>
          {description}. Values are sent as bind parameters, never pasted into the SQL.
        </DialogDescription>
      </DialogHeader>
      <div className="-mx-1 flex max-h-[min(360px,50vh)] flex-col gap-2 overflow-y-auto px-1 py-0.5">
        {keys.map((key, i) => {
          const field = fields[key]!;
          return (
            <div key={key} className="flex items-center gap-2">
              <label
                htmlFor={`${id}-${i}`}
                className="text-foreground/85 w-28 shrink-0 truncate font-mono text-[12.5px]"
                title={key}
              >
                {key}
              </label>
              <Input
                id={`${id}-${i}`}
                autoFocus={key === firstEnabled}
                value={field.isNull ? '' : field.text}
                placeholder={field.isNull ? 'NULL' : 'Value'}
                disabled={field.isNull}
                spellCheck={false}
                autoComplete="off"
                className={cn('font-mono', field.isNull && 'placeholder:text-muted-foreground')}
                onChange={(e) => set(key, { text: e.target.value })}
              />
              <Toggle
                variant="outline"
                size="sm"
                pressed={field.isNull}
                onPressedChange={(isNull) => set(key, { isNull })}
                aria-label={`NULL for ${key}`}
                className="h-8 shrink-0 px-2 font-mono text-[11px]"
              >
                NULL
              </Toggle>
            </div>
          );
        })}
      </div>
      <DialogFooter>
        <Button type="button" variant="outline" size="sm" onClick={onCancel}>
          Cancel
        </Button>
        <Button type="submit" size="sm" autoFocus={firstEnabled === undefined}>
          {action}
          <kbd className={kbdOnPrimary}>↵</kbd>
        </Button>
      </DialogFooter>
    </form>
  );
}
