import type { Table, TableRef } from '@kleos/shared';
import { Database, Eye, List, RefreshCw, Search, Table2 } from 'lucide-react';
import { useState, type ReactNode } from 'react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Skeleton } from '@/components/ui/skeleton';
import { errorText } from '@/lib/api';
import { formatRowEstimate } from '@/lib/format';
import { cn } from '@/lib/utils';
import { useWorkspace } from './context';
import { sameRef, sidebarSections } from './sidebar-model';

type Props = {
  /** Error of the first introspection, shown instead of the tree. */
  schemaError: string | null;
};

/**
 * Schema picker, filter, and the Tables / Views / Enums of the current schema. Click selects,
 * double-click (or Enter) opens the Data tab.
 */
export function SchemaSidebar({ schemaError }: Props) {
  const { schemaModel, currentSchema, setCurrentSchema, selectedTable, openTable, refreshSchema, readOnly } =
    useWorkspace();
  const [filter, setFilter] = useState('');
  const [refreshing, setRefreshing] = useState(false);
  const sections = sidebarSections(schemaModel, currentSchema, filter);
  const schemas = schemaModel?.schemas ?? [];

  async function refresh() {
    setRefreshing(true);
    try {
      await refreshSchema();
    } catch (err) {
      toast.error('Could not refresh the schema', { description: errorText(err) });
    } finally {
      setRefreshing(false);
    }
  }

  const relationItem = (t: Table, icon: ReactNode) => (
    <SidebarItem
      key={t.name}
      label={t.name}
      icon={icon}
      count={t.kind === 'table' || t.kind === 'partitioned' ? formatRowEstimate(t.rowEstimate) : null}
      selected={sameRef(selectedTable, t)}
      onSelect={() => openTable(ref(t))}
      onOpen={() => openTable(ref(t), 'data')}
    />
  );

  return (
    <aside className="flex w-[244px] shrink-0 flex-col gap-2 px-2.5 pt-1.5 pb-2.5">
      <Select value={schemas.includes(currentSchema) ? currentSchema : undefined} onValueChange={setCurrentSchema}>
        <SelectTrigger size="sm" aria-label={`Schema: ${currentSchema}`} className="bg-background w-full">
          <span className="flex min-w-0 items-center gap-2">
            <Database className="text-muted-foreground size-4" aria-hidden="true" />
            <SelectValue placeholder={schemaModel ? 'No schema' : 'Loading…'} />
          </span>
        </SelectTrigger>
        <SelectContent position="popper">
          {schemas.map((s) => (
            <SelectItem key={s} value={s}>
              {s}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      <div className="relative">
        <Search className="text-muted-foreground absolute top-2 left-2.5 size-4" aria-hidden="true" />
        <Input
          aria-label="Filter tables"
          placeholder="Filter"
          className="bg-background h-8 pl-8"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Escape') setFilter('');
          }}
        />
      </div>

      <nav aria-label="Schema objects" className="-mx-1 flex min-h-0 flex-1 flex-col gap-px overflow-y-auto px-1">
        {schemaError ? (
          <div role="alert" className="text-destructive flex flex-col gap-2 p-2 text-xs">
            <span>Introspection failed: {schemaError}</span>
            <Button variant="outline" size="sm" className="w-fit" onClick={() => void refresh()}>
              Retry
            </Button>
          </div>
        ) : !schemaModel ? (
          <div className="flex flex-col gap-1.5 p-2" aria-label="Loading schema">
            {Array.from({ length: 6 }, (_, i) => (
              <Skeleton key={i} className="h-5 w-full" />
            ))}
          </div>
        ) : (
          <>
            <Section title="Tables" count={sections.tables.length}>
              {sections.tables.map((t) => relationItem(t, <Table2 aria-hidden="true" />))}
            </Section>
            <Section title="Views" count={sections.views.length}>
              {sections.views.map((t) => relationItem(t, <Eye aria-hidden="true" />))}
            </Section>
            <Section title="Enums" count={sections.enums.length}>
              {sections.enums.map((e) => (
                <div
                  key={e.name}
                  title={e.values.join(', ')}
                  className="flex h-7 items-center gap-2 rounded-md px-2 [&_svg]:size-3.5"
                >
                  <List className="text-muted-foreground" aria-hidden="true" />
                  <span className="truncate">{e.name}</span>
                  <span className="text-muted-foreground ml-auto font-mono text-[11px]">{e.values.length}</span>
                </div>
              ))}
            </Section>
            {filter && sections.tables.length + sections.views.length + sections.enums.length === 0 && (
              <p className="text-muted-foreground px-2 py-3 text-xs">
                Nothing in {currentSchema} matches “{filter}”.
              </p>
            )}
          </>
        )}
      </nav>

      <div className="mt-auto flex items-center gap-2 border-t p-2 text-xs">
        <span className="size-2 rounded-full bg-[#22c55e]" aria-hidden="true" />
        <span>Connected</span>
        <span className="text-muted-foreground truncate">· {readOnly ? 'read-only sessions' : 'up to 4 pooled'}</span>
        <Button
          variant="ghost"
          size="icon-sm"
          className="ml-auto size-7"
          aria-label="Refresh schema"
          title="Re-read the schema from pg_catalog"
          disabled={refreshing}
          onClick={() => void refresh()}
        >
          <RefreshCw
            className={cn('text-muted-foreground size-3.5', refreshing && 'animate-spin')}
            aria-hidden="true"
          />
        </Button>
      </div>
    </aside>
  );
}

function ref(t: Table): TableRef {
  return { schema: t.schema, name: t.name };
}

function Section({ title, count, children }: { title: string; count: number; children: ReactNode }) {
  return (
    <div role="group" aria-label={title} className="flex flex-col gap-px">
      <div className="text-muted-foreground flex justify-between px-2 pt-2.5 pb-1 text-[11px] font-semibold tracking-[.04em] uppercase">
        <span>{title}</span>
        <span>{count}</span>
      </div>
      {children}
    </div>
  );
}

function SidebarItem({
  label,
  icon,
  count,
  selected,
  onSelect,
  onOpen,
}: {
  label: string;
  icon: ReactNode;
  count: string | null;
  selected: boolean;
  onSelect(): void;
  onOpen(): void;
}) {
  return (
    <button
      type="button"
      aria-current={selected ? 'true' : undefined}
      onClick={onSelect}
      onDoubleClick={onOpen}
      onKeyDown={(e) => {
        if (e.key === 'Enter') {
          e.preventDefault();
          onOpen();
        }
      }}
      className={cn(
        'focus-visible:ring-ring/50 flex h-7 w-full items-center gap-2 rounded-md px-2 text-left outline-none focus-visible:ring-[3px] [&_svg]:size-3.5 [&_svg]:shrink-0',
        selected ? 'bg-muted font-medium' : 'hover:bg-accent [&_svg]:text-muted-foreground',
      )}
    >
      {icon}
      <span className="truncate">{label}</span>
      {count && <span className="text-muted-foreground ml-auto font-mono text-[11px] font-normal">{count}</span>}
    </button>
  );
}
