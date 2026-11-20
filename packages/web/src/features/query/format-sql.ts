import type { EditorView } from '@codemirror/view';
import { formatDialect, postgresql, type FormatOptionsWithDialect } from 'sql-formatter';

/** Kleos's SQL style: PostgreSQL, lowercase keywords and types, two-space indent. */
const options: FormatOptionsWithDialect = {
  dialect: postgresql,
  keywordCase: 'lower',
  dataTypeCase: 'lower',
  tabWidth: 2,
  // Kept as written: $1… and :name are what the parameter prompt looks for.
  paramTypes: { numbered: ['$'], named: [':'] },
};

export type FormatOutcome = { ok: true; text: string } | { ok: false; message: string };

/**
 * Formats SQL, keeping the blank space around it (so a formatted selection sits where it was).
 * A parse failure comes back as a short message with its line, relative to `firstLine`.
 */
export function formatSql(sql: string, firstLine = 1): FormatOutcome {
  const lead = /^\s*/.exec(sql)![0];
  const trail = /\s*$/.exec(sql.slice(lead.length))![0];
  const body = sql.slice(lead.length, sql.length - trail.length);
  if (body === '') return { ok: true, text: sql };
  try {
    return { ok: true, text: lead + formatDialect(body, options) + trail };
  } catch (err) {
    const raw = err instanceof Error ? err.message : String(err);
    const at = /line (\d+) column (\d+)/.exec(raw);
    // The body starts on the line after any blank lines that lead it.
    const offset = firstLine + (lead.match(/\n/g)?.length ?? 0) - 1;
    const where = at ? ` near line ${Number(at[1]) + offset}, column ${at[2]}` : '';
    return { ok: false, message: `Couldn’t format: the SQL doesn’t parse${where}. Nothing changed.` };
  }
}

/**
 * Formats the editor's selection, or the whole document when nothing is selected, as a single
 * transaction (one undo step restores the original). Returns the failure message, if any.
 */
export function formatInEditor(view: EditorView): string | null {
  const { state } = view;
  const sel = state.selection.main;
  const whole = sel.empty;
  const from = whole ? 0 : sel.from;
  const to = whole ? state.doc.length : sel.to;
  const original = state.doc.sliceString(from, to);
  const result = formatSql(original, state.doc.lineAt(from).number);
  if (!result.ok) return result.message;
  if (result.text === original) return null;
  view.dispatch({
    changes: { from, to, insert: result.text },
    selection: whole
      ? { anchor: Math.min(sel.head, result.text.length) }
      : { anchor: from, head: from + result.text.length },
    userEvent: 'format',
    scrollIntoView: true,
  });
  return null;
}
