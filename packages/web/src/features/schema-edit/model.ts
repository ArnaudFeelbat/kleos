import type { ColumnSpec, DdlChange, SchemaModel } from '@kleos/shared';

/**
 * Types offered in every type box. Free text is still accepted ("varchar(80)", "int[]"): the
 * server resolves it through Postgres, and the preview shows the canonical form or the error.
 */
export const commonTypes = [
  'text',
  'varchar(255)',
  'integer',
  'bigint',
  'smallint',
  'numeric(12,2)',
  'boolean',
  'date',
  'timestamptz',
  'timestamp',
  'time',
  'interval',
  'uuid',
  'jsonb',
  'json',
  'bytea',
  'real',
  'double precision',
  'inet',
  'text[]',
] as const;

/** Common types, then the database's enum types, schema-qualified so search_path can't change them. */
export function typeSuggestions(model: SchemaModel | undefined): string[] {
  const enums = (model?.enums ?? []).map((e) => `${e.schema}.${e.name}`).sort();
  return [...commonTypes, ...enums];
}

const encoder = new TextEncoder();

/** Postgres truncates identifiers past 63 bytes; refuse them instead of renaming silently. */
export function identifierProblem(name: string, what = 'Name'): string | null {
  if (name.trim() === '') return `${what} is required.`;
  if (name !== name.trim()) return `${what} can’t start or end with a space.`;
  if (encoder.encode(name).length > 63) return `${what} is longer than 63 bytes.`;
  return null;
}

export type ColumnDraft = {
  id: string;
  name: string;
  type: string;
  nullable: boolean;
  default: string;
  primaryKey: boolean;
};

export type NewTableDraft = { schema: string; name: string; columns: ColumnDraft[] };

export type NewTableErrors = {
  name?: string;
  /** About the list as a whole ("at least one column"). */
  columns?: string;
  /** Per row id. */
  rows: Record<string, { name?: string; type?: string }>;
};

let draftSeq = 0;
export function emptyColumnDraft(): ColumnDraft {
  return { id: `col-${++draftSeq}`, name: '', type: '', nullable: true, default: '', primaryKey: false };
}

/** A row the user left completely empty is ignored, so a spare last row never blocks Stage. */
export function isBlankRow(c: ColumnDraft): boolean {
  return c.name.trim() === '' && c.type.trim() === '' && c.default.trim() === '' && !c.primaryKey;
}

export function hasErrors(errors: NewTableErrors): boolean {
  return !!errors.name || !!errors.columns || Object.keys(errors.rows).length > 0;
}

/** Checks a New table draft against itself and the tables already in its schema. */
export function validateNewTable(draft: NewTableDraft, existingNames: readonly string[]): NewTableErrors {
  const errors: NewTableErrors = { rows: {} };
  const nameProblem = identifierProblem(draft.name, 'Table name');
  if (nameProblem) errors.name = nameProblem;
  else if (existingNames.includes(draft.name)) errors.name = `${draft.schema} already has a table named ${draft.name}.`;

  const rows = draft.columns.filter((c) => !isBlankRow(c));
  if (rows.length === 0) errors.columns = 'Add at least one column.';
  const seen = new Set<string>();
  for (const c of rows) {
    const row: { name?: string; type?: string } = {};
    const problem = identifierProblem(c.name, 'Column name');
    if (problem) row.name = problem;
    else if (seen.has(c.name)) row.name = `Another column is already named ${c.name}.`;
    seen.add(c.name);
    if (c.type.trim() === '') row.type = 'Type is required.';
    if (row.name || row.type) errors.rows[c.id] = row;
  }
  return errors;
}

export function columnSpecOf(c: Pick<ColumnDraft, 'name' | 'type' | 'nullable' | 'default'>): ColumnSpec {
  const def = c.default.trim();
  return { name: c.name, type: c.type.trim(), nullable: c.nullable, default: def === '' ? null : def };
}

/** The createTable change of a valid draft. A primary-key column is always NOT NULL. */
export function createTableChange(draft: NewTableDraft): Extract<DdlChange, { op: 'createTable' }> {
  const rows = draft.columns.filter((c) => !isBlankRow(c));
  return {
    op: 'createTable',
    schema: draft.schema,
    name: draft.name,
    columns: rows.map((c) => columnSpecOf({ ...c, nullable: c.primaryKey ? false : c.nullable })),
    primaryKey: rows.filter((c) => c.primaryKey).map((c) => c.name),
  };
}

/** The draft a staged createTable came from, so "Edit" reopens the dialog filled in. */
export function draftOf(change: Extract<DdlChange, { op: 'createTable' }>): NewTableDraft {
  const pk = change.primaryKey ?? [];
  return {
    schema: change.schema,
    name: change.name,
    columns: change.columns.map((c) => ({
      ...emptyColumnDraft(),
      name: c.name,
      type: c.type,
      nullable: c.nullable ?? true,
      default: c.default ?? '',
      primaryKey: pk.includes(c.name),
    })),
  };
}
