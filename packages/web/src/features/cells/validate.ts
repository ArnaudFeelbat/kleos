import { integerRanges, type CellKind } from './classify';
import { boolValue } from './preview';

export type ValidationContext = {
  kind: CellKind;
  typeName: string;
  enumValues?: readonly string[];
};

const integerPattern = /^[+-]?\d+$/;
const numberPattern = /^[+-]?(\d+(\.\d*)?|\.\d+)([eE][+-]?\d+)?$/;
const specialNumber = /^[+-]?(nan|infinity|inf)$/i;
const datePattern = /^(\d{4,})-(\d{2})-(\d{2})( BC)?$/;
const timestamptzPattern =
  /^(\d{4,}-\d{2}-\d{2})[ T]\d{2}:\d{2}(:\d{2}(\.\d+)?)?\s*(Z|[+-]\d{2}(:?\d{2}(:?\d{2})?)?)( BC)?$/i;
const uuidPattern = /^\{?[0-9a-f]{8}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{12}\}?$/i;
const infinity = /^[+-]?infinity$/i;

/** True for a real calendar date, so 2026-02-30 is caught before Postgres sees it. */
function isCalendarDate(text: string): boolean {
  const m = datePattern.exec(text);
  if (!m) return false;
  const [, y, mo, d] = m;
  const month = Number(mo);
  const day = Number(d);
  if (month < 1 || month > 12 || day < 1) return false;
  const year = Number(y);
  const leap = (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month - 1] ?? 0;
  return day <= days;
}

/** Braces balance outside double-quoted elements and the literal is one {...} group. */
function isArrayLiteral(text: string): boolean {
  const body = text.replace(/^(\[\d+:\d+\])+=/, '');
  if (!body.startsWith('{') || !body.endsWith('}')) return false;
  let depth = 0;
  let quoted = false;
  for (let i = 0; i < body.length; i += 1) {
    const ch = body[i];
    if (ch === '\\') {
      i += 1;
    } else if (ch === '"') {
      quoted = !quoted;
    } else if (!quoted && ch === '{') {
      depth += 1;
    } else if (!quoted && ch === '}') {
      depth -= 1;
      if (depth === 0 && i !== body.length - 1) return false;
      if (depth < 0) return false;
    }
  }
  return depth === 0 && !quoted;
}

/**
 * Checks an edited value before it is staged. Returns a message for the user, or null
 * when the value is acceptable. Postgres still parses every value on commit (the value
 * is sent as text with a cast), so these checks only catch obvious mistakes early.
 */
export function validateCellInput(text: string, ctx: ValidationContext): string | null {
  const value = text.trim();
  switch (ctx.kind) {
    case 'integer': {
      if (!integerPattern.test(value)) return 'Enter a whole number, like 42.';
      const range = integerRanges[ctx.typeName];
      if (range) {
        const n = BigInt(value);
        if (n < range[0] || n > range[1]) return `Out of range for ${ctx.typeName} (${range[0]} to ${range[1]}).`;
      }
      return null;
    }
    case 'number':
      return numberPattern.test(value) || specialNumber.test(value) ? null : 'Enter a number, like 1194.00.';
    case 'date':
      if (infinity.test(value)) return null;
      return isCalendarDate(value) ? null : 'Enter a date as YYYY-MM-DD.';
    case 'timestamptz': {
      if (infinity.test(value)) return null;
      const m = timestamptzPattern.exec(value);
      if (!m) {
        return /[+-]\d{2}(:?\d{2})?$|Z$/i.test(value)
          ? 'Enter a timestamp as YYYY-MM-DD HH:MM:SS+04.'
          : 'Include a UTC offset, like 2026-11-17 18:42:13+04.';
      }
      return isCalendarDate(m[1] ?? '') ? null : 'Enter a timestamp as YYYY-MM-DD HH:MM:SS+04.';
    }
    case 'uuid':
      return uuidPattern.test(value) ? null : 'Enter a UUID, like 3f1c2a9e-8b7d-4c11-9e2f-0a6b5d4c3e21.';
    case 'json':
      try {
        JSON.parse(text);
        return null;
      } catch (err) {
        return `Invalid JSON: ${err instanceof Error ? err.message : String(err)}`;
      }
    case 'array':
      return isArrayLiteral(value) ? null : 'Enter a Postgres array literal, like {a,b,c}.';
    case 'enum':
      if (ctx.enumValues && !ctx.enumValues.includes(text)) return `Pick one of: ${ctx.enumValues.join(', ')}.`;
      return null;
    case 'bool':
      return boolValue(value) === null ? 'Pick true, false or NULL.' : null;
    case 'bytea':
      return 'bytea values are read-only in this version.';
    case 'text':
    case 'timestamp':
    case 'other':
      return null;
  }
}

/**
 * The text actually staged: number, date and uuid inputs are trimmed (Postgres would
 * accept the spaces, but the review SQL reads better without); text keeps every character.
 */
export function normalizeInput(text: string, kind: CellKind): string {
  return kind === 'text' || kind === 'json' || kind === 'other' || kind === 'enum' ? text : text.trim();
}
