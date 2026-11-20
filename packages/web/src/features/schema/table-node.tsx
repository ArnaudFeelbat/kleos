import type { Column, Table } from '@kleos/shared';
import { Handle, Position, type Node, type NodeProps } from '@xyflow/react';
import { ArrowUpRight, ExternalLink, KeyRound, Table2 } from 'lucide-react';
import { memo } from 'react';
import { useWorkspace } from '@/features/workspace/context';
import { cn } from '@/lib/utils';
import {
  BODY_PADDING,
  HEADER_HEIGHT,
  NODE_WIDTH,
  ROW_HEIGHT,
  columnTypeLabel,
  inHandle,
  outHandle,
  type ColumnRef,
  type TableNodeData,
} from './er-model';

export type TableFlowNode = Node<TableNodeData & { isSelected: boolean }, 'table'>;

/** One table in the ER diagram: header, then a row per column with PK / FK markers and its type. */
export const TableNode = memo(function TableNode({ data }: NodeProps<TableFlowNode>) {
  const { table, references, primaryKey, isSelected } = data;
  if (data.external) return <ExternalTableNode table={table} references={references} primaryKey={primaryKey} />;
  return (
    <div
      className={cn(
        'bg-card overflow-hidden rounded-[10px] text-xs transition-shadow duration-150',
        isSelected
          ? 'shadow-[0_0_0_2px_var(--brand),0_0_0_6px_var(--brand-soft),var(--elev-2)]'
          : 'shadow-[0_0_0_1px_var(--edge),var(--elev-1)] hover:shadow-[0_0_0_1px_var(--edge),var(--elev-2)]',
      )}
      style={{ width: NODE_WIDTH }}
    >
      <div
        className={cn(
          'flex items-center gap-1.5 border-b px-2.5 text-[13px] font-semibold tracking-[-0.01em]',
          isSelected ? 'bg-brand-soft border-brand-line' : 'bg-muted/60 dark:bg-white/[0.035]',
        )}
        style={{ height: HEADER_HEIGHT }}
      >
        <Table2
          className={cn('size-3.5 shrink-0', isSelected ? 'text-brand-text' : 'text-muted-foreground')}
          aria-hidden="true"
        />
        <span className="truncate">{table.name}</span>
        <span className="text-muted-foreground ml-auto font-mono text-[10.5px] font-normal">
          {table.columns.length}
        </span>
      </div>
      <ColumnRows table={table} references={references} primaryKey={primaryKey} />
    </div>
  );
});

type BodyProps = { table: Table; references: Record<string, ColumnRef>; primaryKey: string[] };

/**
 * A table of another schema linked by a foreign key: schema-qualified name, its key columns
 * only, muted with a dashed outline (an outline, so the size matches nodeHeight). Clicks don't
 * select it (its detail panel belongs to the other schema); a double-click shows that schema's
 * diagram with this table selected.
 */
function ExternalTableNode({ table, references, primaryKey }: BodyProps) {
  const { openTable } = useWorkspace();
  return (
    <div
      className="bg-card/70 outline-muted-foreground/45 overflow-hidden rounded-[10px] text-xs outline-1 -outline-offset-1 outline-dashed"
      style={{ width: NODE_WIDTH }}
      title={`In schema ${table.schema}. Double-click to show its diagram.`}
      onClick={(e) => e.stopPropagation()}
      onDoubleClick={(e) => {
        e.stopPropagation();
        openTable({ schema: table.schema, name: table.name });
      }}
    >
      <div
        className="text-muted-foreground flex items-center gap-1.5 border-b border-dashed px-2.5 text-[13px] font-medium tracking-[-0.01em]"
        style={{ height: HEADER_HEIGHT }}
      >
        <ExternalLink className="size-3.5 shrink-0" aria-hidden="true" />
        <span className="truncate">
          <span className="font-normal">{table.schema}.</span>
          <span className="text-foreground/80">{table.name}</span>
        </span>
      </div>
      <ColumnRows table={table} references={references} primaryKey={primaryKey} muted />
    </div>
  );
}

function ColumnRows({ table, references, primaryKey, muted }: BodyProps & { muted?: boolean }) {
  return (
    <div style={{ paddingTop: BODY_PADDING / 2, paddingBottom: BODY_PADDING / 2 }}>
      {table.columns.map((column) => (
        <ColumnRow
          key={column.name}
          column={column}
          schema={table.schema}
          isPk={primaryKey.includes(column.name)}
          reference={references[column.name]}
          muted={muted}
        />
      ))}
    </div>
  );
}

function ColumnRow({
  column,
  schema,
  isPk,
  reference: ref,
  muted,
}: {
  column: Column;
  schema: string;
  isPk: boolean;
  reference: ColumnRef | undefined;
  muted?: boolean;
}) {
  return (
    <div
      className="relative flex items-center gap-1.5 px-2.5"
      style={{ height: ROW_HEIGHT }}
      title={ref && ref.schema !== schema ? `References ${ref.schema}.${ref.table}.${ref.column}` : undefined}
    >
      <Handle type="target" position={Position.Left} id={inHandle(column.name)} isConnectable={false} />
      {isPk ? (
        <KeyRound className="text-primary-key size-3 shrink-0" role="img" aria-label="Primary key" />
      ) : ref ? (
        <ArrowUpRight
          className="text-brand-text size-3 shrink-0"
          role="img"
          aria-label={`Foreign key to ${ref.schema === schema ? '' : `${ref.schema}.`}${ref.table}`}
        />
      ) : (
        <span className="w-3 shrink-0" />
      )}
      <span
        className={cn(
          'truncate',
          muted ? 'text-muted-foreground' : isPk ? 'font-semibold' : 'text-foreground/90',
          muted && isPk && 'font-semibold',
        )}
      >
        {column.name}
      </span>
      <span className="text-muted-foreground ml-auto max-w-[45%] shrink-0 truncate pl-2 font-mono text-[11px]">
        {columnTypeLabel(column)}
      </span>
      <Handle type="source" position={Position.Right} id={outHandle(column.name)} isConnectable={false} />
    </div>
  );
}
