import type { SavedConnection } from '@kleos/shared';
import { Lock, Plus, Search } from 'lucide-react';
import { useMemo, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Skeleton } from '@/components/ui/skeleton';
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
    <aside className="flex w-[280px] shrink-0 flex-col gap-3 px-3 pt-2 pb-3">
      <div className="flex items-center justify-between gap-2">
        <h2 className="text-[15px] font-semibold">Favorites</h2>
        <Button variant="outline" size="sm" className="h-7 px-2.5 text-xs" onClick={onNew}>
          <Plus className="size-3.5" aria-hidden="true" />
          New
        </Button>
      </div>
      <div className="relative">
        <Search className="text-muted-foreground absolute top-2 left-2.5 size-4" aria-hidden="true" />
        <Input
          aria-label="Search favorites"
          placeholder="Search favorites"
          className="h-8 pl-8"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
      </div>
      <nav aria-label="Saved connections" className="-mx-1 flex min-h-0 flex-1 flex-col gap-1 overflow-y-auto px-1">
        {loading && (
          <>
            <Skeleton className="h-12 w-full" />
            <Skeleton className="h-12 w-full" />
          </>
        )}
        {error && <p className="text-destructive text-xs">{error}</p>}
        {!loading && !error && favorites?.length === 0 && (
          <p className="text-muted-foreground px-2 text-xs">No favorites yet. Fill the form and Save.</p>
        )}
        {!loading && favorites && favorites.length > 0 && shown.length === 0 && (
          <p className="text-muted-foreground px-2 text-xs">No favorite matches “{search}”.</p>
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
                'focus-visible:ring-ring/50 flex items-start gap-2.5 rounded-lg p-2.5 text-left outline-none focus-visible:ring-[3px]',
                selected ? 'bg-accent shadow-[inset_0_0_0_1px_var(--border)]' : 'hover:bg-accent/60',
              )}
            >
              <ColorDot color={f.color} className="mt-1" />
              <span className="flex min-w-0 flex-1 flex-col">
                <span className="flex items-center gap-1.5">
                  <b className="truncate font-semibold">{f.nickname}</b>
                  {f.readOnly && <Lock className="text-muted-foreground size-[13px] shrink-0" aria-label="Read-only" />}
                </span>
                <span className="text-muted-foreground truncate font-mono text-[11px]">{connectionSubtitle(f)}</span>
              </span>
            </button>
          );
        })}
      </nav>
      <p className="text-muted-foreground mt-auto flex items-center gap-2 text-xs">
        <Lock className="size-3.5" aria-hidden="true" />
        Passwords are kept in the macOS Keychain.
      </p>
    </aside>
  );
}
