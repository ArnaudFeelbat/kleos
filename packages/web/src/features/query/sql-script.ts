/**
 * A small SQL lexer for the editor: it knows where strings, quoted identifiers, dollar-quoted
 * bodies and comments are, which is all Run, Run all and the parameter prompt need. It never
 * parses SQL; everything that is not one of those regions is "code".
 */

export type SqlRegionKind = 'code' | 'string' | 'identifier' | 'dollar' | 'comment';
export type SqlRegion = { kind: SqlRegionKind; from: number; to: number };

/** One statement of a script, as Run all executes it. */
export type ScriptStatement = {
  /** Statement text without the trailing semicolon, trimmed (leading comments included). */
  text: string;
  /** Offset of the first non-blank character in the document. */
  from: number;
  /** Offset just past the last non-blank character, before the semicolon. */
  to: number;
  /** Offset of the statement's first code, past any leading comment. */
  codeFrom: number;
  /** 1-based line of `codeFrom`. */
  line: number;
  /** That line, from the first code character, trimmed: what the statements list shows. */
  preview: string;
};

/** The regions of `sql`, in order, covering it entirely. Unterminated regions run to the end. */
export function sqlRegions(sql: string): SqlRegion[] {
  const out: SqlRegion[] = [];
  const n = sql.length;
  let codeStart = 0;
  let i = 0;
  const region = (kind: SqlRegionKind, from: number, to: number) => {
    if (from > codeStart) out.push({ kind: 'code', from: codeStart, to: from });
    out.push({ kind, from, to });
    codeStart = to;
    i = to;
  };
  while (i < n) {
    const ch = sql[i]!;
    const next = sql[i + 1];
    if (ch === '-' && next === '-') {
      const eol = sql.indexOf('\n', i + 2);
      region('comment', i, eol === -1 ? n : eol);
    } else if (ch === '/' && next === '*') {
      region('comment', i, skipBlockComment(sql, i));
    } else if (ch === "'") {
      // E'…' strings take backslash escapes; a plain 'E' at the end of an identifier does not count.
      const escapes = (sql[i - 1] === 'E' || sql[i - 1] === 'e') && !isIdentChar(sql[i - 2]);
      region('string', i, skipQuoted(sql, i, "'", escapes));
    } else if (ch === '"') {
      region('identifier', i, skipQuoted(sql, i, '"', false));
    } else if (ch === '$' && !isIdentChar(sql[i - 1])) {
      // $tag$ or $$; "$1" is a parameter (a tag cannot start with a digit) and stays code.
      const tag = /^\$(?:[A-Za-z_\u0080-￿][\w\u0080-￿]*)?\$/.exec(sql.slice(i, i + 200));
      if (tag) {
        const close = sql.indexOf(tag[0], i + tag[0].length);
        region('dollar', i, close === -1 ? n : close + tag[0].length);
      } else {
        i += 1;
      }
    } else {
      i += 1;
    }
  }
  if (n > codeStart) out.push({ kind: 'code', from: codeStart, to: n });
  return out;
}

/**
 * Splits a script into statements on top-level semicolons. Semicolons inside strings, E''
 * strings, quoted identifiers, dollar-quoted bodies (function bodies stay whole) and comments,
 * nested block comments included, do not split. Statements holding only comments or blanks
 * are skipped.
 */
export function splitScript(sql: string): ScriptStatement[] {
  const regions = sqlRegions(sql);
  const out: ScriptStatement[] = [];
  let start = 0;
  /** First offset of the current statement that is neither blank nor comment. */
  let firstCode = -1;

  const push = (end: number) => {
    if (firstCode !== -1) {
      let from = start;
      let to = end;
      while (from < to && /\s/.test(sql[from]!)) from += 1;
      while (to > from && /\s/.test(sql[to - 1]!)) to -= 1;
      const lineStart = sql.lastIndexOf('\n', firstCode - 1) + 1;
      const lineEnd = indexOrEnd(sql, '\n', firstCode);
      out.push({
        text: sql.slice(from, to),
        from,
        to,
        codeFrom: firstCode,
        line: lineNumber(sql, lineStart),
        preview: sql.slice(firstCode, Math.min(lineEnd, to)).trimEnd(),
      });
    }
    firstCode = -1;
  };

  for (const r of regions) {
    if (r.kind === 'comment') continue;
    if (r.kind !== 'code') {
      if (firstCode === -1) firstCode = r.from;
      continue;
    }
    for (let i = r.from; i < r.to; i += 1) {
      const ch = sql[i]!;
      if (ch === ';') {
        push(i);
        start = i + 1;
      } else if (firstCode === -1 && !/\s/.test(ch)) {
        firstCode = i;
      }
    }
  }
  push(sql.length);
  return out;
}

/**
 * The statement to run for a cursor at `offset`: the one containing it (or ending right before
 * its semicolon), else the closest one before it, else the first one after it.
 */
export function statementAtOffset(sql: string, offset: number): ScriptStatement | null {
  const statements = splitScript(sql);
  if (statements.length === 0) return null;
  const containing = statements.find((s) => offset >= s.from && offset <= s.to + 1);
  if (containing) return containing;
  const before = [...statements].reverse().find((s) => s.to <= offset);
  return before ?? statements[0] ?? null;
}

function lineNumber(sql: string, offset: number): number {
  let line = 1;
  for (let i = sql.indexOf('\n'); i !== -1 && i < offset; i = sql.indexOf('\n', i + 1)) line += 1;
  return line;
}

function indexOrEnd(sql: string, needle: string, from: number): number {
  const at = sql.indexOf(needle, from);
  return at === -1 ? sql.length : at;
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

export function isIdentChar(ch: string | undefined): boolean {
  return ch !== undefined && /[\w$\u0080-￿]/.test(ch);
}
