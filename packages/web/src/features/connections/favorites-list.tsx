import type { SavedConnection } from '@kleos/shared';
import { Lock, Plus, Search, SearchX, Server } from 'lucide-react';
import { useMemo, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Callout } from '@/features/common/callout';
import { EmptyState } from '@/features/common/empty-state';
import { SkeletonList } from '@/features/common/skeletons';
import { paneField, paneRow, paneRowSelected, sectionLabel } from '@/features/common/styles';
import { cn } from '@/lib/utils';
import { connectionColorSwatch } from './colors';
import { connectionSubtitle } from './form-model';

export function filterFavorites(favorites: SavedConnection[], search: string): SavedConnection[] {
  const q = search.trim().toLowerCase();
  if (!q) return favorites;
  return favorites.filter((f) => `${f.nickname} ${connectionSubtitle(f)}`.toLowerCase().includes(q));
}

export function ColorDot({ color, className }: { color: SavedConnection['color']; className?: string }) {
  if (color === 'none') {
    return (
      <span
        aria-hidden="true"
        className={cn('border-muted-foreground size-2.5 shrink-0 rounded-full border-[1.5px] border-dashed', className)}
      />
    );
  }
  return (
    <span
      aria-hidden="true"
      className={cn('size-2.5 shrink-0 rounded-full', className)}
      style={{ background: connectionColorSwatch[color] }}
    />
  );
}

type Props = {
  favorites: SavedConnection[] | undefined;
  loading: boolean;
  error: string | null;
  selectedId: string | null;
  onSelect(id: string): void;
  onConnect(id: string): void;
  onNew(): void;
};

/** Left column of the start window: search, saved favorites, New. */
export function FavoritesList({ favorites, loading, error, selectedId, onSelect, onConnect, onNew }: Props) {
  const [search, setSearch] = useState('');
  const shown = useMemo(() => filterFavorites(favorites ?? [], search), [favorites, search]);

  return (
    <aside className="flex w-[280px] shrink-0 flex-col gap-2.5 px-2.5 pt-1.5 pb-2">
      <div className="flex items-center justify-between gap-2 pl-1.5">
        <h2 className="text-[15px] font-semibold tracking-[-0.012em]">Favorites</h2>
        <Button variant="outline" size="xs" className="px-2" onClick={onNew}>
          <Plus aria-hidden="true" />
          New
        </Button>
      </div>
      <div className="relative">
        <Search
          className="text-muted-foreground absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2"
          aria-hidden="true"
        />
        <Input
          aria-label="Search favorites"
          placeholder="Search favorites"
          className={cn(paneField, 'h-8 pl-8')}
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
      </div>
      {favorites && favorites.length > 0 && (
        <div className={cn(sectionLabel, 'flex items-center justify-between px-2 pt-1.5')}>
          <span>Saved</span>
          <span className="font-mono font-medium tracking-normal">{favorites.length}</span>
        </div>
      )}
      <nav aria-label="Saved connections" className="-mx-1 flex min-h-0 flex-1 flex-col gap-0.5 overflow-y-auto px-1">
        {loading && <SkeletonList rows={3} rowClassName="h-11 w-full rounded-lg" label="Loading favorites" />}
        {error && <Callout tone="error" title={error} className="px-3 py-2.5 text-xs break-words" />}
        {!loading && !error && favorites?.length === 0 && (
          <EmptyState
            size="sm"
            icon={Server}
            title="No favorites yet"
            hint="Fill the form and Save. Paste a postgres:// URL to fill it in one go."
            className="flex-none pt-10"
            action={
              <Button size="sm" onClick={onNew}>
                <Plus aria-hidden="true" />
                New connection
              </Button>
            }
          />
        )}
        {!loading && favorites && favorites.length > 0 && shown.length === 0 && (
          <EmptyState size="sm" icon={SearchX} title="No matches" hint={`No favorite matches “${search}”.`} />
        )}
        {shown.map((f) => {
          const selected = f.id === selectedId;
          return (
            <button
              key={f.id}
              type="button"
              aria-current={selected ? 'true' : undefined}
              title="Double-click or press Enter to connect"
              onClick={() => onSelect(f.id)}
              onDoubleClick={() => onConnect(f.id)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault();
                  onConnect(f.id);
                }
              }}
              className={cn(
                'flex items-start gap-2.5 rounded-lg px-2.5 py-2 text-left',
                paneRow,
                selected && paneRowSelected,
              )}
            >
              <ColorDot color={f.color} className="mt-[5px]" />
              <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                <span className="flex items-center gap-1.5">
                  <b className="truncate font-semibold">{f.nickname}</b>
                  {f.readOnly && (
                    <Lock
                      className={cn('size-3 shrink-0', selected ? 'text-brand-text' : 'text-muted-foreground')}
                      aria-label="Read-only"
                    />
                  )}
                </span>
                <span className="text-muted-foreground truncate font-mono text-[11px]">{connectionSubtitle(f)}</span>
              </span>
            </button>
          );
        })}
      </nav>
      <p className="border-foreground/[0.07] text-muted-foreground -mx-0.5 mt-auto flex items-center gap-2 border-t px-2 pt-2 text-xs">
        <Lock className="size-3 shrink-0" aria-hidden="true" />
        Passwords are kept in the macOS Keychain.
      </p>
    </aside>
  );
}
