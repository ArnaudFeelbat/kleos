import { CircleExclamationPoint, LoaderCircle, Minus, Pencil, Plus } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { tokenizeSql } from './pending-sql';
import type { StageError } from './staging';

const isMac = typeof navigator !== 'undefined' && /Mac/.test(navigator.platform);

type PendingPanelProps = {
  counts: { updated: number; inserted: number; deleted: number; total: number };
  sql: string;
  error: StageError | null;
  /** Human name of the failing row/cell, e.g. "Row 100510 · total". */
  errorLocation: string | null;
  committing: boolean;
  onDiscard(): void;
  onCommit(): void;
};

const numberWords = ['zero', 'one', 'both', 'all three', 'all four', 'all five', 'all six', 'all seven', 'all eight'];

/** Review panel: counts by kind, the SQL that will run, Discard and Commit (⌘S). */
export function PendingPanel({
  counts,
  sql,
  error,
  errorLocation,
  committing,
  onDiscard,
  onCommit,
}: PendingPanelProps) {
  const all = numberWords[counts.total] ?? `all ${counts.total}`;
  return (
    <section aria-label="Pending changes" className="bg-sidebar max-h-[40%] shrink-0 overflow-auto border-t">
      <div className="flex flex-wrap items-center gap-3 px-4 py-2.5">
        <b className="font-semibold">Pending changes</b>
        {counts.updated > 0 && (
          <span className="bg-staged-update text-staged-update-foreground inline-flex h-5 items-center gap-1 rounded-full px-2 text-[11px] font-medium">
            <Pencil className="size-2.5" aria-hidden="true" />
            {counts.updated} updated
          </span>
        )}
        {counts.inserted > 0 && (
          <span className="bg-staged-insert text-staged-insert-foreground inline-flex h-5 items-center gap-1 rounded-full px-2 text-[11px] font-medium">
            <Plus className="size-2.5" aria-hidden="true" />
            {counts.inserted} inserted
          </span>
        )}
        {counts.deleted > 0 && (
          <span className="bg-staged-delete text-staged-delete-foreground inline-flex h-5 items-center gap-1 rounded-full px-2 text-[11px] font-medium">
            <Minus className="size-2.5" aria-hidden="true" />
            {counts.deleted} deleted
          </span>
        )}
        <span className="text-muted-foreground text-xs">
          Applied in one transaction — any failing statement rolls back {counts.total === 1 ? 'it' : all}.
        </span>
        <span className="flex-1" />
        <Button type="button" variant="outline" size="sm" onClick={onDiscard} disabled={committing}>
          Discard
        </Button>
        <Button type="button" size="sm" onClick={onCommit} disabled={committing || counts.total === 0}>
          {committing && <LoaderCircle className="animate-spin" aria-hidden="true" />}
          Commit {counts.total} change{counts.total === 1 ? '' : 's'}
          <kbd className="rounded border border-current/40 px-1 font-mono text-[11px] font-medium">
            {isMac ? '⌘S' : 'Ctrl+S'}
          </kbd>
        </Button>
      </div>
      {error && (
        <div
          role="alert"
          className="bg-error-bg border-error-line mx-4 mb-3 flex items-start gap-2.5 rounded-lg border px-3.5 py-3"
        >
          <CircleExclamationPoint className="text-destructive mt-0.5 size-4 shrink-0" aria-hidden="true" />
          <div className="flex flex-col gap-0.5">
            <b className="font-semibold">Commit failed — nothing was saved</b>
            <span className="text-xs">
              {errorLocation && <span className="font-mono">{errorLocation}: </span>}
              <span className="font-mono">{error.code}</span> {error.message}. The whole batch was rolled back; your{' '}
              {counts.total} edit{counts.total === 1 ? ' is' : 's are'} still staged.
            </span>
            {error.detail && <span className="text-muted-foreground text-xs">{error.detail}</span>}
            {error.hint && <span className="text-muted-foreground text-xs">Hint: {error.hint}</span>}
          </div>
        </div>
      )}
      <pre
        className="bg-background selectable mx-4 mb-3 overflow-x-auto rounded-lg border px-3.5 py-3 font-mono text-xs leading-[1.7]"
        aria-label="SQL that will run"
      >
        {tokenizeSql(sql).map((t, i) => (
          <span
            key={i}
            className={cn(
              t.kind === 'keyword' && 'text-code-keyword',
              t.kind === 'string' && 'text-code-string',
              t.kind === 'number' && 'text-code-number',
              t.kind === 'comment' && 'text-muted-foreground',
            )}
          >
            {t.text}
          </span>
        ))}
      </pre>
    </section>
  );
}
