/**
 * JSON read without JavaScript numbers, so 9007199254740993 or 0.1000000000000000055 in a
 * jsonb value keep every digit in the tree and when re-formatted.
 */
export type JsonNode =
  | { t: 'null' }
  | { t: 'bool'; v: boolean }
  | { t: 'num'; v: string }
  | { t: 'str'; v: string }
  | { t: 'arr'; v: JsonNode[] }
  | { t: 'obj'; v: [string, JsonNode][] };

const numberRe = /-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/y;

/** Parses JSON text; returns null when it is not valid JSON. */
export function parseJsonExact(text: string): JsonNode | null {
  let i = 0;
  const ws = () => {
    while (i < text.length && /[ \t\n\r]/.test(text[i]!)) i += 1;
  };
  const fail = (): never => {
    throw new SyntaxError(`Unexpected input at ${i}`);
  };
  const str = (): string => {
    const start = i;
    i += 1;
    while (i < text.length && text[i] !== '"') {
      if (text[i] === '\\') i += 1;
      i += 1;
    }
    if (text[i] !== '"') fail();
    i += 1;
    return JSON.parse(text.slice(start, i)) as string;
  };
  const value = (): JsonNode => {
    ws();
    const ch = text[i];
    if (ch === '{') {
      i += 1;
      const entries: [string, JsonNode][] = [];
      ws();
      if (text[i] === '}') {
        i += 1;
        return { t: 'obj', v: entries };
      }
      for (;;) {
        ws();
        if (text[i] !== '"') fail();
        const key = str();
        ws();
        if (text[i] !== ':') fail();
        i += 1;
        entries.push([key, value()]);
        ws();
        if (text[i] === ',') {
          i += 1;
          continue;
        }
        if (text[i] === '}') {
          i += 1;
          return { t: 'obj', v: entries };
        }
        fail();
      }
    }
    if (ch === '[') {
      i += 1;
      const items: JsonNode[] = [];
      ws();
      if (text[i] === ']') {
        i += 1;
        return { t: 'arr', v: items };
      }
      for (;;) {
        items.push(value());
        ws();
        if (text[i] === ',') {
          i += 1;
          continue;
        }
        if (text[i] === ']') {
          i += 1;
          return { t: 'arr', v: items };
        }
        fail();
      }
    }
    if (ch === '"') return { t: 'str', v: str() };
    if (text.startsWith('true', i)) {
      i += 4;
      return { t: 'bool', v: true };
    }
    if (text.startsWith('false', i)) {
      i += 5;
      return { t: 'bool', v: false };
    }
    if (text.startsWith('null', i)) {
      i += 4;
      return { t: 'null' };
    }
    numberRe.lastIndex = i;
    const m = numberRe.exec(text);
    if (!m) return fail();
    i += m[0].length;
    return { t: 'num', v: m[0] };
  };
  try {
    const root = value();
    ws();
    return i === text.length ? root : null;
  } catch {
    return null;
  }
}

/** Indented JSON text of a parsed node, digits untouched. */
export function formatJsonExact(node: JsonNode, indent = 2, depth = 0): string {
  const pad = ' '.repeat(indent * (depth + 1));
  const end = ' '.repeat(indent * depth);
  switch (node.t) {
    case 'null':
      return 'null';
    case 'bool':
      return String(node.v);
    case 'num':
      return node.v;
    case 'str':
      return JSON.stringify(node.v);
    case 'arr':
      if (node.v.length === 0) return '[]';
      return `[\n${node.v.map((n) => pad + formatJsonExact(n, indent, depth + 1)).join(',\n')}\n${end}]`;
    case 'obj':
      if (node.v.length === 0) return '{}';
      return `{\n${node.v
        .map(([k, n]) => `${pad}${JSON.stringify(k)}: ${formatJsonExact(n, indent, depth + 1)}`)
        .join(',\n')}\n${end}}`;
  }
}
