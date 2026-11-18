import { Check } from 'lucide-react';
import type { CellValue } from '@kleos/shared';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { cn } from '@/lib/utils';
import type { CellKind } from './classify';
import { boolValue, previewText, timestamptzToUtc } from './preview';

/** Dim italic mono NULL, distinct from an empty string (which renders blank). */
export function NullMark({ label = 'NULL', className }: { label?: string; className?: string }) {
  return (
    <span className={cn('font-mono text-[11px] font-medium tracking-[0.02em] text-muted-foreground italic', className)}>
      {label}
    </span>
  );
}

/** Read-only checkbox glyph for bool cells; the state is in its accessible name. */
export function BoolMark({ value }: { value: boolean }) {
  return (
    <span
      role="img"
      aria-label={value ? 'true' : 'false'}
      className={cn(
        'inline-flex size-3.5 items-center justify-center rounded-[4px] border align-[-2px]',
        value ? 'border-primary bg-primary text-primary-foreground' : 'border-input bg-background',
      )}
    >
      {value && <Check className="size-3" strokeWidth={3} aria-hidden="true" />}
    </span>
  );
}

/**
 * One value as the grid shows it: type-aware preview, NULL marker, bool glyph,
 * timestamptz with its UTC equivalent on hover. Layout (alignment, font) is the
 * caller's job; see isRightAligned / isMonospace.
 */
export function CellValueView({ kind, value }: { kind: CellKind; value: CellValue }) {
  if (value === null) return <NullMark />;
  if (kind === 'bool') {
    const b = boolValue(value);
    return b === null ? <span>{value}</span> : <BoolMark value={b} />;
  }
  const text = previewText(kind, value) ?? '';
  if (kind === 'timestamptz') {
    const utc = timestamptzToUtc(value);
    if (utc) {
      return (
        <Tooltip>
          <TooltipTrigger asChild>
            <span>{text}</span>
          </TooltipTrigger>
          <TooltipContent side="bottom" align="start" className="font-mono text-[11px]">
            UTC {utc}
          </TooltipContent>
        </Tooltip>
      );
    }
  }
  return <>{text}</>;
}
