import type { Table, TableRef } from '@kleos/shared';
import { Database, Eye, List, RefreshCw, Search, SearchX, Table2 } from 'lucide-react';
import { useState, type ReactNode } from 'react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Callout } from '@/features/common/callout';
import { EmptyState } from '@/features/common/empty-state';
import { SkeletonList } from '@/features/common/skeletons';
import { paneField, paneRow, paneRowSelected, sectionLabel } from '@/features/common/styles';
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
    <aside className="flex w-[244px] shrink-0 flex-col gap-2 px-2.5 pt-1.5 pb-2">
      <Select value={schemas.includes(currentSchema) ? currentSchema : undefined} onValueChange={setCurrentSchema}>
        <SelectTrigger
          aria-label={`Schema: ${currentSchema}`}
          className={cn(paneField, 'w-full font-medium hover:border-transparent')}
        >
          <span className="flex min-w-0 items-center gap-2">
            <span className="bg-brand-soft text-brand-text flex size-5 shrink-0 items-center justify-center rounded-[5px]">
              <Database className="size-3" aria-hidden="true" />
            </span>
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
        <Search
          className="text-muted-foreground absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2"
          aria-hidden="true"
        />
        <Input
          aria-label="Filter tables"
          placeholder="Filter"
          className={cn(paneField, 'h-8 pl-8')}
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Escape') setFilter('');
          }}
        />
      </div>

      <nav aria-label="Schema objects" className="-mx-1 flex min-h-0 flex-1 flex-col gap-px overflow-y-auto px-1 pb-2">
        {schemaError ? (
          <Callout role="alert" tone="error" title="Introspection failed" className="mt-2 px-3 py-2.5">
            <span className="text-xs break-words">{schemaError}</span>
            <Button variant="outline" size="xs" className="mt-1.5 w-fit" onClick={() => void refresh()}>
              Retry
            </Button>
          </Callout>
        ) : !schemaModel ? (
          <SkeletonList rows={7} label="Loading schema" className="px-2 pt-3" />
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
                  className="text-foreground/85 flex h-7 items-center gap-2 rounded-md px-2 [&_svg]:size-3.5"
                >
                  <List className="text-muted-foreground shrink-0" aria-hidden="true" />
                  <span className="truncate">{e.name}</span>
                  <span className="text-muted-foreground ml-auto font-mono text-[11px]">{e.values.length}</span>
                </div>
              ))}
            </Section>
            {filter && sections.tables.length + sections.views.length + sections.enums.length === 0 && (
              <EmptyState
                size="sm"
                icon={SearchX}
                title="No matches"
                hint={`Nothing in ${currentSchema} matches “${filter}”.`}
                className="flex-none"
              />
            )}
          </>
        )}
      </nav>

      <div className="border-foreground/[0.07] -mx-0.5 mt-auto flex items-center gap-2 border-t px-2 pt-2 text-xs">
        <span
          className="bg-success size-[7px] shrink-0 rounded-full shadow-[0_0_0_3px_color-mix(in_srgb,var(--success)_18%,transparent)]"
          aria-hidden="true"
        />
        <span className="font-medium">Connected</span>
        <span className="text-muted-foreground truncate">· {readOnly ? 'read-only sessions' : 'up to 4 pooled'}</span>
        <Button
          variant="ghost"
          size="icon-sm"
          className="text-muted-foreground hover:text-foreground ml-auto size-6 hover:bg-black/[0.05] dark:hover:bg-white/[0.07]"
          aria-label="Refresh schema"
          title="Re-read the schema from pg_catalog"
          disabled={refreshing}
          onClick={() => void refresh()}
        >
          <RefreshCw className={cn('size-3.5', refreshing && 'animate-spin')} aria-hidden="true" />
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
      <div className={cn(sectionLabel, 'flex items-center justify-between px-2 pt-3 pb-1')}>
        <span>{title}</span>
        <span className="font-mono font-medium tracking-normal">{count}</span>
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
        'flex h-7 w-full items-center gap-2 rounded-md px-2 text-left [&_svg]:size-3.5 [&_svg]:shrink-0',
        paneRow,
        selected
          ? cn(paneRowSelected, 'font-medium [&_svg]:text-brand-text')
          : 'text-foreground/85 hover:text-foreground [&_svg]:text-muted-foreground',
      )}
    >
      {icon}
      <span className="truncate">{label}</span>
      {count && <span className="text-muted-foreground ml-auto font-mono text-[11px] font-normal">{count}</span>}
    </button>
  );
}
