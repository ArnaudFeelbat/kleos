import { Table2 } from 'lucide-react';
import { tableKey, type TableRef } from '@kleos/shared';
import { useWorkspace } from '@/features/workspace/context';
import { TableView } from './table-view';

/**
 * Data tab: rows of the selected table (useWorkspace().selectedTable) with paging,
 * sorting, filters, type-aware cells and staged editing.
 */
export function DataTab() {
  const ws = useWorkspace();
  const ref = ws.selectedTable;
  if (!ref) {
    return (
      <div className="text-muted-foreground flex flex-1 flex-col items-center justify-center gap-2 p-10 text-center">
        <Table2 className="size-6" aria-hidden="true" />
        <p className="text-foreground font-medium">No table selected</p>
        <p className="max-w-sm text-xs">Pick a table or view in the sidebar to browse, filter and edit its rows.</p>
      </div>
    );
  }
  const key = tableKey(ref);
  const info =
    ws.schemaModel?.tables.find((t) => tableKey(t) === key) ?? ws.schemaModel?.views.find((t) => tableKey(t) === key);
  return (
    <TableView
      key={`${ws.sid}:${key}`}
      sid={ws.sid}
      table={ref}
      info={info}
      schemaModel={ws.schemaModel}
      readOnly={ws.readOnly}
      active={ws.visible && ws.activeTab === 'data'}
      openTable={(target: TableRef) => ws.openTable(target, 'data')}
    />
  );
}
