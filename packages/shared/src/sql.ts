export type StatementRange = {
  /** Statement text without the trailing semicolon, trimmed. */
  text: string;
  /** Offset of the first non-blank character. */
  from: number;
  /** Offset just past the last non-blank character (before the semicolon). */
  to: number;
};

/**
 * Splits SQL into statements on top-level semicolons, skipping semicolons inside
 * quotes, E'' strings, quoted identifiers, dollar-quoted bodies and comments.
 * Statements that contain only comments or whitespace are dropped.
 */
export function splitStatements(sql: string): StatementRange[] {
  const out: StatementRange[] = [];
  let start = 0;
  let i = 0;
  const n = sql.length;

  const push = (end: number) => {
    const range = trimRange(sql, start, end);
    if (range && hasCode(sql.slice(range.from, range.to))) out.push(range);
  };

  while (i < n) {
    const ch = sql[i]!;
    const next = sql[i + 1];
    if (ch === '-' && next === '-') {
      const eol = sql.indexOf('\n', i + 2);
      i = eol === -1 ? n : eol + 1;
    } else if (ch === '/' && next === '*') {
      i = skipBlockComment(sql, i);
    } else if (ch === "'") {
      const escapes = (sql[i - 1] === 'E' || sql[i - 1] === 'e') && !isIdentChar(sql[i - 2]);
      i = skipQuoted(sql, i, "'", escapes);
    } else if (ch === '"') {
      i = skipQuoted(sql, i, '"', false);
    } else if (ch === '$') {
      const tag = /^\$([A-Za-z_\u0080-￿][\w\u0080-￿]*)?\$/.exec(sql.slice(i));
      if (tag && !isIdentChar(sql[i - 1])) {
        const close = sql.indexOf(tag[0], i + tag[0].length);
        i = close === -1 ? n : close + tag[0].length;
      } else {
        i += 1;
      }
    } else if (ch === ';') {
      push(i);
      start = i + 1;
      i += 1;
    } else {
      i += 1;
    }
  }
  push(n);
  return out;
}

/**
 * The statement to run for a cursor at `offset`: the one containing it, or, when the
 * cursor sits between statements, the closest one before it (then the first after it).
 */
export function statementAt(sql: string, offset: number): StatementRange | null {
  const statements = splitStatements(sql);
  if (statements.length === 0) return null;
  const containing = statements.find((s) => offset >= s.from && offset <= s.to + 1);
  if (containing) return containing;
  const before = [...statements].reverse().find((s) => s.to <= offset);
  return before ?? statements[0] ?? null;
}

function skipBlockComment(sql: string, i: number): number {
  let depth = 0;
  let j = i;
  while (j < sql.length) {
    if (sql[j] === '/' && sql[j + 1] === '*') {
      depth += 1;
      j += 2;
    } else if (sql[j] === '*' && sql[j + 1] === '/') {
      depth -= 1;
      j += 2;
      if (depth === 0) return j;
    } else {
      j += 1;
    }
  }
  return sql.length;
}

function skipQuoted(sql: string, i: number, quote: string, backslashEscapes: boolean): number {
  let j = i + 1;
  while (j < sql.length) {
    const ch = sql[j];
    if (backslashEscapes && ch === '\\') {
      j += 2;
    } else if (ch === quote) {
      if (sql[j + 1] === quote) j += 2;
      else return j + 1;
    } else {
      j += 1;
    }
  }
  return sql.length;
}

function isIdentChar(ch: string | undefined): boolean {
  return ch !== undefined && /[\w$\u0080-￿]/.test(ch);
}

function trimRange(sql: string, from: number, to: number): StatementRange | null {
  let a = from;
  let b = to;
  while (a < b && /\s/.test(sql[a]!)) a += 1;
  while (b > a && /\s/.test(sql[b - 1]!)) b -= 1;
  if (a >= b) return null;
  return { text: sql.slice(a, b), from: a, to: b };
}

/** True when the text holds something other than comments and whitespace. */
function hasCode(text: string): boolean {
  const stripped = text.replace(/--[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, '');
  return stripped.trim().length > 0;
}

/** Quotes an identifier the way Postgres's quote_ident does for any input. */
export function quoteIdent(name: string): string {
  return `"${name.replace(/"/g, '""')}"`;
}
