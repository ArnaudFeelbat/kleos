import { filterOperators, type FilterOperator } from '@kleos/shared';
import { Funnel, Plus, X } from 'lucide-react';
import { useId, useState, type FormEvent } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import type { CellKind } from '@/features/cells/classify';
import { cn } from '@/lib/utils';
import { chipDescription, operatorLabels, operatorNames, operatorNeedsValue, type FilterChip } from './filters';

export type FilterColumn = { name: string; kind: CellKind };

type FilterBarProps = {
  columns: readonly FilterColumn[];
  chips: readonly FilterChip[];
  onChipsChange(chips: FilterChip[]): void;
  where: string;
  onWhereChange(where: string): void;
};

/**
 * Filter chips combined with AND, an "Add filter" builder (column, operator, value) and a
 * raw WHERE box for everything else. The WHERE box applies on Enter (or blur) and reverts
 * on Escape.
 */
export function FilterBar({ columns, chips, onChipsChange, where, onWhereChange }: FilterBarProps) {
  const whereId = useId();
  const [draft, setDraft] = useState(where);
  const [lastWhere, setLastWhere] = useState(where);
  if (where !== lastWhere) {
    // The applied condition changed from outside (foreign-key jump, reset): follow it.
    setLastWhere(where);
    setDraft(where);
  }

  return (
    <div className="bg-sidebar/50 flex flex-wrap items-center gap-2 border-b px-4 py-2">
      <Funnel
        className={cn('size-3.5 shrink-0', chips.length > 0 || where ? 'text-brand-text' : 'text-muted-foreground')}
        aria-hidden="true"
      />
      {chips.map((chip) => (
        <span
          key={chip.id}
          className="bg-brand-soft animate-in fade-in-0 zoom-in-95 inline-flex h-7 items-center gap-1.5 rounded-md pr-1 pl-2.5 text-xs shadow-[inset_0_0_0_1px_var(--brand-line)] duration-150"
          aria-label={`Filter: ${chipDescription(chip)}`}
        >
          <span className="font-mono font-medium">{chip.column}</span>
          <span className="text-muted-foreground font-mono">{operatorLabels[chip.op]}</span>
          {operatorNeedsValue(chip.op) && <span className="max-w-48 truncate font-mono">{chip.value}</span>}
          <Button
            type="button"
            variant="ghost"
            size="icon-xs"
            className="text-muted-foreground hover:text-foreground size-5 hover:bg-black/[0.06] dark:hover:bg-white/[0.08]"
            aria-label={`Remove filter ${chipDescription(chip)}`}
            onClick={() => onChipsChange(chips.filter((c) => c.id !== chip.id))}
          >
            <X className="size-3" />
          </Button>
        </span>
      ))}
      <AddFilter columns={columns} onAdd={(chip) => onChipsChange([...chips, chip])} />
      {chips.length > 0 && (
        <span className="text-muted-foreground font-mono text-[10.5px] font-semibold tracking-[0.06em]">AND</span>
      )}
      <div
        className={cn(
          'bg-card focus-within:border-brand focus-within:ring-ring/25 flex h-7 min-w-0 flex-[1_1_280px] items-center overflow-hidden rounded-md border transition-[border-color,box-shadow] focus-within:ring-[3px] dark:bg-white/[0.03]',
          where ? 'border-brand-line' : 'border-input',
        )}
      >
        <label
          htmlFor={whereId}
          className={cn(
            'flex h-full items-center border-r px-2 font-mono text-[10.5px] font-semibold tracking-[0.04em]',
            where
              ? 'border-brand-line bg-brand-soft text-brand-text'
              : 'border-input bg-muted text-muted-foreground dark:bg-white/[0.04]',
          )}
        >
          WHERE
        </label>
        <input
          id={whereId}
          className="placeholder:text-muted-foreground/70 h-full min-w-0 flex-1 bg-transparent px-2 font-mono text-xs outline-none"
          placeholder="raw SQL condition, e.g. metadata->>'channel' <> 'admin'"
          spellCheck={false}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') onWhereChange(draft.trim());
            if (e.key === 'Escape') setDraft(where);
          }}
          onBlur={() => {
            if (draft.trim() !== where) onWhereChange(draft.trim());
          }}
        />
        {where && (
          <Button
            type="button"
            variant="ghost"
            size="icon-xs"
            className="text-muted-foreground hover:text-foreground mr-0.5 size-5"
            aria-label="Clear WHERE condition"
            onClick={() => onWhereChange('')}
          >
            <X className="size-3" />
          </Button>
        )}
      </div>
    </div>
  );
}

function valuePlaceholder(kind: CellKind | undefined, op: FilterOperator): string {
  if (op === 'contains') return 'text to find';
  switch (kind) {
    case 'date':
      return 'YYYY-MM-DD';
    case 'timestamptz':
      return 'YYYY-MM-DD HH:MM:SS+00';
    case 'timestamp':
      return 'YYYY-MM-DD HH:MM:SS';
    case 'integer':
    case 'number':
      return '0';
    case 'bool':
      return 'true or false';
    default:
      return 'value';
  }
}

function AddFilter({ columns, onAdd }: { columns: readonly FilterColumn[]; onAdd(chip: FilterChip): void }) {
  const ids = useId();
  const [open, setOpen] = useState(false);
  const [column, setColumn] = useState('');
  const [op, setOp] = useState<FilterOperator>('eq');
  const [value, setValue] = useState('');
  const kind = columns.find((c) => c.name === column)?.kind;
  const ready = column !== '' && (!operatorNeedsValue(op) || value !== '');

  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (!ready) return;
    onAdd({ id: crypto.randomUUID(), column, op, value: operatorNeedsValue(op) ? value : '' });
    setValue('');
    setOpen(false);
  };

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="border-foreground/20 text-foreground/75 hover:border-foreground/30 h-7 border border-dashed px-2.5 text-xs data-[state=open]:border-solid data-[state=open]:border-brand data-[state=open]:text-foreground"
        >
          <Plus className="size-3.5" aria-hidden="true" />
          Add filter
        </Button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-80 p-3.5">
        <form className="flex flex-col gap-3" onSubmit={submit}>
          <p className="text-[13px] font-semibold tracking-[-0.01em]">Add a filter</p>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor={`${ids}-col`} className="text-xs">
              Column
            </Label>
            <Select value={column} onValueChange={setColumn}>
              <SelectTrigger id={`${ids}-col`} size="sm" className="w-full font-mono text-xs">
                <SelectValue placeholder="Pick a column" />
              </SelectTrigger>
              <SelectContent position="popper">
                {columns.map((c) => (
                  <SelectItem key={c.name} value={c.name} className="font-mono text-xs">
                    {c.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor={`${ids}-op`} className="text-xs">
              Operator
            </Label>
            <Select value={op} onValueChange={(v) => setOp(v as FilterOperator)}>
              <SelectTrigger id={`${ids}-op`} size="sm" className="w-full text-xs">
                <SelectValue />
              </SelectTrigger>
              <SelectContent position="popper">
                {filterOperators.map((o) => (
                  <SelectItem key={o} value={o} className="text-xs">
                    <span className="w-14 font-mono">{operatorLabels[o]}</span>
                    <span className="text-muted-foreground">{operatorNames[o]}</span>
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          {operatorNeedsValue(op) && (
            <div className="flex flex-col gap-1.5">
              <Label htmlFor={`${ids}-val`} className="text-xs">
                Value
              </Label>
              <Input
                id={`${ids}-val`}
                className="h-8 font-mono text-xs md:text-xs"
                value={value}
                placeholder={valuePlaceholder(kind, op)}
                spellCheck={false}
                onChange={(e) => setValue(e.target.value)}
              />
            </div>
          )}
          <Button type="submit" size="sm" disabled={!ready}>
            Add filter
          </Button>
        </form>
      </PopoverContent>
    </Popover>
  );
}
