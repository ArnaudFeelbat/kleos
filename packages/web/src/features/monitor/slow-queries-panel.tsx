import type { StatsResultOf } from '@kleos/shared';
import { Info } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { formatInt, formatMs } from '@/lib/format';
import { cn } from '@/lib/utils';
import { Panel, PanelEmpty, PanelLoading, tbl } from './panel';

export const DEFAULT_INSTALL_HINT = 'CREATE EXTENSION pg_stat_statements;';
const MAX_ROWS = 20;

/** pg_stat_statements ranked by total time, or how to install it when it is missing. */
export function SlowQueriesPanel({
  stats,
  error,
  poll,
}: {
  stats: StatsResultOf<'statements'> | undefined;
  error: string | null;
  poll: string;
}) {
  return (
    <Panel title="Slow queries" poll={`pg_stat_statements · ${poll}`} error={error}>
      {!stats ? (
        <PanelLoading />
      ) : !stats.available ? (
        <NotInstalled hint={stats.installHint ?? DEFAULT_INSTALL_HINT} />
      ) : stats.statements.length === 0 ? (
        <PanelEmpty>No statements recorded since the last stats reset.</PanelEmpty>
      ) : (
        <>
          <table className={cn(tbl.table, 'table-fixed')}>
            <thead>
              <tr>
                <th className={cn(tbl.th, 'w-1/2')}>query</th>
                <th className={cn(tbl.th, 'text-right')}>calls</th>
                <th className={cn(tbl.th, 'text-right')}>mean</th>
                <th className={cn(tbl.th, 'text-right')}>total</th>
              </tr>
            </thead>
            <tbody>
              {[...stats.statements]
                .sort((a, b) => b.totalMs - a.totalMs)
                .slice(0, MAX_ROWS)
                .map((s, i) => (
                  <tr key={i} className={tbl.tr}>
                    <td className={cn(tbl.td, 'truncate font-mono')}>
                      <Tooltip>
                        <TooltipTrigger asChild>
                          <span tabIndex={0} className="block truncate outline-none focus-visible:underline">
                            {s.query}
                          </span>
                        </TooltipTrigger>
                        <TooltipContent
                          side="bottom"
                          align="start"
                          className="max-w-[560px] font-mono text-[11px] whitespace-pre-wrap"
                        >
                          {s.query}
                        </TooltipContent>
                      </Tooltip>
                    </td>
                    <td className={cn(tbl.td, tbl.num)}>{formatInt(s.calls)}</td>
                    <td className={cn(tbl.td, tbl.num)}>{formatMs(s.meanMs)}</td>
                    <td className={cn(tbl.td, tbl.num, i === 0 && 'font-semibold')}>{formatMs(s.totalMs)}</td>
                  </tr>
                ))}
            </tbody>
          </table>
          <p className="text-muted-foreground border-t px-3 py-2.5 text-[11px]">
            Ranked by total time since the last stats reset.
          </p>
        </>
      )}
    </Panel>
  );
}

/** Info, never an error: the extension is optional. */
export function NotInstalled({ hint }: { hint: string }) {
  return (
    <div className="p-4">
      <div className="bg-muted/60 flex flex-col gap-2.5 rounded-lg px-3.5 py-3 shadow-[inset_0_0_0_1px_var(--edge)]">
        <div className="flex items-start gap-2.5">
          <Info className="text-brand-text mt-px size-4 shrink-0" aria-hidden="true" />
          <div className="flex flex-col gap-0.5">
            <b className="font-semibold">Slow queries need pg_stat_statements</b>
            <span className="text-muted-foreground text-xs">
              The extension is not installed in this database. Run this as a superuser, then reload the panel.
            </span>
          </div>
        </div>
        <div className="bg-background flex items-center gap-2 rounded-md py-1 pr-1 pl-2.5 shadow-[0_0_0_1px_var(--edge),var(--elev-1)]">
          <code className="flex-1 font-mono text-xs select-text">{hint}</code>
          <Button
            variant="ghost"
            size="sm"
            className="h-7 text-xs"
            onClick={() => {
              navigator.clipboard.writeText(hint).then(
                () => toast.success('Copied to the clipboard'),
                () => toast.error('Could not copy'),
              );
            }}
          >
            Copy
          </Button>
        </div>
      </div>
    </div>
  );
}
