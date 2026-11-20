import type { ReactNode } from 'react';

export type TextRange = { start: number; end: number };

/** A token character for the server's FTS5 tokenizer: letters and digits ("_" separates). */
const tokenChar = /[\p{L}\p{N}]/u;

/**
 * The words of a history search as the server matches them: lowercased, outer punctuation
 * trimmed ("'paid'" is the word paid), words without a letter or digit dropped.
 */
export function searchWords(query: string): string[] {
  return query
    .toLowerCase()
    .split(/\s+/)
    .map((w) => w.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, ''))
    .filter((w) => w !== '');
}

/**
 * Where the words of a search occur in `text`, sorted and merged. The server's full-text search
 * matches token prefixes, so a word counts where a token of the text starts with it ("stat" in
 * "o.status" or "order_status", not in "estate").
 */
export function matchRanges(text: string, query: string): TextRange[] {
  const lower = text.toLowerCase();
  const found: TextRange[] = [];
  for (const word of searchWords(query)) {
    for (let at = lower.indexOf(word); at !== -1; at = lower.indexOf(word, at + 1)) {
      if (at === 0 || !tokenChar.test(lower[at - 1] ?? '')) found.push({ start: at, end: at + word.length });
    }
  }
  found.sort((a, b) => a.start - b.start || b.end - a.end);
  const merged: TextRange[] = [];
  for (const r of found) {
    const last = merged.at(-1);
    if (last && r.start <= last.end) last.end = Math.max(last.end, r.end);
    else merged.push({ ...r });
  }
  return merged;
}

/**
 * A one-line preview of `sql` (whitespace collapsed) with the matches of `query`. When the first
 * match lies past `lead` characters, the preview starts shortly before it, behind an ellipsis, so
 * the match stays visible in a truncated line.
 */
export function previewWithMatches(sql: string, query: string, lead = 28): { text: string; ranges: TextRange[] } {
  const flat = sql.replace(/\s+/g, ' ').trim();
  const ranges = matchRanges(flat, query);
  const first = ranges[0];
  if (!first || first.start <= lead) return { text: flat, ranges };
  let cut = first.start - 16;
  // Start on a word rather than in the middle of one when a space is close enough.
  const space = flat.indexOf(' ', cut);
  if (space !== -1 && space < first.start) cut = space + 1;
  const shift = 1 - cut;
  return {
    text: `…${flat.slice(cut)}`,
    ranges: ranges.map((r) => ({ start: r.start + shift, end: r.end + shift })),
  };
}

/** `text` with `ranges` wrapped in <mark>. */
export function Highlighted({ text, ranges }: { text: string; ranges: TextRange[] }): ReactNode {
  if (ranges.length === 0) return text;
  const parts: ReactNode[] = [];
  let at = 0;
  for (const r of ranges) {
    if (r.start > at) parts.push(text.slice(at, r.start));
    parts.push(
      <mark key={r.start} className="bg-brand-soft text-brand-text rounded-[3px] font-semibold">
        {text.slice(r.start, r.end)}
      </mark>,
    );
    at = r.end;
  }
  if (at < text.length) parts.push(text.slice(at));
  return parts;
}
