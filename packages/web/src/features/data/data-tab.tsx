import { Table2 } from 'lucide-react';
import { tableKey, type TableRef } from '@kleos/shared';
import { EmptyState } from '@/features/common/empty-state';
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
      <EmptyState
        icon={Table2}
        title="No table selected"
        hint="Pick a table or view in the sidebar to browse, filter and edit its rows."
      />
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
