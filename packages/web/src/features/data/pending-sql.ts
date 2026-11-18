import { quoteIdent, type CellValue, type TableRef } from '@kleos/shared';
import { castType, classifyType, type TypeInfo } from '@/features/cells/classify';
import type { StageState } from './staging';

const plainNumber = /^[+-]?(\d+(\.\d*)?|\.\d+)([eE][+-]?\d+)?$/;

function quoteLiteral(text: string): string {
  return `'${text.replace(/'/g, "''")}'`;
}

/** A value as SQL text: numbers bare, everything else quoted; NULL as NULL. */
export function sqlLiteral(value: CellValue, type: TypeInfo | undefined): string {
  if (value === null) return 'NULL';
  const kind = type ? classifyType(type) : 'other';
  if ((kind === 'integer' || kind === 'number') && plainNumber.test(value)) return value;
  return quoteLiteral(value);
}

/** A value with the explicit cast the server adds, e.g. 1194.00::numeric, 'paid'::order_status. */
function castLiteral(value: CellValue, type: TypeInfo | undefined): string {
  const lit = sqlLiteral(value, type);
  return value === null || !type ? lit : `${lit}::${castType(type)}`;
}

function tableName(t: TableRef): string {
  return `${quoteIdent(t.schema)}.${quoteIdent(t.name)}`;
}

function whereKey(key: Record<string, CellValue>, types: Record<string, TypeInfo>): string {
  return Object.entries(key)
    .map(([c, v]) => (v === null ? `${quoteIdent(c)} IS NULL` : `${quoteIdent(c)} = ${sqlLiteral(v, types[c])}`))
    .join(' AND ');
}

/**
 * The staged edits as readable SQL for review, mirroring what the server runs in one
 * transaction: one UPDATE per changed cell (with a "-- was" note), then DELETEs, then
 * INSERTs listing only the columns given (the others take their DEFAULT). Identifiers are
 * quoted; values carry the cast to their column type. The server sends values as
 * parameters; literals here are for reading only.
 */
export function renderPendingSql(stage: StageState, table: TableRef, types: Record<string, TypeInfo>): string {
  const name = tableName(table);
  const lines: string[] = ['BEGIN;'];
  for (const u of stage.updates) {
    for (const [column, value] of Object.entries(u.set)) {
      const was = u.was[column];
      const note = was === undefined ? '' : `  -- was ${sqlLiteral(was, types[column])}`;
      lines.push(
        `UPDATE ${name} SET ${quoteIdent(column)} = ${castLiteral(value, types[column])} WHERE ${whereKey(u.key, types)};${note}`,
      );
    }
  }
  for (const d of stage.deletes) {
    lines.push(`DELETE FROM ${name} WHERE ${whereKey(d.key, types)};`);
  }
  for (const ins of stage.inserts) {
    const cols = Object.keys(ins.values);
    if (cols.length === 0) {
      lines.push(`INSERT INTO ${name} DEFAULT VALUES;`);
    } else {
      lines.push(`INSERT INTO ${name} (${cols.map(quoteIdent).join(', ')})`);
      lines.push(`  VALUES (${cols.map((c) => castLiteral(ins.values[c] ?? null, types[c])).join(', ')});`);
    }
  }
  lines.push('COMMIT;');
  return lines.join('\n');
}

export type SqlToken = { text: string; kind: 'keyword' | 'string' | 'number' | 'comment' | 'plain' };

const keywords = /^(BEGIN|COMMIT|UPDATE|SET|WHERE|AND|IS|NULL|DELETE|FROM|INSERT|INTO|VALUES|DEFAULT)$/;

/** Splits review SQL into tokens for highlighting (the SQL above only, not a general lexer). */
export function tokenizeSql(sql: string): SqlToken[] {
  const out: SqlToken[] = [];
  const re = /(--[^\n]*)|('(?:[^']|'')*')|("(?:[^"]|"")*")|(\b\d+(?:\.\d+)?(?:[eE][+-]?\d+)?\b)|([A-Za-z_]+)|(\s+|.)/g;
  for (const m of sql.matchAll(re)) {
    const [text, comment, str, ident, num, word] = m;
    if (comment) out.push({ text, kind: 'comment' });
    else if (str) out.push({ text, kind: 'string' });
    else if (ident) out.push({ text, kind: 'plain' });
    else if (num) out.push({ text, kind: 'number' });
    else if (word && keywords.test(word)) out.push({ text, kind: 'keyword' });
    else out.push({ text, kind: 'plain' });
  }
  return out;
}
