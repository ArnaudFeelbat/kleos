/**
 * Maps a Postgres error position to editor offsets. Postgres reports a 1-based position
 * in characters (code points) of the statement it received; the editor works in UTF-16
 * offsets of the whole document, and the statement starts at `statementFrom`.
 */
export function errorRange(
  doc: string,
  statementFrom: number,
  statement: string,
  position: number,
): { from: number; to: number } {
  // Walk code points so emoji and other astral characters before the error count once.
  let offset = 0;
  let chars = 0;
  for (const ch of statement) {
    if (chars >= position - 1) break;
    offset += ch.length;
    chars += 1;
  }
  const docLength = doc.length;
  let from = Math.min(statementFrom + offset, docLength);
  // "syntax error at end of input" points just past the statement: mark its last character.
  if (from >= statementFrom + statement.length && statement.length > 0) {
    from = Math.min(statementFrom + statement.length - 1, docLength);
  }
  let to = from;
  // Underline the whole token Postgres pointed at, e.g. "o.stauts".
  while (to < docLength && /[\p{L}\p{N}_$."]/u.test(doc[to]!)) to += 1;
  if (to === from) to = Math.min(from + 1, docLength);
  if (to === from && from > 0) from -= 1;
  return { from, to };
}

/** 1-based line and column of an offset, for "Line 1, column 8". */
export function lineColumn(doc: string, offset: number): { line: number; column: number } {
  const before = doc.slice(0, offset);
  const line = before.split('\n').length;
  const lastBreak = before.lastIndexOf('\n');
  return { line, column: [...before.slice(lastBreak + 1)].length + 1 };
}
