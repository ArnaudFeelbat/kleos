import { statementAt } from '@kleos/shared';

/** The SQL a Run or Explain sends, and where it sits in the editor document. */
export type RunTarget = { sql: string; from: number; to: number };

/**
 * What Run executes: the selection when there is one (trimmed, without a trailing
 * semicolon), else the statement under the cursor (statementAt). Null when the editor
 * holds nothing to run.
 */
export function runTarget(doc: string, selection: { from: number; to: number }): RunTarget | null {
  const from = Math.min(selection.from, selection.to);
  const to = Math.max(selection.from, selection.to);
  if (to > from) {
    const text = doc.slice(from, to);
    const lead = text.length - text.trimStart().length;
    let body = text.trim();
    while (body.endsWith(';')) body = body.slice(0, -1).trimEnd();
    if (body !== '') return { sql: body, from: from + lead, to: from + lead + body.length };
  }
  const stmt = statementAt(doc, selection.to);
  return stmt ? { sql: stmt.text, from: stmt.from, to: stmt.to } : null;
}

/** 1-based line numbers of a range, for "statement on lines 1–10". */
export function lineSpan(doc: string, from: number, to: number): { first: number; last: number } {
  const lineAt = (offset: number) => doc.slice(0, offset).split('\n').length;
  return { first: lineAt(from), last: lineAt(Math.max(from, to)) };
}
