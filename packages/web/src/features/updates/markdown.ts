/**
 * A deliberately small Markdown reader for release notes (GitHub release bodies): headings,
 * bullet and numbered lists, paragraphs, fenced code, and inline bold, italics, code and links.
 * It produces plain data that React renders as text — never HTML — so whatever a release body
 * holds (tags, scripts, entities) is shown literally and nothing in it can run. Links keep only
 * their text: the notes never open anything by themselves.
 */

export type Inline =
  | { kind: 'text'; text: string }
  | { kind: 'code'; text: string }
  | { kind: 'strong'; children: Inline[] }
  | { kind: 'em'; children: Inline[] };

export type Block =
  | { kind: 'heading'; level: 1 | 2 | 3 | 4 | 5 | 6; children: Inline[] }
  | { kind: 'paragraph'; children: Inline[] }
  | { kind: 'list'; ordered: boolean; items: Inline[][] }
  | { kind: 'code'; text: string };

const HEADING = /^ {0,3}(#{1,6})\s+(.*?)\s*#*\s*$/;
const BULLET = /^\s*[-*+]\s+(.*)$/;
const NUMBERED = /^\s*\d{1,9}[.)]\s+(.*)$/;
const FENCE = /^\s*(```|~~~)/;
const RULE = /^ {0,3}([-*_])(\s*\1){2,}\s*$/;

type OpenList = { ordered: boolean; items: string[] };

export function parseMarkdown(source: string): Block[] {
  const lines = source.replace(/\r\n?/g, '\n').split('\n');
  const blocks: Block[] = [];
  // Held in an object so the flush helpers can reset them (TypeScript tracks that, not closures).
  const open: { paragraph: string[]; list: OpenList | null } = { paragraph: [], list: null };

  const flushParagraph = () => {
    if (open.paragraph.length) blocks.push({ kind: 'paragraph', children: parseInline(open.paragraph.join(' ')) });
    open.paragraph = [];
  };
  const flushList = () => {
    if (open.list) blocks.push({ kind: 'list', ordered: open.list.ordered, items: open.list.items.map(parseInline) });
    open.list = null;
  };

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i]!;
    const fence = FENCE.exec(line);
    if (fence) {
      flushParagraph();
      flushList();
      const body: string[] = [];
      for (i += 1; i < lines.length && !lines[i]!.trim().startsWith(fence[1]!); i += 1) body.push(lines[i]!);
      blocks.push({ kind: 'code', text: body.join('\n') });
      continue;
    }
    if (!line.trim()) {
      // A blank line ends a paragraph; a list goes on if the next line is another item.
      flushParagraph();
      continue;
    }
    if (RULE.test(line)) {
      flushParagraph();
      flushList();
      continue;
    }
    const heading = HEADING.exec(line);
    if (heading) {
      flushParagraph();
      flushList();
      const level = heading[1]!.length as 1 | 2 | 3 | 4 | 5 | 6;
      blocks.push({ kind: 'heading', level, children: parseInline(heading[2]!) });
      continue;
    }
    const bullet = BULLET.exec(line);
    const numbered = bullet ? null : NUMBERED.exec(line);
    const item = bullet ?? numbered;
    if (item) {
      flushParagraph();
      const ordered = !!numbered;
      const nested = /^\s/.test(line);
      // Nested items (indented) join the same list: release notes rarely need more depth.
      if (open.list && open.list.ordered !== ordered && !nested) flushList();
      open.list ??= { ordered, items: [] };
      open.list.items.push(item[1]!);
      continue;
    }
    if (open.list && /^\s/.test(line) && open.paragraph.length === 0) {
      // An indented line continues the last item.
      open.list.items[open.list.items.length - 1] += ` ${line.trim()}`;
      continue;
    }
    flushList();
    // Blockquote markers are dropped; the quoted text reads as a paragraph.
    open.paragraph.push(line.trim().replace(/^>\s?/, ''));
  }
  flushParagraph();
  flushList();
  return blocks;
}

/**
 * Inline spans, left to right: `code` first (nothing inside it is Markdown), then links (text
 * only; the target may hold one level of parentheses), autolinks, **bold** / __bold__,
 * *italics* / _italics_ (not inside a word, so snake_case stays). Unmatched markers stay as text.
 */
const INLINE =
  /(`+)([^`]|[^`][\s\S]*?[^`])\1(?!`)|!?\[([^\]]*)\]\((?:[^()]|\([^()]*\))*\)|<((?:https?|mailto):[^>\s]+)>|\*\*(?=\S)([\s\S]*?\S)\*\*|__(?=\S)([\s\S]*?\S)__|\*(?=[^\s*])([\s\S]*?[^\s*])\*|(?<![\p{L}\p{N}])_(?=[^\s_])([\s\S]*?[^\s_])_(?![\p{L}\p{N}])/gu;

export function parseInline(text: string): Inline[] {
  const out: Inline[] = [];
  const pushText = (t: string) => {
    if (!t) return;
    const last = out[out.length - 1];
    if (last?.kind === 'text') last.text += t;
    else out.push({ kind: 'text', text: t });
  };
  let at = 0;
  for (const m of text.matchAll(INLINE)) {
    pushText(text.slice(at, m.index));
    at = m.index + m[0].length;
    if (m[1] !== undefined) out.push({ kind: 'code', text: m[2]!.trim() || m[2]! });
    else if (m[3] !== undefined) pushText(m[3]);
    else if (m[4] !== undefined) pushText(m[4]);
    else if (m[5] !== undefined || m[6] !== undefined)
      out.push({ kind: 'strong', children: parseInline(m[5] ?? m[6]!) });
    else out.push({ kind: 'em', children: parseInline(m[7] ?? m[8]!) });
  }
  pushText(text.slice(at));
  return out;
}
