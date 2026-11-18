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
        'bg-card overflow-hidden rounded-lg border text-xs shadow-[0_1px_3px_rgba(0,0,0,.08)]',
        isSelected && 'ring-ring shadow-[0_6px_16px_rgba(0,0,0,.12)] ring-2',
      )}
      style={{ width: NODE_WIDTH }}
    >
      <div
        className="bg-sidebar flex items-center gap-1.5 border-b px-2.5 text-[13px] font-semibold"
        style={{ height: HEADER_HEIGHT }}
      >
        <Table2 className={cn('size-3.5 shrink-0', !isSelected && 'text-muted-foreground')} aria-hidden="true" />
        <span className="truncate">{table.name}</span>
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
                  className="text-muted-foreground size-3 shrink-0"
                  role="img"
                  aria-label={`Foreign key to ${ref.schema === table.schema ? '' : `${ref.schema}.`}${ref.table}`}
                />
              ) : (
                <span className="w-3 shrink-0" />
              )}
              <span className={cn('truncate', isPk && 'font-semibold')}>{column.name}</span>
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
