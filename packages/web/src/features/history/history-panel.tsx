import { keepPreviousData, useQuery, useQueryClient } from '@tanstack/react-query';
import { CircleX, History, Search, SearchX } from 'lucide-react';
import { useEffect, useRef, useState, type KeyboardEvent } from 'react';
import type { ConnectionColor, HistoryEntry, HistorySearch } from '@kleos/shared';
import { Input } from '@/components/ui/input';
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectSeparator,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Callout } from '@/features/common/callout';
import { EmptyState } from '@/features/common/empty-state';
import { SkeletonList } from '@/features/common/skeletons';
import { connectionColorSwatch } from '@/features/connections/colors';
import { useTabs } from '@/features/shell/tabs-store';
import { useWorkspace } from '@/features/workspace/context';
import { api, errorText, queryKeys } from '@/lib/api';
import { formatClock, formatInt, formatMs } from '@/lib/format';
import { cn } from '@/lib/utils';
import { Highlighted, matchRanges, previewWithMatches } from './highlight';

type Outcome = 'all' | NonNullable<HistorySearch['outcome']>;
/** Server filter: this workspace's server, every server, or one favorite by id. */
type ServerFilter = typeof THIS_SERVER | typeof ALL_SERVERS | string;

const THIS_SERVER = 'this';
const ALL_SERVERS = 'all';
/** Matches asked for per search; the server keeps up to 1,000 runs per server. */
const SEARCH_LIMIT = 200;
const SEARCH_DELAY_MS = 250;

const outcomeLabels: Record<Outcome, string> = {
  all: 'All outcomes',
  ok: 'Succeeded',
  error: 'Failed',
  cancelled: 'Cancelled',
};
const outcomeAdjectives: Record<Outcome, string> = {
  all: '',
  ok: 'successful',
  error: 'failed',
  cancelled: 'cancelled',
};

type ServerInfo = { id: string; nickname: string; color: ConnectionColor };

export type HistoryPanelProps = {
  connectionId: string;
  connectionName: string;
  onLoadHistory(entry: HistoryEntry): void;
  /** Changes when ⌘K “Search history…” asks for the search field. */
  focusRequest?: number;
};

/**
 * History tab of the query side panel: the latest runs of this server, or a full-text search
 * across past runs filtered by server and outcome. ↓/↑ walk the results, Enter loads one.
 */
export function HistoryPanel({ connectionId, connectionName, onLoadHistory, focusRequest }: HistoryPanelProps) {
  const ws = useWorkspace();
  const queryClient = useQueryClient();
  const { tabs } = useTabs();
  const [text, setText] = useState('');
  const [server, setServer] = useState<ServerFilter>(THIS_SERVER);
  const [outcome, setOutcome] = useState<Outcome>('all');
  const [serversWanted, setServersWanted] = useState(false);
  const debounced = useDebouncedValue(text.trim(), SEARCH_DELAY_MS);
  // Clearing the field shows the latest runs at once; only typing waits.
  const q = text.trim() === '' ? '' : debounced;

  const searching = q !== '' || server !== THIS_SERVER || outcome !== 'all';
  const search: HistorySearch = {
    q: q || undefined,
    connectionId: server === ALL_SERVERS ? undefined : server === THIS_SERVER ? connectionId : server,
    outcome: outcome === 'all' ? undefined : outcome,
    limit: SEARCH_LIMIT,
  };

  // The latest runs of this server: Query tab refreshes this key after every run.
  const recent = useQuery({ queryKey: queryKeys.history(connectionId), queryFn: () => api.history(connectionId) });
  const results = useQuery({
    queryKey: queryKeys.historySearch(search),
    queryFn: () => api.searchHistory(search),
    enabled: searching,
    placeholderData: keepPreviousData,
  });
  // A new run refreshed the latest runs: searches may have a new match too.
  const recentUpdatedAt = recent.dataUpdatedAt;
  useEffect(() => {
    if (recentUpdatedAt) void queryClient.invalidateQueries({ queryKey: [queryKeys.historySearch({})[0]] });
  }, [queryClient, recentUpdatedAt]);

  const favorites = useQuery({
    queryKey: queryKeys.connections,
    queryFn: () => api.listConnections(),
    enabled: serversWanted || server !== THIS_SERVER,
  });
  const servers = new Map<string, ServerInfo>();
  for (const f of favorites.data ?? []) servers.set(f.id, f);
  for (const t of tabs) servers.set(t.connectionId, { id: t.connectionId, nickname: t.nickname, color: t.color });
  const openOthers = dedupe(tabs.map((t) => t.connectionId)).filter((id) => id !== connectionId);
  const savedOthers = (favorites.data ?? [])
    .map((f) => f.id)
    .filter((id) => id !== connectionId && !openOthers.includes(id));

  const list = searching ? results : recent;
  const rows = list.data ?? [];
  const showServer = server === ALL_SERVERS;
  const scope =
    server === THIS_SERVER ? connectionName : server === ALL_SERVERS ? 'every server' : nicknameOf(servers, server);

  // ---- keyboard: ↓ from the field into the results, ↓/↑ between them, ↑ back to the field ----
  const inputRef = useRef<HTMLInputElement>(null);
  const rowRefs = useRef<(HTMLButtonElement | null)[]>([]);
  const onFieldKey = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      rowRefs.current[0]?.focus();
    } else if (e.key === 'Escape' && text !== '') {
      e.stopPropagation();
      setText('');
    }
  };
  const onRowKey = (e: KeyboardEvent<HTMLButtonElement>, index: number) => {
    const targets: Record<string, number> = {
      ArrowDown: index + 1,
      ArrowUp: index - 1,
      Home: 0,
      End: rows.length - 1,
    };
    const target = targets[e.key];
    if (target === undefined) return;
    e.preventDefault();
    if (target < 0) inputRef.current?.focus();
    else rowRefs.current[Math.min(target, rows.length - 1)]?.focus();
  };

  // ⌘K “Search history…”: focus the field once this Query tab is in front (hidden fields can't take focus).
  const shown = ws.visible && ws.activeTab === 'query';
  const focusedFor = useRef<number | undefined>(undefined);
  useEffect(() => {
    if (focusRequest === undefined || focusRequest === focusedFor.current || !shown) return;
    focusedFor.current = focusRequest;
    inputRef.current?.focus();
    inputRef.current?.select();
  }, [focusRequest, shown]);

  return (
    <>
      <div className="flex flex-col gap-2 border-b px-3 py-2">
        <div className="relative">
          <Search
            className="text-muted-foreground absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2"
            aria-hidden="true"
          />
          <Input
            ref={inputRef}
            type="search"
            aria-label="Search history"
            placeholder="Search SQL and errors"
            className="h-7 pl-8 text-xs"
            value={text}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={onFieldKey}
          />
        </div>
        <div className="flex gap-2">
          <Select value={server} onValueChange={setServer} onOpenChange={(open) => open && setServersWanted(true)}>
            <SelectTrigger size="sm" aria-label="Server" className="min-w-0 flex-1 px-2 text-xs">
              <SelectValue />
            </SelectTrigger>
            <SelectContent position="popper" align="start">
              <SelectItem value={THIS_SERVER}>This server</SelectItem>
              <SelectItem value={ALL_SERVERS}>All servers</SelectItem>
              {openOthers.length > 0 && (
                <>
                  <SelectSeparator />
                  <SelectGroup>
                    <SelectLabel>Open</SelectLabel>
                    {openOthers.map((id) => (
                      <ServerItem key={id} server={servers.get(id)} id={id} />
                    ))}
                  </SelectGroup>
                </>
              )}
              {savedOthers.length > 0 && (
                <>
                  <SelectSeparator />
                  <SelectGroup>
                    <SelectLabel>Favorites</SelectLabel>
                    {savedOthers.map((id) => (
                      <ServerItem key={id} server={servers.get(id)} id={id} />
                    ))}
                  </SelectGroup>
                </>
              )}
            </SelectContent>
          </Select>
          <Select value={outcome} onValueChange={(v) => setOutcome(v as Outcome)}>
            <SelectTrigger size="sm" aria-label="Outcome" className="min-w-0 flex-1 px-2 text-xs">
              <SelectValue />
            </SelectTrigger>
            <SelectContent position="popper" align="end">
              {(Object.keys(outcomeLabels) as Outcome[]).map((o) => (
                <SelectItem key={o} value={o}>
                  {outcomeLabels[o]}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-auto">
        {list.isPending && <SkeletonList rows={5} rowClassName="h-10 w-full" className="p-3" />}
        {list.isError && (
          <Callout
            tone="error"
            title={searching ? 'Couldn’t search the history' : 'Couldn’t load the history'}
            className="m-3 px-3 py-2.5"
          >
            <span className="text-xs break-words">{errorText(list.error)}</span>
          </Callout>
        )}
        {list.isSuccess &&
          rows.length === 0 &&
          (searching ? (
            <EmptyState
              size="sm"
              icon={SearchX}
              title={q ? `No runs match “${q}”` : `No ${outcomeAdjectives[outcome] || 'past'} runs`}
              hint={
                <>
                  Searched {outcomeAdjectives[outcome] ? `${outcomeAdjectives[outcome]} runs` : 'all runs'} on {scope}.
                  {q && ' Every word must appear in the SQL or its error.'}
                </>
              }
            />
          ) : (
            <EmptyState
              size="sm"
              icon={History}
              title="No runs yet"
              hint="Runs appear here as you execute statements."
            />
          ))}
        {rows.length > 0 && (
          <ul aria-label={searching ? 'Matching runs' : 'Latest runs'} className="m-0 list-none p-0">
            {rows.map((h, i) => (
              <li key={h.id}>
                <HistoryRow
                  entry={h}
                  query={q}
                  server={showServer ? (servers.get(h.connectionId) ?? null) : undefined}
                  rowRef={(el) => {
                    rowRefs.current[i] = el;
                  }}
                  onKeyDown={(e) => onRowKey(e, i)}
                  onClick={() => onLoadHistory(h)}
                />
              </li>
            ))}
          </ul>
        )}
      </div>
      <p className="bg-sidebar/60 text-muted-foreground m-0 border-t px-3 py-2.5 text-[11px]">
        {!searching
          ? `Keeps the latest 1,000 runs for ${connectionName}.`
          : rows.length >= SEARCH_LIMIT
            ? `The newest ${formatInt(SEARCH_LIMIT)} matching runs. Refine the search to see older ones.`
            : list.isSuccess
              ? `${formatInt(rows.length)} matching run${rows.length === 1 ? '' : 's'}, newest first.`
              : 'Searching…'}
      </p>
    </>
  );
}

type HistoryRowProps = {
  entry: HistoryEntry;
  query: string;
  /** Shown when the list spans servers; null when the server is no longer a favorite. */
  server: ServerInfo | null | undefined;
  rowRef(el: HTMLButtonElement | null): void;
  onKeyDown(e: KeyboardEvent<HTMLButtonElement>): void;
  onClick(): void;
};

function HistoryRow({ entry: h, query, server, rowRef, onKeyDown, onClick }: HistoryRowProps) {
  const preview = previewWithMatches(h.sql, query);
  const [code, ...words] = h.error?.split(' ') ?? [];
  const message = words.join(' ');
  return (
    <button
      ref={rowRef}
      type="button"
      className="group hover:bg-foreground/[0.03] focus-visible:bg-brand-soft flex w-full flex-col gap-1 border-b px-3 py-2.5 text-left outline-none dark:hover:bg-white/[0.03]"
      title="Load into the current tab"
      onClick={onClick}
      onKeyDown={onKeyDown}
    >
      <span className="text-muted-foreground flex min-w-0 items-center gap-1.5 text-[11px]">
        {server !== undefined && (
          <span className="text-foreground/80 flex max-w-[45%] min-w-0 shrink-0 items-center gap-1 font-medium">
            <ServerDot color={server?.color ?? 'none'} />
            <span className="truncate">{server?.nickname ?? 'Removed server'}</span>
            <span className="text-muted-foreground font-normal">·</span>
          </span>
        )}
        <span className="shrink-0 font-mono">{whenText(h.ranAt)}</span>
        {h.error ? (
          <>
            <span className="bg-error-bg text-foreground inline-flex h-[18px] shrink-0 items-center gap-1 rounded-[5px] px-1.5 font-mono text-[10.5px] font-semibold shadow-[inset_0_0_0_1px_var(--error-line)]">
              <CircleX className="text-destructive size-2.5" aria-hidden="true" />
              {code}
            </span>
            <span className="truncate">
              <Highlighted text={message} ranges={matchRanges(message, query)} />
            </span>
          </>
        ) : h.cancelled ? (
          <span className="truncate">· cancelled{h.elapsedMs !== null ? ` after ${formatMs(h.elapsedMs)}` : ''}</span>
        ) : (
          <>
            {h.kind === 'explain' && <span>· Explain</span>}
            {h.elapsedMs !== null && <span className="shrink-0">· {formatMs(h.elapsedMs)}</span>}
            {h.rowCount !== null && h.kind === 'query' && (
              <span className="truncate">
                · {formatInt(h.rowCount)} row{h.rowCount === 1 ? '' : 's'}
              </span>
            )}
          </>
        )}
      </span>
      <span className="text-foreground/85 group-hover:text-foreground truncate font-mono text-xs">
        <Highlighted text={preview.text} ranges={preview.ranges} />
      </span>
    </button>
  );
}

function ServerItem({ id, server }: { id: string; server: ServerInfo | undefined }) {
  return (
    <SelectItem value={id}>
      <ServerDot color={server?.color ?? 'none'} />
      <span className="truncate">{server?.nickname ?? 'Unknown server'}</span>
    </SelectItem>
  );
}

function ServerDot({ color }: { color: ConnectionColor }) {
  const swatch = color === 'none' ? undefined : connectionColorSwatch[color];
  return (
    <span
      aria-hidden="true"
      className={cn('size-2 shrink-0 rounded-full', !swatch && 'shadow-[inset_0_0_0_1px_var(--edge)]')}
      style={swatch ? { background: swatch } : undefined}
    />
  );
}

function nicknameOf(servers: Map<string, ServerInfo>, id: string): string {
  return servers.get(id)?.nickname ?? 'that server';
}

function dedupe(ids: string[]): string[] {
  return [...new Set(ids)];
}

/** "10:42" today, "18 Nov 10:42" on another day (searches reach back further than today). */
function whenText(iso: string, now = new Date()): string {
  const d = new Date(iso);
  const clock = formatClock(iso, false);
  if (d.toDateString() === now.toDateString()) return clock;
  return `${d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })} ${clock}`;
}

/** `value` once it has stayed the same for `delay` ms. */
function useDebouncedValue<T>(value: T, delay: number): T {
  const [settled, setSettled] = useState(value);
  useEffect(() => {
    const timer = setTimeout(() => setSettled(value), delay);
    return () => clearTimeout(timer);
  }, [value, delay]);
  return settled;
}
