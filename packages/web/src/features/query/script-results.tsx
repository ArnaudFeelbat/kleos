import { CircleCheck, CircleDashed, CircleSlash, CircleX, LoaderCircle } from 'lucide-react';
import { useEffect, useRef, type KeyboardEvent } from 'react';
import { formatInt, formatMs } from '@/lib/format';
import { cn } from '@/lib/utils';
import { shownStep, type ScriptState, type ScriptStep } from './store';

/** What a statement of a Run all came to, in a few characters: "12 rows", "UPDATE 3", "42703". */
export function stepOutcome(step: ScriptStep, scriptRunning: boolean): string {
  const run = step.run;
  if (!run) return scriptRunning ? 'Waiting' : 'Not run';
  if (run.status === 'running') return 'Running…';
  if (run.status === 'cancelled') return 'Cancelled';
  if (run.status === 'error') return run.error && /^[0-9A-Z]{5}$/.test(run.error.code) ? run.error.code : 'Failed';
  if (run.columns.length === 0) return run.command ?? 'Done';
  const more = run.hasMore || run.truncated;
  return `${formatInt(run.rows.length)}${more ? '+' : ''} row${run.rows.length === 1 && !more ? '' : 's'}`;
}

function StepIcon({ step }: { step: ScriptStep }) {
  const status = step.run?.status;
  if (status === 'running')
    return <LoaderCircle className="text-brand-text size-3.5 animate-spin" aria-hidden="true" />;
  if (status === 'done') return <CircleCheck className="text-success size-3.5" aria-hidden="true" />;
  if (status === 'error') return <CircleX className="text-destructive size-3.5" aria-hidden="true" />;
  if (status === 'cancelled') return <CircleSlash className="text-muted-foreground size-3.5" aria-hidden="true" />;
  return <CircleDashed className="text-muted-foreground/60 size-3.5" aria-hidden="true" />;
}

type ScriptListProps = {
  script: ScriptState;
  onSelect(index: number): void;
};

/**
 * The statements of a Run all, one compact row each (number, first line, outcome, time); the
 * selected one's result shows below. ↑/↓ move between statements that ran.
 */
export function ScriptList({ script, onSelect }: ScriptListProps) {
  const shown = shownStep(script);
  const running = script.status === 'running';
  const listRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    listRef.current?.querySelector(`[data-step="${shown}"]`)?.scrollIntoView?.({ block: 'nearest' });
  }, [shown]);

  const ran = script.steps.flatMap((s, i) => (s.run ? [i] : []));
  const onKeyDown = (e: KeyboardEvent) => {
    const at = ran.indexOf(shown);
    const to =
      e.key === 'ArrowDown'
        ? ran[Math.min(ran.length - 1, at + 1)]
        : e.key === 'ArrowUp'
          ? ran[Math.max(0, at - 1)]
          : e.key === 'Home'
            ? ran[0]
            : e.key === 'End'
              ? ran[ran.length - 1]
              : undefined;
    if (to === undefined) return;
    e.preventDefault();
    onSelect(to);
  };

  return (
    <div
      ref={listRef}
      role="listbox"
      aria-label="Statements"
      aria-activedescendant={`script-step-${script.id}-${shown}`}
      tabIndex={0}
      onKeyDown={onKeyDown}
      className="bg-sidebar/40 focus-visible:ring-ring/30 max-h-[188px] shrink-0 overflow-y-auto border-b py-1 outline-none focus-visible:ring-[3px] focus-visible:ring-inset"
    >
      {script.steps.map((step, i) => {
        const selected = i === shown;
        const failed = step.run?.status === 'error';
        return (
          <div
            key={i}
            id={`script-step-${script.id}-${i}`}
            data-step={i}
            role="option"
            aria-selected={selected}
            aria-disabled={!step.run}
            title={step.target.sql.length > 600 ? `${step.target.sql.slice(0, 600)}…` : step.target.sql}
            onClick={() => step.run && onSelect(i)}
            className={cn(
              'flex h-7 items-center gap-2.5 px-3 text-xs',
              step.run ? 'cursor-default hover:bg-foreground/[0.04] dark:hover:bg-white/[0.05]' : 'opacity-55',
              selected && 'bg-brand-soft hover:bg-brand-soft dark:hover:bg-brand-soft',
            )}
          >
            <span className="text-muted-foreground tabular w-6 shrink-0 text-right font-mono text-[11px]">{i + 1}</span>
            <StepIcon step={step} />
            <span className="text-foreground/90 min-w-0 flex-1 truncate font-mono text-[12px]">{step.preview}</span>
            <span
              className={cn(
                'tabular max-w-40 shrink-0 truncate font-mono text-[11.5px]',
                failed ? 'text-destructive font-medium' : 'text-foreground/75',
              )}
            >
              {stepOutcome(step, running)}
            </span>
            <span className="text-muted-foreground tabular w-16 shrink-0 text-right font-mono text-[11px]">
              {step.run && step.run.status !== 'running' ? formatMs(step.run.elapsedMs ?? 0) : ''}
            </span>
          </div>
        );
      })}
    </div>
  );
}
