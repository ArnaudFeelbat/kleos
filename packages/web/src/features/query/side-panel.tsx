import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ChartLine, Ellipsis } from 'lucide-react';
import { useState } from 'react';
import { toast } from 'sonner';
import type { HistoryEntry, SavedQuery } from '@kleos/shared';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Skeleton } from '@/components/ui/skeleton';
import { api, errorText, queryKeys } from '@/lib/api';
import { formatClock, formatInt, formatMs } from '@/lib/format';
import { cn } from '@/lib/utils';
import { NameDialog } from './name-dialog';

type SidePanelProps = {
  connectionId: string;
  connectionName: string;
  /** Id of the saved query open in the current tab, highlighted in the list. */
  activeSavedId: string | null;
  onLoadHistory(entry: HistoryEntry): void;
  onOpenSaved(saved: SavedQuery): void;
  /** Called after a rename or delete so open tabs can follow. */
  onSavedChanged(saved: SavedQuery | { id: string; deleted: true }): void;
};

const chartTypeName = { line: 'Line', bar: 'Bar', scatter: 'Scatter' } as const;

/** History of runs (recorded by the server) and saved queries of this connection. */
export function SidePanel(props: SidePanelProps) {
  const [tab, setTab] = useState<'history' | 'saved'>('history');
  const saved = useQuery({
    queryKey: queryKeys.savedQueries(props.connectionId),
    queryFn: () => api.savedQueries(props.connectionId),
  });
  return (
    <aside
      aria-label="History and saved queries"
      className="bg-background flex min-h-0 w-[280px] shrink-0 flex-col border-l"
    >
      <div className="border-b px-3 py-2.5">
        <div role="tablist" aria-label="History or saved" className="bg-muted flex gap-0.5 rounded-lg p-[3px]">
          {(['history', 'saved'] as const).map((t) => (
            <button
              key={t}
              type="button"
              role="tab"
              aria-selected={tab === t}
              onClick={() => setTab(t)}
              className={cn(
                'text-muted-foreground inline-flex h-7 flex-1 items-center justify-center gap-1.5 rounded-md font-medium',
                tab === t && 'bg-background text-foreground shadow-sm',
              )}
            >
              {t === 'history' ? 'History' : 'Saved'}
              {t === 'saved' && saved.data && (
                <span className="text-muted-foreground font-mono text-[11px]">{saved.data.length}</span>
              )}
            </button>
          ))}
        </div>
      </div>
      {tab === 'history' ? (
        <HistoryList {...props} />
      ) : (
        <SavedList {...props} items={saved.data} loading={saved.isPending} error={saved.error} />
      )}
    </aside>
  );
}

function HistoryList({ connectionId, connectionName, onLoadHistory }: SidePanelProps) {
  const history = useQuery({ queryKey: queryKeys.history(connectionId), queryFn: () => api.history(connectionId) });
  return (
    <>
      <div className="min-h-0 flex-1 overflow-auto">
        {history.isPending && <ListSkeleton />}
        {history.isError && <p className="text-destructive p-3 text-xs">{errorText(history.error)}</p>}
        {history.data?.length === 0 && (
          <p className="text-muted-foreground p-3 text-xs">Runs appear here as you execute statements.</p>
        )}
        {history.data?.map((h) => (
          <button
            key={h.id}
            type="button"
            className="hover:bg-accent flex w-full flex-col gap-1 border-b px-3 py-2.5 text-left"
            title="Load into the current tab"
            onClick={() => onLoadHistory(h)}
          >
            <span className="text-muted-foreground flex items-center gap-1.5 text-[11px]">
              <span className="font-mono">{formatClock(h.ranAt, false)}</span>
              {h.error ? (
                <>
                  <span className="text-destructive inline-flex h-[18px] items-center rounded-full border border-current px-1.5 font-mono font-medium">
                    {h.error.split(' ')[0]}
                  </span>
                  <span className="truncate">{h.error.split(' ').slice(1).join(' ')}</span>
                </>
              ) : h.cancelled ? (
                <span>· cancelled{h.elapsedMs !== null ? ` after ${formatMs(h.elapsedMs)}` : ''}</span>
              ) : (
                <>
                  {h.kind === 'explain' && <span>· Explain</span>}
                  {h.elapsedMs !== null && <span>· {formatMs(h.elapsedMs)}</span>}
                  {h.rowCount !== null && h.kind === 'query' && (
                    <span>
                      · {formatInt(h.rowCount)} row{h.rowCount === 1 ? '' : 's'}
                    </span>
                  )}
                </>
              )}
            </span>
            <span className="truncate font-mono text-xs">{h.sql.replace(/\s+/g, ' ').trim()}</span>
          </button>
        ))}
      </div>
      <p className="text-muted-foreground m-0 border-t px-3 py-2.5 text-[11px]">
        Keeps the latest 1,000 runs for {connectionName}.
      </p>
    </>
  );
}

function SavedList({
  connectionId,
  activeSavedId,
  onOpenSaved,
  onSavedChanged,
  items,
  loading,
  error,
}: SidePanelProps & { items: SavedQuery[] | undefined; loading: boolean; error: Error | null }) {
  const queryClient = useQueryClient();
  const [renaming, setRenaming] = useState<SavedQuery | null>(null);
  const [deleting, setDeleting] = useState<SavedQuery | null>(null);
  const invalidate = () => queryClient.invalidateQueries({ queryKey: queryKeys.savedQueries(connectionId) });

  const rename = useMutation({
    mutationFn: ({ q, name }: { q: SavedQuery; name: string }) =>
      api.updateSavedQuery(q.id, { connectionId, name, sql: q.sql, chart: q.chart }),
    onSuccess: (q) => {
      setRenaming(null);
      onSavedChanged(q);
      void invalidate();
    },
    onError: (err) => toast.error(errorText(err)),
  });
  const remove = useMutation({
    mutationFn: (q: SavedQuery) => api.deleteSavedQuery(q.id),
    onSuccess: (_v, q) => {
      setDeleting(null);
      onSavedChanged({ id: q.id, deleted: true });
      void invalidate();
    },
    onError: (err) => toast.error(errorText(err)),
  });

  return (
    <>
      <div className="min-h-0 flex-1 overflow-auto">
        {loading && <ListSkeleton />}
        {error && <p className="text-destructive p-3 text-xs">{errorText(error)}</p>}
        {items?.length === 0 && (
          <p className="text-muted-foreground p-3 text-xs">
            Save a query with “Save…” to reopen it here with its chart.
          </p>
        )}
        {items?.map((q) => (
          <div
            key={q.id}
            className={cn('group hover:bg-accent flex items-start border-b', q.id === activeSavedId && 'bg-muted')}
          >
            <button
              type="button"
              className="flex min-w-0 flex-1 flex-col gap-1 px-3 py-2.5 text-left"
              onClick={() => onOpenSaved(q)}
            >
              <b className="flex items-center gap-1.5 truncate font-semibold">
                {q.chart && <ChartLine className="size-3.5 shrink-0" role="img" aria-label="Has chart" />}
                {q.name}
              </b>
              <span className="text-muted-foreground truncate text-xs">
                {q.chart ? (
                  <>
                    {chartTypeName[q.chart.type]} · <span className="font-mono">{q.chart.x}</span> ×{' '}
                    {q.chart.y.join(', ')}
                  </>
                ) : (
                  <>
                    Grid · saved {new Date(q.updatedAt).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })}
                  </>
                )}
              </span>
            </button>
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-xs"
                  className="mt-2 mr-2 opacity-0 group-focus-within:opacity-100 group-hover:opacity-100 data-[state=open]:opacity-100"
                  aria-label={`Actions for ${q.name}`}
                >
                  <Ellipsis />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                <DropdownMenuItem onSelect={() => setRenaming(q)}>Rename…</DropdownMenuItem>
                <DropdownMenuItem variant="destructive" onSelect={() => setDeleting(q)}>
                  Delete…
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        ))}
      </div>
      <p className="text-muted-foreground m-0 border-t px-3 py-2.5 text-[11px]">
        Charts draw from loaded rows only, up to 5,000.
      </p>
      <NameDialog
        open={renaming !== null}
        onOpenChange={(o) => !o && setRenaming(null)}
        title="Rename saved query"
        description="The SQL and chart settings stay as they are."
        initialName={renaming?.name ?? ''}
        submitLabel="Rename"
        pending={rename.isPending}
        onSubmit={(name) => renaming && rename.mutate({ q: renaming, name })}
      />
      <AlertDialog open={deleting !== null} onOpenChange={(o) => !o && setDeleting(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete “{deleting?.name}”?</AlertDialogTitle>
            <AlertDialogDescription>
              The saved query and its chart settings are removed. Open tabs keep their SQL.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction variant="destructive" onClick={() => deleting && remove.mutate(deleting)}>
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}

function ListSkeleton() {
  return (
    <div className="flex flex-col gap-2 p-3" aria-busy="true">
      {Array.from({ length: 5 }, (_, i) => (
        <Skeleton key={i} className="h-10 w-full" />
      ))}
    </div>
  );
}
