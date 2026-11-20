import { tableKey, type ColumnSpec, type DdlChange } from '@kleos/shared';

const dependents = ' and everything that depends on it';

/** "text, not null, default now()" — the parts of a column a reader checks first. */
export function columnSpecSummary(column: ColumnSpec): string {
  const parts = [column.type.trim()];
  if (column.nullable === false) parts.push('not null');
  if (column.default != null && column.default.trim() !== '') parts.push(`default ${column.default.trim()}`);
  return parts.join(', ');
}

/** One staged change in plain words, e.g. "Allow NULL in public.orders.email". */
export function describeChange(change: DdlChange): string {
  switch (change.op) {
    case 'createTable': {
      const n = change.columns.length;
      const pk = change.primaryKey ?? [];
      const key = pk.length > 0 ? `, primary key (${pk.join(', ')})` : '';
      return `Create table ${change.schema}.${change.name} with ${n} ${n === 1 ? 'column' : 'columns'}${key}`;
    }
    case 'renameTable':
      return `Rename table ${tableKey(change.table)} to ${change.newName}`;
    case 'dropTable':
      return `Drop table ${tableKey(change.table)}${change.cascade ? dependents : ''}`;
    case 'addColumn':
      return `Add column ${change.column.name} (${columnSpecSummary(change.column)}) to ${tableKey(change.table)}`;
    case 'renameColumn':
      return `Rename column ${tableKey(change.table)}.${change.column} to ${change.newName}`;
    case 'alterColumnType': {
      const using = change.using?.trim() ? ` using ${change.using.trim()}` : '';
      return `Change the type of ${tableKey(change.table)}.${change.column} to ${change.type.trim()}${using}`;
    }
    case 'setNotNull':
      return `${change.notNull ? 'Forbid' : 'Allow'} NULL in ${tableKey(change.table)}.${change.column}`;
    case 'setDefault':
      return change.default === null
        ? `Drop the default of ${tableKey(change.table)}.${change.column}`
        : `Set the default of ${tableKey(change.table)}.${change.column} to ${change.default}`;
    case 'dropColumn':
      return `Drop column ${tableKey(change.table)}.${change.column}${change.cascade ? dependents : ''}`;
    case 'createIndex': {
      const kind = [change.unique ? 'unique' : null, change.method ?? 'btree'].filter(Boolean).join(' ');
      const name = change.name ? ` named ${change.name}` : '';
      return `Add a ${kind} index on ${tableKey(change.table)} (${change.columns.join(', ')})${name}`;
    }
    case 'dropIndex':
      return `Drop index ${change.schema}.${change.name}${change.cascade ? dependents : ''}`;
  }
}

/** Removing things is called out in the list (and in the badge counts). */
export function isDestructive(change: DdlChange): boolean {
  return change.op === 'dropTable' || change.op === 'dropColumn' || change.op === 'dropIndex';
}

/** Counts for the panel's badges: what is added, changed and removed. */
export function changeCounts(changes: readonly DdlChange[]): { added: number; altered: number; dropped: number } {
  let added = 0;
  let dropped = 0;
  for (const c of changes) {
    if (c.op === 'createTable' || c.op === 'addColumn' || c.op === 'createIndex') added++;
    else if (isDestructive(c)) dropped++;
  }
  return { added, altered: changes.length - added - dropped, dropped };
}
