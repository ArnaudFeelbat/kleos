import type { Column, Constraint, ForeignKey, Index, Table, TableRef } from '@kleos/shared';
import { ArrowRight, ArrowUpRight, Code, Eye, KeyRound, Table2, X } from 'lucide-react';
import type { ReactNode } from 'react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { sectionLabel } from '@/features/common/styles';
import { formatBytes, formatInt } from '@/lib/format';
import { cn } from '@/lib/utils';
import { shortType } from './er-model';

type Props = {
  table: Table;
  foreignKeys: ForeignKey[];
  onClose(): void;
  onOpenTable(ref: TableRef): void;
  onViewData(): void;
  onOpenInQuery(): void;
};

/** "~1,204,380 rows (estimate) · 412 MB · 6 columns" */
export function relationSummary(table: Table): string {
  const parts: string[] = [];
  if (table.kind === 'view') parts.push('View');
  else if (table.kind === 'materialized') parts.push('Materialized view');
  if (table.kind !== 'view') {
    parts.push(table.rowEstimate < 0 ? 'never analyzed' : `~${formatInt(table.rowEstimate)} rows (estimate)`);
    parts.push(formatBytes(table.totalBytes));
  }
  parts.push(`${table.columns.length} ${table.columns.length === 1 ? 'column' : 'columns'}`);
  return parts.join(' · ');
}

/** "int8 · identity", "order_status · 'pending'::order_status", "timestamptz · now()" */
export function columnDetail(column: Column): string {
  const parts = [shortType(column.type)];
  if (column.identity) parts.push(column.identity === 'always' ? 'identity always' : 'identity');
  else if (column.generated) parts.push('generated');
  else if (column.default !== null) parts.push(column.default);
  return parts.join(' · ');
}

/** "btree (id) unique", from the index's own fields; the full definition is in the title. */
export function indexSummary(index: Index): string {
  return `${index.method} (${index.columns.join(', ')})${index.primary ? ' primary' : index.unique ? ' unique' : ''}`;
}

const constraintLabel: Record<Constraint['type'], string> = {
  p: 'primary key',
  f: 'foreign key',
  u: 'unique',
  c: 'check',
  x: 'exclusion',
  t: 'trigger',
  n: 'not null',
};

/** Right-side panel for the selected table or view: columns, indexes, constraints, and actions. */
export function TableDetailPanel({ table, foreignKeys, onClose, onOpenTable, onViewData, onOpenInQuery }: Props) {
  const ownFks = foreignKeys.filter((fk) => fk.schema === table.schema && fk.table === table.name);
  const refOf = (column: string) => {
    for (const fk of ownFks) {
      const i = fk.columns.indexOf(column);
      if (i >= 0) return { schema: fk.refSchema, name: fk.refTable, column: fk.refColumns[i] ?? '' };
    }
    return null;
  };

  return (
    <aside
      aria-label="Table details"
      className="bg-background animate-in fade-in-0 slide-in-from-right-2 flex w-[340px] shrink-0 flex-col border-l duration-200"
    >
      <div className="flex flex-col gap-2 border-b p-4">
        <div className="flex items-center gap-2.5">
          <span className="bg-brand-soft text-brand-text flex size-7 shrink-0 items-center justify-center rounded-lg">
            {table.kind === 'view' || table.kind === 'materialized' ? (
              <Eye className="size-3.5" aria-hidden="true" />
            ) : (
              <Table2 className="size-3.5" aria-hidden="true" />
            )}
          </span>
          <h2 className="truncate text-[15px] font-semibold tracking-[-0.012em]">{table.name}</h2>
          <Badge variant="outline" className="h-5 font-mono text-[11px]">
            {table.schema}
          </Badge>
          <Button
            variant="ghost"
            size="icon-sm"
            className="text-muted-foreground ml-auto"
            aria-label="Close details"
            title="Close (Esc)"
            onClick={onClose}
          >
            <X aria-hidden="true" />
          </Button>
        </div>
        <span className="text-muted-foreground tabular text-xs">{relationSummary(table)}</span>
        {table.comment && (
          <p className="text-muted-foreground border-border border-l-2 pl-2 text-xs italic">{table.comment}</p>
        )}
      </div>

      <div className="flex min-h-0 flex-1 flex-col overflow-y-auto px-4 pt-1 pb-4">
        <SectionTitle count={table.columns.length}>Columns</SectionTitle>
        {table.columns.map((column) => {
          const isPk = table.primaryKey.includes(column.name);
          const ref = refOf(column.name);
          return (
            <Row key={column.name}>
              {isPk ? (
                <KeyRound className="text-primary-key size-3 shrink-0" role="img" aria-label="Primary key" />
              ) : ref ? (
                <ArrowUpRight className="text-brand-text size-3 shrink-0" role="img" aria-label="Foreign key" />
              ) : (
                <span className="w-3 shrink-0" />
              )}
              <span className={cn('truncate', isPk && 'font-semibold')}>{column.name}</span>
              {column.nullable && (
                <Badge variant="outline" className="text-muted-foreground h-[18px] px-1.5 text-[10px] font-medium">
                  nullable
                </Badge>
              )}
              {ref ? (
                <button
                  type="button"
                  className="text-brand-text hover:bg-brand-soft -mr-1 ml-auto shrink-0 truncate rounded-[4px] px-1 font-mono text-[11px] underline-offset-2 hover:underline"
                  title={`${columnDetail(column)} — open ${ref.schema}.${ref.name}`}
                  onClick={() => onOpenTable({ schema: ref.schema, name: ref.name })}
                >
                  → {ref.schema === table.schema ? '' : `${ref.schema}.`}
                  {ref.name}.{ref.column}
                </button>
              ) : (
                <span
                  className="text-muted-foreground ml-auto max-w-[60%] shrink-0 truncate font-mono text-[11px]"
                  title={columnDetail(column)}
                >
                  {columnDetail(column)}
                </span>
              )}
            </Row>
          );
        })}

        {table.indexes.length > 0 && (
          <>
            <SectionTitle count={table.indexes.length}>Indexes</SectionTitle>
            {table.indexes.map((index) => (
              <Row key={index.name} className="font-mono text-[11.5px]">
                <span className="truncate" title={index.definition}>
                  {index.name}
                </span>
                <span className="text-muted-foreground ml-auto shrink-0">{indexSummary(index)}</span>
              </Row>
            ))}
          </>
        )}

        {table.constraints.length > 0 && (
          <>
            <SectionTitle count={table.constraints.length}>Constraints</SectionTitle>
            {table.constraints.map((c) => (
              <Row key={c.name} className="flex-col items-start gap-0.5">
                <span className="flex w-full items-center gap-2">
                  <span className="truncate font-mono text-[11.5px]">{c.name}</span>
                  <span className="text-muted-foreground ml-auto shrink-0 text-[11px]">{constraintLabel[c.type]}</span>
                </span>
                <span className="text-muted-foreground font-mono text-[11px] break-all whitespace-normal select-text">
                  {c.definition}
                </span>
              </Row>
            ))}
          </>
        )}
      </div>

      <div className="bg-sidebar/60 flex gap-2 border-t px-4 py-3">
        <Button className="flex-1" onClick={onViewData}>
          View data
          <ArrowRight aria-hidden="true" />
        </Button>
        <Button variant="outline" onClick={onOpenInQuery}>
          <Code aria-hidden="true" />
          Open in query
        </Button>
      </div>
    </aside>
  );
}

function SectionTitle({ children, count }: { children: ReactNode; count?: number }) {
  return (
    <h3 className={cn(sectionLabel, 'mt-5 mb-1 flex items-center justify-between first:mt-3.5')}>
      {children}
      {count !== undefined && <span className="font-mono font-medium tracking-normal">{count}</span>}
    </h3>
  );
}

function Row({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <div
      className={cn(
        'hover:bg-foreground/[0.025] -mx-2 flex items-center gap-2 border-b px-2 py-[7px] text-xs dark:hover:bg-white/[0.03]',
        className,
      )}
    >
      {children}
    </div>
  );
}
