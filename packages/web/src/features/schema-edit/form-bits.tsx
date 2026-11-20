import type { ComponentProps, ReactNode } from 'react';
import { Checkbox } from '@/components/ui/checkbox';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { cn } from '@/lib/utils';

/** One <datalist> of type suggestions per dialog; type boxes point at it with `list`. */
export function TypeSuggestions({ id, types }: { id: string; types: readonly string[] }) {
  return (
    <datalist id={id}>
      {types.map((t) => (
        <option key={t} value={t} />
      ))}
    </datalist>
  );
}

/** Monospace text box for identifiers, types and SQL expressions: no autocorrect, no capitals. */
export function CodeInput({ className, ...props }: ComponentProps<typeof Input>) {
  return (
    <Input
      autoComplete="off"
      autoCorrect="off"
      autoCapitalize="off"
      spellCheck={false}
      className={cn('font-mono text-xs', className)}
      {...props}
    />
  );
}

/** Label, control, then a hint or the field's error. */
export function Field({
  id,
  label,
  hint,
  error,
  children,
}: {
  id: string;
  label: ReactNode;
  hint?: ReactNode;
  error?: string | null;
  children: ReactNode;
}) {
  return (
    <div className="flex flex-col gap-1.5">
      <Label htmlFor={id} className="text-xs">
        {label}
      </Label>
      {children}
      {error ? (
        <span id={`${id}-error`} className="text-destructive text-[11px]">
          {error}
        </span>
      ) : hint ? (
        <span className="text-muted-foreground text-[11px]">{hint}</span>
      ) : null}
    </div>
  );
}

export function CheckField({
  id,
  label,
  checked,
  onChange,
  disabled,
  hint,
}: {
  id: string;
  label: ReactNode;
  checked: boolean;
  onChange(checked: boolean): void;
  disabled?: boolean;
  hint?: ReactNode;
}) {
  return (
    <div className="flex items-start gap-2">
      <Checkbox
        id={id}
        className="mt-px"
        checked={checked}
        disabled={disabled}
        onCheckedChange={(v) => onChange(v === true)}
      />
      <div className="flex flex-col gap-0.5">
        <Label htmlFor={id} className="text-xs font-normal">
          {label}
        </Label>
        {hint && <span className="text-muted-foreground text-[11px]">{hint}</span>}
      </div>
    </div>
  );
}
