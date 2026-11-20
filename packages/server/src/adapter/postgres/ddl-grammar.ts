/**
 * The two pieces of user text that schema editing writes into DDL, checked lexically before
 * anything reaches Postgres:
 *
 * - column types, parsed with a strict grammar so the probe that asks Postgres about them
 *   (`select null::<type>`) can only ever be a type name; the statement itself then gets
 *   Postgres's own format_type() spelling, never the typed text;
 * - default and USING expressions, written as given (they are the user's SQL, shown in the
 *   preview) but refused when they could step out of their slot in the statement.
 */

/** Pseudo-types that only exist in CREATE TABLE and ADD COLUMN; Postgres expands them itself. */
export const serialTypes = ['smallserial', 'serial2', 'serial', 'serial4', 'bigserial', 'serial8'] as const;

export type ParsedType =
  /** A real type: `probe` is safe to splice after `null::` and Postgres resolves it. */
  { kind: 'type'; probe: string } | { kind: 'serial'; name: (typeof serialTypes)[number] };

type Token =
  | { kind: 'word'; text: string; lower: string }
  | { kind: 'quoted'; text: string }
  | { kind: 'number'; text: string }
  | { kind: 'punct'; text: '.' | '(' | ')' | ',' | '[' | ']' };

const WORD = /^[A-Za-z_\u0080-￿][A-Za-z0-9_$\u0080-￿]*/;
const QUOTED = /^"(?:[^"\0]|"")+"/;
const NUMBER = /^[0-9]+/;

/** Splits a type into tokens; null when it holds anything outside the grammar's alphabet. */
function tokenize(text: string): Token[] | null {
  const tokens: Token[] = [];
  let rest = text;
  while (rest.length > 0) {
    const space = /^\s+/.exec(rest);
    if (space) {
      rest = rest.slice(space[0].length);
      continue;
    }
    const ch = rest[0]!;
    let match: RegExpExecArray | null;
    if ('.(),[]'.includes(ch)) {
      tokens.push({ kind: 'punct', text: ch as '.' });
      rest = rest.slice(1);
    } else if ((match = WORD.exec(rest))) {
      tokens.push({ kind: 'word', text: match[0], lower: match[0].toLowerCase() });
      rest = rest.slice(match[0].length);
    } else if ((match = QUOTED.exec(rest))) {
      tokens.push({ kind: 'quoted', text: match[0] });
      rest = rest.slice(match[0].length);
    } else if ((match = NUMBER.exec(rest))) {
      tokens.push({ kind: 'number', text: match[0] });
      rest = rest.slice(match[0].length);
    } else {
      return null;
    }
  }
  return tokens;
}

const intervalFields = ['year', 'month', 'day', 'hour', 'minute', 'second'];
/** INTERVAL's field qualifiers: a single field, or "a to b" with a before b. */
const intervalRanges = new Set([
  'year to month',
  'day to hour',
  'day to minute',
  'day to second',
  'hour to minute',
  'hour to second',
  'minute to second',
]);

/**
 * A recursive-descent parser over the tokens. Every method either consumes what it expects
 * and returns its normalized text, or returns null; the caller then rejects the whole type.
 */
class TypeParser {
  private i = 0;
  constructor(private readonly tokens: Token[]) {}

  private peek(offset = 0): Token | undefined {
    return this.tokens[this.i + offset];
  }

  private isWord(word: string, offset = 0): boolean {
    const t = this.peek(offset);
    return t?.kind === 'word' && t.lower === word;
  }

  private isPunct(text: Token['text'], offset = 0): boolean {
    const t = this.peek(offset);
    return t?.kind === 'punct' && t.text === text;
  }

  get done(): boolean {
    return this.i === this.tokens.length;
  }

  /** `(n)` or, when `max` is 2, `(p, s)`; digits only. Empty string when absent. */
  typmod(max: 1 | 2): string | null {
    if (!this.isPunct('(')) return '';
    this.i += 1;
    const values: string[] = [];
    for (;;) {
      const t = this.peek();
      if (t?.kind !== 'number') return null;
      values.push(t.text);
      this.i += 1;
      if (this.isPunct(',') && values.length < max) {
        this.i += 1;
        continue;
      }
      if (!this.isPunct(')')) return null;
      this.i += 1;
      return `(${values.join(',')})`;
    }
  }

  /** `[]`, `[3]`, repeated. */
  arrays(): string | null {
    let out = '';
    while (this.isPunct('[')) {
      this.i += 1;
      const t = this.peek();
      let size = '';
      if (t?.kind === 'number') {
        size = t.text;
        this.i += 1;
      }
      if (!this.isPunct(']')) return null;
      this.i += 1;
      out += `[${size}]`;
    }
    return out;
  }

  /** The base type with its modifiers, before any array suffix. */
  base(): string | null {
    const first = this.peek();
    if (!first) return null;
    if (first.kind === 'word' && !this.isPunct('.', 1)) {
      const word = first.lower;
      if (word === 'double' && this.isWord('precision', 1)) {
        this.i += 2;
        return 'double precision';
      }
      if ((word === 'character' || word === 'char' || word === 'bit') && this.isWord('varying', 1)) {
        this.i += 2;
        const mod = this.typmod(1);
        return mod === null ? null : `${word} varying${mod}`;
      }
      if (word === 'time' || word === 'timestamp') {
        this.i += 1;
        const mod = this.typmod(1);
        if (mod === null) return null;
        let zone = '';
        if ((this.isWord('with') || this.isWord('without')) && this.isWord('time', 1) && this.isWord('zone', 2)) {
          zone = ` ${(this.peek() as { lower: string }).lower} time zone`;
          this.i += 3;
        }
        return `${word}${mod}${zone}`;
      }
      if (word === 'interval') {
        this.i += 1;
        return this.interval();
      }
    }
    return this.qualifiedName();
  }

  /** `interval`, `interval(p)`, `interval day to second(p)`, `interval year`… */
  private interval(): string | null {
    const lead = this.typmod(1);
    if (lead === null) return null;
    if (lead) return `interval${lead}`;
    const from = this.peek();
    if (from?.kind !== 'word' || !intervalFields.includes(from.lower)) return 'interval';
    this.i += 1;
    let fields = from.lower;
    if (this.isWord('to')) {
      const to = this.peek(1);
      if (to?.kind !== 'word' || !intervalRanges.has(`${from.lower} to ${to.lower}`)) return null;
      this.i += 2;
      fields = `${from.lower} to ${to.lower}`;
    }
    // Only a range ending in, or a lone, SECOND takes a precision.
    const mod = fields.endsWith('second') ? this.typmod(1) : '';
    return mod === null ? null : `interval ${fields}${mod}`;
  }

  /** `name`, `schema.name` (each bare or quoted) with an optional `(n)` or `(p, s)`. */
  private qualifiedName(): string | null {
    const parts: string[] = [];
    for (;;) {
      const t = this.peek();
      if (t?.kind !== 'word' && t?.kind !== 'quoted') return null;
      parts.push(t.text);
      this.i += 1;
      if (!this.isPunct('.') || parts.length === 2) break;
      this.i += 1;
    }
    const mod = this.typmod(2);
    return mod === null ? null : `${parts.join('.')}${mod}`;
  }
}

/**
 * Parses a column type as typed. Accepts `name`, `schema.name` (bare or "quoted"), an optional
 * `(n)` or `(p, s)` of digits, the multi-word SQL types (double precision, character varying,
 * bit varying, time/timestamp [(p)] with[out] time zone, interval with its fields) and any
 * number of `[]`. Returns null for anything else, so `int; drop table x` never reaches SQL.
 */
export function parseColumnType(text: string): ParsedType | null {
  const tokens = tokenize(text.trim());
  if (!tokens || tokens.length === 0) return null;
  const only = tokens[0];
  if (tokens.length === 1 && only?.kind === 'word') {
    const serial = serialTypes.find((name) => name === only.lower);
    if (serial) return { kind: 'serial', name: serial };
  }
  const parser = new TypeParser(tokens);
  const base = parser.base();
  if (base === null) return null;
  const arrays = parser.arrays();
  if (arrays === null || !parser.done) return null;
  return { kind: 'type', probe: `${base}${arrays}` };
}

function isIdentChar(ch: string | undefined): boolean {
  return ch !== undefined && /[\w$\u0080-￿]/.test(ch);
}

/** Index just past a quoted run starting at `i`, or -1 when it never closes. */
function skipQuoted(sql: string, i: number, quote: string, backslashEscapes: boolean): number {
  let j = i + 1;
  while (j < sql.length) {
    const ch = sql[j];
    if (backslashEscapes && ch === '\\') j += 2;
    else if (ch === quote) {
      if (sql[j + 1] === quote) j += 2;
      else return j + 1;
    } else j += 1;
  }
  return -1;
}

/** Index just past a (nested) block comment starting at `i`, or -1 when it never closes. */
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
    } else j += 1;
  }
  return -1;
}

const closers: Record<string, string> = { ')': '(', ']': '[' };

/**
 * Why an expression (a DEFAULT or a USING) cannot be written into a statement as is, or null
 * when it can. Quotes, quoted identifiers, dollar quotes and block comments are skipped; at the
 * top level a `;` would start a second statement, a `--` comment would swallow the rest of the
 * generated line and a `,` would end the column definition, and brackets must balance so the
 * expression cannot close the statement's own parentheses.
 */
export function expressionProblem(expr: string): string | null {
  const open: string[] = [];
  let i = 0;
  while (i < expr.length) {
    const ch = expr[i]!;
    const next = expr[i + 1];
    let end = i + 1;
    if (ch === "'") {
      const escapes = (expr[i - 1] === 'E' || expr[i - 1] === 'e') && !isIdentChar(expr[i - 2]);
      end = skipQuoted(expr, i, "'", escapes);
      if (end === -1) return 'an unterminated string';
    } else if (ch === '"') {
      end = skipQuoted(expr, i, '"', false);
      if (end === -1) return 'an unterminated quoted identifier';
    } else if (ch === '$' && !isIdentChar(expr[i - 1])) {
      const tag = /^\$([A-Za-z_\u0080-￿][\w\u0080-￿]*)?\$/.exec(expr.slice(i));
      if (tag) {
        const close = expr.indexOf(tag[0], i + tag[0].length);
        if (close === -1) return 'an unterminated dollar-quoted string';
        end = close + tag[0].length;
      }
    } else if (ch === '/' && next === '*') {
      end = skipBlockComment(expr, i);
      if (end === -1) return 'an unterminated comment';
    } else if (ch === '-' && next === '-') {
      return 'a "--" comment (use /* */ instead)';
    } else if (ch === ';') {
      return 'a ";" (one change is one statement)';
    } else if (ch === ',' && open.length === 0) {
      return 'a "," outside parentheses';
    } else if (ch === '(' || ch === '[') {
      open.push(ch);
    } else if (ch === ')' || ch === ']') {
      if (open.pop() !== closers[ch]) return `an unmatched "${ch}"`;
    }
    i = end;
  }
  const unclosed = open.pop();
  return unclosed ? `an unclosed "${unclosed}"` : null;
}
