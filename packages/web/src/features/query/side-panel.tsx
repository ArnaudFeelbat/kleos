import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Bookmark, Braces, ChartLine, Ellipsis, History, type LucideIcon } from 'lucide-react';
import { useEffect, useState } from 'react';
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
import { Callout } from '@/features/common/callout';
import { EmptyState } from '@/features/common/empty-state';
import { SkeletonList } from '@/features/common/skeletons';
import { segmentedItem, segmentedList } from '@/features/common/styles';
import { HistoryPanel } from '@/features/history/history-panel';
import { takeHistorySearchRequest, useHistorySearchRequest } from '@/features/history/search-request';
import { SnippetsPanel } from '@/features/snippets/snippets-panel';
import { useWorkspace } from '@/features/workspace/context';
import { api, errorText, queryKeys } from '@/lib/api';
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

type PanelTab = 'history' | 'saved' | 'snippets';
const panelTabs: { tab: PanelTab; label: string; icon: LucideIcon }[] = [
  { tab: 'history', label: 'History', icon: History },
  { tab: 'saved', label: 'Saved', icon: Bookmark },
  { tab: 'snippets', label: 'Snippets', icon: Braces },
];

const chartTypeName = { line: 'Line', bar: 'Bar', scatter: 'Scatter' } as const;

/**
 * History of runs (recorded by the server, searchable across servers), saved queries of this
 * connection, and the snippets shared by every server.
 */
export function SidePanel(props: SidePanelProps) {
  const { sid } = useWorkspace();
  const [tab, setTab] = useState<PanelTab>('history');
  const saved = useQuery({
    queryKey: queryKeys.savedQueries(props.connectionId),
    queryFn: () => api.savedQueries(props.connectionId),
  });

  // ⌘K "Search history…": switch to History (state adjusted while rendering, React's pattern
  // for state that follows a changing input), then mark the request taken.
  const searchRequest = useHistorySearchRequest(sid);
  const [focusRequest, setFocusRequest] = useState<number | undefined>(undefined);
  if (searchRequest !== undefined && searchRequest !== focusRequest) {
    setFocusRequest(searchRequest);
    setTab('history');
  }
  useEffect(() => {
    if (searchRequest !== undefined) takeHistorySearchRequest(sid, searchRequest);
  }, [sid, searchRequest]);

  return (
    <aside
      aria-label="History, saved queries and snippets"
      className="bg-background flex min-h-0 w-[280px] shrink-0 flex-col border-l"
    >
      <div className="flex min-h-11 items-center border-b px-3 py-1.5">
        <div role="tablist" aria-label="Side panel" className={cn(segmentedList, 'flex w-full')}>
          {panelTabs.map(({ tab: t, label, icon: Icon }) => (
            <button
              key={t}
              type="button"
              role="tab"
              aria-selected={tab === t}
              onClick={() => setTab(t)}
              className={cn(segmentedItem, 'flex-1 gap-1 px-1.5')}
            >
              <Icon aria-hidden="true" />
              {label}
              {t === 'saved' && saved.data && (
                <span className="text-muted-foreground font-mono text-[11px] font-normal">{saved.data.length}</span>
              )}
            </button>
          ))}
        </div>
      </div>
      {tab === 'history' && (
        <HistoryPanel
          connectionId={props.connectionId}
          connectionName={props.connectionName}
          onLoadHistory={props.onLoadHistory}
          focusRequest={focusRequest}
        />
      )}
      {tab === 'saved' && <SavedList {...props} items={saved.data} loading={saved.isPending} error={saved.error} />}
      {tab === 'snippets' && <SnippetsPanel />}
    </aside>
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
        {error && (
          <Callout tone="error" title="Couldn’t load saved queries" className="m-3 px-3 py-2.5">
            <span className="text-xs break-words">{errorText(error)}</span>
          </Callout>
        )}
        {items?.length === 0 && (
          <EmptyState
            size="sm"
            icon={Bookmark}
            title="No saved queries"
            hint="Save a query with “Save…” to reopen it here with its chart."
          />
        )}
        {items?.map((q) => (
          <div
            key={q.id}
            className={cn(
              'group flex items-start border-b',
              q.id === activeSavedId
                ? 'bg-brand-soft shadow-[inset_2px_0_0_var(--brand)]'
                : 'hover:bg-foreground/[0.03] dark:hover:bg-white/[0.03]',
            )}
          >
            <button
              type="button"
              className="flex min-w-0 flex-1 flex-col gap-1 px-3 py-2.5 text-left"
              onClick={() => onOpenSaved(q)}
            >
              <b className="flex items-center gap-1.5 truncate font-semibold">
                {q.chart && (
                  <ChartLine className="text-brand-text size-3.5 shrink-0" role="img" aria-label="Has chart" />
                )}
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
      <p className="bg-sidebar/60 text-muted-foreground m-0 border-t px-3 py-2.5 text-[11px]">
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
  return <SkeletonList rows={5} rowClassName="h-10 w-full" className="p-3" />;
}
