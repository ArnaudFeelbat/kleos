import type { Completion } from '@codemirror/autocomplete';
import type { SQLNamespace } from '@codemirror/lang-sql';
import type { SchemaModel } from '@kleos/shared';
import { formatCompact } from '@/lib/format';

/**
 * Autocomplete namespace for lang-sql from the introspected schema: schema -> table ->
 * columns, with the table kind and row estimate, and each column's type, as details.
 */
export function buildSqlNamespace(model: SchemaModel | undefined): SQLNamespace {
  const out: Record<string, Record<string, SQLNamespace>> = {};
  if (!model) return out;
  for (const s of model.schemas) out[s] ??= {};
  for (const t of [...model.tables, ...model.views]) {
    const schema = (out[t.schema] ??= {});
    const isView = t.kind === 'view' || t.kind === 'materialized';
    const rows = t.rowEstimate >= 0 ? ` · ${formatCompact(t.rowEstimate)} rows` : '';
    const self: Completion = {
      label: t.name,
      type: isView ? 'interface' : 'class',
      detail: isView ? 'view' : `table${rows}`,
    };
    schema[t.name] = {
      self,
      children: t.columns.map((c) => ({ label: c.name, type: 'property', detail: c.type })),
    };
  }
  return out;
}
