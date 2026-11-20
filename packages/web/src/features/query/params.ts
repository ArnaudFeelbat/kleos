import { isIdentChar, sqlRegions } from './sql-script';

/** Values typed in the parameter prompt, by placeholder ("$1", ":customer"); null is NULL. */
export type ParamValues = Record<string, string | null>;

/** One occurrence of a placeholder in a statement. */
export type Placeholder = { key: string; from: number; to: number };

/** What a statement with placeholders becomes: `:name` rewritten to `$n` and the values in order. */
export type BoundSql = {
  sql: string;
  params: (string | null)[];
  /** The placeholders this statement used, in `$n` order. */
  keys: string[];
  /**
   * Maps a Postgres error position (1-based, in characters) in the rewritten SQL back to the
   * statement as written, so the editor underlines the right token.
   */
  sourcePosition(position: number): number;
};

/**
 * Finds `$1…$n` and `:name` placeholders in code — not in strings, comments, quoted identifiers
 * or dollar-quoted bodies. `::type` casts and `:=` are not placeholders, nor is `a[lo:hi]` (a
 * colon right after an identifier or a number is an array slice).
 */
export function findPlaceholders(sql: string): Placeholder[] {
  const out: Placeholder[] = [];
  for (const r of sqlRegions(sql)) {
    if (r.kind !== 'code') continue;
    for (let i = r.from; i < r.to; i += 1) {
      const ch = sql[i];
      if (ch === '$' && !isIdentChar(sql[i - 1])) {
        const m = /^\$([1-9]\d*)/.exec(sql.slice(i, Math.min(r.to, i + 8)));
        if (m) {
          out.push({ key: m[0], from: i, to: i + m[0].length });
          i += m[0].length - 1;
        }
      } else if (ch === ':' && sql[i + 1] !== ':' && sql[i - 1] !== ':' && !isIdentChar(sql[i - 1])) {
        const m = /^:([A-Za-z_][A-Za-z0-9_]*)/.exec(sql.slice(i, r.to));
        if (m) {
          out.push({ key: m[0], from: i, to: i + m[0].length });
          i += m[0].length - 1;
        }
      }
    }
  }
  return out;
}

/** Each placeholder once: `$n` in number order, then `:name` in order of first appearance. */
export function placeholderKeys(sql: string | string[]): string[] {
  const found = (Array.isArray(sql) ? sql : [sql]).flatMap((s) => findPlaceholders(s).map((p) => p.key));
  const unique = [...new Set(found)];
  const positional = unique.filter((k) => k.startsWith('$')).sort((a, b) => Number(a.slice(1)) - Number(b.slice(1)));
  return [...positional, ...unique.filter((k) => k.startsWith(':'))];
}

/**
 * Rewrites a statement's placeholders to `$1…$n` (its own, renumbered: a statement that only
 * uses `$2` and `:day` sends `$1` and `$2`) and lists their values in that order. Values are
 * bound by Postgres, never pasted into the SQL.
 */
export function bindPlaceholders(sql: string, values: ParamValues): BoundSql {
  const found = findPlaceholders(sql);
  const keys = placeholderKeys(sql);
  if (found.length === 0) return { sql, params: [], keys: [], sourcePosition: (p) => p };
  const number = new Map(keys.map((k, i) => [k, `$${i + 1}`]));
  let out = '';
  let last = 0;
  /** Replacements in code points (Postgres positions count characters, not UTF-16 units). */
  const replaced: { at: number; oldLen: number; newLen: number }[] = [];
  let points = 0;
  for (const p of found) {
    const before = sql.slice(last, p.from);
    points += [...before].length;
    const next = number.get(p.key)!;
    out += before + next;
    replaced.push({ at: points, oldLen: p.to - p.from, newLen: next.length });
    points += p.to - p.from;
    last = p.to;
  }
  out += sql.slice(last);
  return {
    sql: out,
    params: keys.map((k) => values[k] ?? null),
    keys,
    sourcePosition(position) {
      const c = position - 1;
      let shift = 0;
      for (const r of replaced) {
        const start = r.at - shift;
        if (c < start) break;
        if (c < start + r.newLen) return r.at + 1;
        shift += r.oldLen - r.newLen;
      }
      return c + shift + 1;
    },
  };
}
