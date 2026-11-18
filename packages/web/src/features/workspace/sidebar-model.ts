import { quoteIdent, type EnumType, type SchemaModel, type Table, type TableRef } from '@kleos/shared';

export type SidebarSections = {
  tables: Table[];
  views: Table[];
  enums: EnumType[];
};

const byName = (a: { name: string }, b: { name: string }) => a.name.localeCompare(b.name);

/** Objects of one schema whose name contains `filter` (case-insensitive), sorted by name. */
export function sidebarSections(model: SchemaModel | undefined, schema: string, filter: string): SidebarSections {
  if (!model) return { tables: [], views: [], enums: [] };
  const q = filter.trim().toLowerCase();
  const keep = (item: { schema: string; name: string }) =>
    item.schema === schema && (q === '' || item.name.toLowerCase().includes(q));
  return {
    tables: model.tables.filter(keep).sort(byName),
    views: model.views.filter(keep).sort(byName),
    enums: model.enums.filter(keep).sort(byName),
  };
}

/** "public" when the database has it, else the first user schema. */
/**
 * The schema a workspace opens on: `public` when it holds tables or views, otherwise the
 * schema with the most of them (so a database that keeps everything outside `public`
 * does not open on an empty diagram), otherwise `public` or the first schema.
 */
export function defaultSchema(model: Pick<SchemaModel, 'schemas' | 'tables' | 'views'> | undefined): string {
  const schemas = model?.schemas ?? [];
  const counts = new Map<string, number>();
  for (const r of [...(model?.tables ?? []), ...(model?.views ?? [])]) {
    counts.set(r.schema, (counts.get(r.schema) ?? 0) + 1);
  }
  if ((counts.get('public') ?? 0) > 0) return 'public';
  const busiest = [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0];
  if (busiest) return busiest[0];
  return schemas.includes('public') ? 'public' : (schemas[0] ?? 'public');
}

export function sameRef(a: TableRef | null | undefined, b: TableRef | null | undefined): boolean {
  return !!a && !!b && a.schema === b.schema && a.name === b.name;
}

/** Table or view by reference. */
export function findRelation(model: SchemaModel | undefined, ref: TableRef | null): Table | undefined {
  if (!model || !ref) return undefined;
  return model.tables.find((t) => sameRef(t, ref)) ?? model.views.find((t) => sameRef(t, ref));
}

/** `select * from "schema"."table" limit 100;` with identifiers quoted. */
export function selectStarSql(ref: TableRef): string {
  return `select * from ${quoteIdent(ref.schema)}.${quoteIdent(ref.name)} limit 100;`;
}
