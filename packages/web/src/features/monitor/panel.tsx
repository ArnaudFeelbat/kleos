import { CircleX, RefreshCw } from 'lucide-react';
import type { ReactNode } from 'react';
import { cn } from '@/lib/utils';

type Props = {
  title: string;
  /** Text or badge after the title, e.g. "last 15 minutes". */
  extra?: ReactNode;
  /** Poll source and interval, e.g. "pg_stat_database · 5 s". */
  poll: string;
  /** Error of the latest poll; the last good data stays visible below it. */
  error?: string | null;
  className?: string;
  children: ReactNode;
};

/** Card with the monitor panel header: title, extra, and the poll source on the right. */
export function Panel({ title, extra, poll, error, className, children }: Props) {
  return (
    <section aria-label={title} className={cn('bg-card min-w-0 rounded-xl border', className)}>
      <div className="flex items-center gap-2 border-b px-4 py-3">
        <h2 className="text-sm font-semibold">{title}</h2>
        {extra}
        <span className="text-muted-foreground ml-auto inline-flex shrink-0 items-center gap-1.5 font-mono text-[11px]">
          <RefreshCw className="size-[11px]" aria-hidden="true" />
          {poll}
        </span>
      </div>
      {error && (
        <div role="alert" className="bg-error-bg border-error-line flex items-start gap-2 border-b px-4 py-2 text-xs">
          <CircleX className="text-destructive mt-px size-3.5 shrink-0" aria-hidden="true" />
          <span className="font-mono break-words">{error}</span>
        </div>
      )}
      {children}
    </section>
  );
}

/** Small table styles shared by the monitor panels (denser than the shadcn table). */
export const tbl = {
  table: 'w-full border-separate border-spacing-0 text-xs',
  th: 'text-muted-foreground h-[34px] border-b px-3 text-left font-medium whitespace-nowrap',
  td: 'h-[38px] border-b px-3 whitespace-nowrap [tr:last-child>&]:border-b-0',
  num: 'text-right font-mono',
};

export function PanelEmpty({ children }: { children: ReactNode }) {
  return <p className="text-muted-foreground px-4 py-6 text-center text-xs">{children}</p>;
}
