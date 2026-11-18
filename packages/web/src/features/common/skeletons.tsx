import { Skeleton } from '@/components/ui/skeleton';
import { cn } from '@/lib/utils';

// Widths cycle so placeholder rows look like text rather than identical bars.
const widths = ['w-[78%]', 'w-[62%]', 'w-[86%]', 'w-[54%]', 'w-[70%]', 'w-[92%]'];

/** Placeholder lines for a list (sidebar, history, favorites). */
export function SkeletonList({
  rows = 5,
  rowClassName,
  label,
  className,
}: {
  rows?: number;
  /** Height of a row, e.g. "h-7" or "h-11". */
  rowClassName?: string;
  label?: string;
  className?: string;
}) {
  return (
    <div className={cn('flex flex-col gap-2', className)} aria-busy="true" aria-label={label}>
      {Array.from({ length: rows }, (_, i) => (
        <Skeleton key={i} className={cn('h-5', widths[i % widths.length], rowClassName)} />
      ))}
    </div>
  );
}

/** Placeholder for a data grid: a header band and rows of cells. */
export function GridSkeleton({ rows = 10, columns = 5, label }: { rows?: number; columns?: number; label?: string }) {
  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-hidden" aria-busy="true" aria-label={label}>
      <div className="bg-sidebar flex h-11 shrink-0 items-center gap-6 border-b px-4">
        {Array.from({ length: columns }, (_, c) => (
          <Skeleton key={c} className="h-3 w-20" />
        ))}
      </div>
      {Array.from({ length: rows }, (_, r) => (
        <div key={r} className="flex h-8 shrink-0 items-center gap-6 border-b px-4">
          {Array.from({ length: columns }, (_, c) => (
            <Skeleton
              key={c}
              className={cn('h-2.5', (r + c) % 3 === 0 ? 'w-14' : (r + c) % 3 === 1 ? 'w-24' : 'w-20')}
            />
          ))}
        </div>
      ))}
    </div>
  );
}
