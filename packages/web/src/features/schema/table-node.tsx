import { Handle, Position, type Node, type NodeProps } from '@xyflow/react';
import { ArrowUpRight, KeyRound, Table2 } from 'lucide-react';
import { memo } from 'react';
import { cn } from '@/lib/utils';
import {
  BODY_PADDING,
  HEADER_HEIGHT,
  NODE_WIDTH,
  ROW_HEIGHT,
  columnTypeLabel,
  inHandle,
  outHandle,
  type TableNodeData,
} from './er-model';

export type TableFlowNode = Node<TableNodeData & { isSelected: boolean }, 'table'>;

/** One table in the ER diagram: header, then a row per column with PK / FK markers and its type. */
export const TableNode = memo(function TableNode({ data }: NodeProps<TableFlowNode>) {
  const { table, references, primaryKey, isSelected } = data;
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
      <div style={{ paddingTop: BODY_PADDING / 2, paddingBottom: BODY_PADDING / 2 }}>
        {table.columns.map((column) => {
          const isPk = primaryKey.includes(column.name);
          const ref = references[column.name];
          return (
            <div
              key={column.name}
              className="relative flex items-center gap-1.5 px-2.5"
              style={{ height: ROW_HEIGHT }}
              title={
                ref && ref.schema !== table.schema ? `References ${ref.schema}.${ref.table}.${ref.column}` : undefined
              }
            >
              <Handle type="target" position={Position.Left} id={inHandle(column.name)} isConnectable={false} />
              {isPk ? (
                <KeyRound className="text-primary-key size-3 shrink-0" role="img" aria-label="Primary key" />
              ) : ref ? (
                <ArrowUpRight
                  className="text-brand-text size-3 shrink-0"
                  role="img"
                  aria-label={`Foreign key to ${ref.schema === table.schema ? '' : `${ref.schema}.`}${ref.table}`}
                />
              ) : (
                <span className="w-3 shrink-0" />
              )}
              <span className={cn('truncate', isPk ? 'font-semibold' : 'text-foreground/90')}>{column.name}</span>
              <span className="text-muted-foreground ml-auto max-w-[45%] shrink-0 truncate pl-2 font-mono text-[11px]">
                {columnTypeLabel(column)}
              </span>
              <Handle type="source" position={Position.Right} id={outHandle(column.name)} isConnectable={false} />
            </div>
          );
        })}
      </div>
    </div>
  );
});
