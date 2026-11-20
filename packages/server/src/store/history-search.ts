/**
 * Turns what the user typed in the history search box into an FTS5 MATCH expression, or null
 * when there is nothing to search for.
 *
 * Raw user text is never FTS syntax: each whitespace-separated word becomes a quoted string
 * (quotes doubled) with a trailing `*`, so AND, NEAR, column filters, parentheses or a stray
 * quote are just text. Inside the quotes the tokenizer splits on punctuation, so `o.stauts`
 * matches those two tokens side by side and `stauts*` as a prefix. Words are joined with
 * spaces, FTS5's implicit AND: every word must match, in the SQL or in the error text.
 * A word with no letter or digit (`;`, `--`, `*`) would be an empty phrase and is dropped.
 */
export function historyMatchExpression(q: string | undefined): string | null {
  if (!q) return null;
  const phrases = q
    .split(/\s+/u)
    .filter((word) => /[\p{L}\p{N}]/u.test(word))
    .map((word) => `"${word.replaceAll('"', '""')}"*`);
  return phrases.length > 0 ? phrases.join(' ') : null;
}
