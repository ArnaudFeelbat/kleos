/**
 * Colours of an exported diagram, read from the app's CSS tokens so the file looks like the
 * diagram on screen in the current appearance. Every colour is a solid #rrggbb: translucent
 * tokens are blended onto what they sit on, because design tools handle opacity unevenly.
 */
export type DiagramTheme = {
  dark: boolean;
  /** Canvas behind everything (the diagram's own background). */
  background: string;
  card: string;
  /** The hairline ring around a table. */
  cardBorder: string;
  header: string;
  /** Rule under a table's header. */
  headerRule: string;
  /** Table names. */
  text: string;
  columnText: string;
  /** Types, column counts, edge labels. */
  mutedText: string;
  primaryKey: string;
  foreignKey: string;
  edge: string;
  labelFill: string;
  labelBorder: string;
  externalCard: string;
  /** Dashed outline of an external table. */
  externalBorder: string;
  externalName: string;
};

type Rgba = { r: number; g: number; b: number; a: number };

/** Token values of packages/web/src/styles.css, used when a token can't be read (tests, odd values). */
const fallbackTokens: Record<'light' | 'dark', Record<string, string>> = {
  light: {
    background: '#ffffff',
    foreground: '#0b0b0e',
    card: '#ffffff',
    muted: '#f3f3f5',
    'muted-foreground': '#5f5f67',
    border: '#e7e7eb',
    sidebar: '#f9f9fb',
    'brand-text': '#2370d4',
    edge: 'rgb(15 15 30 / 0.07)',
    'primary-key': '#d97706',
  },
  dark: {
    background: '#0f0f12',
    foreground: '#f4f4f5',
    card: '#151518',
    muted: '#222226',
    'muted-foreground': '#a1a1aa',
    border: '#26262c',
    sidebar: '#131316',
    'brand-text': '#6ea6f7',
    edge: 'rgb(255 255 255 / 0.07)',
    'primary-key': '#f59e0b',
  },
};

const clamp255 = (n: number) => Math.max(0, Math.min(255, Math.round(n)));

function alphaValue(text: string | undefined): number {
  if (text === undefined) return 1;
  const n = parseFloat(text);
  if (Number.isNaN(n)) return 1;
  return Math.max(0, Math.min(1, text.trim().endsWith('%') ? n / 100 : n));
}

/** Parses #rgb(a), #rrggbb(aa), rgb()/rgba() in comma or space syntax; null for anything else. */
export function parseColor(value: string): Rgba | null {
  const text = value.trim().toLowerCase();
  const hex = /^#([0-9a-f]{3,8})$/.exec(text)?.[1];
  if (hex && [3, 4, 6, 8].includes(hex.length)) {
    const full = hex.length <= 4 ? [...hex].map((c) => c + c).join('') : hex;
    const byte = (i: number) => parseInt(full.slice(i * 2, i * 2 + 2), 16);
    return { r: byte(0), g: byte(1), b: byte(2), a: full.length === 8 ? byte(3) / 255 : 1 };
  }
  const fn = /^rgba?\(([^)]*)\)$/.exec(text)?.[1];
  if (fn) {
    const [channels, slashAlpha] = fn.split('/');
    const parts = channels!.split(/[\s,]+/).filter(Boolean);
    if (parts.length < 3 || parts.length > 4) return null;
    const channel = (p: string) => (p.endsWith('%') ? (parseFloat(p) / 100) * 255 : parseFloat(p));
    const [r, g, b] = parts.slice(0, 3).map(channel) as [number, number, number];
    if ([r, g, b].some(Number.isNaN)) return null;
    return { r, g, b, a: alphaValue(slashAlpha ?? parts[3]) };
  }
  return null;
}

/** `top` drawn at `opacity` over the solid `bottom`. */
function blend(top: Rgba, bottom: Rgba, opacity = 1): Rgba {
  const a = top.a * opacity;
  return {
    r: top.r * a + bottom.r * (1 - a),
    g: top.g * a + bottom.g * (1 - a),
    b: top.b * a + bottom.b * (1 - a),
    a: 1,
  };
}

function hex({ r, g, b }: Rgba): string {
  return `#${[r, g, b].map((c) => clamp255(c).toString(16).padStart(2, '0')).join('')}`;
}

/**
 * The browser's own reading of a colour it understands but parseColor doesn't (oklch,
 * color-mix…): painted on a 1×1 canvas and read back as sRGB. Null where there is no canvas.
 */
function canvasColor(value: string): Rgba | null {
  if (typeof document === 'undefined' || /jsdom/i.test(navigator.userAgent)) return null;
  const ctx = document.createElement('canvas').getContext('2d', { willReadFrequently: true });
  if (!ctx) return null;
  ctx.clearRect(0, 0, 1, 1);
  ctx.fillStyle = '#000000';
  ctx.fillStyle = value;
  ctx.fillRect(0, 0, 1, 1);
  const [r, g, b, a] = ctx.getImageData(0, 0, 1, 1).data;
  return { r: r!, g: g!, b: b!, a: a! / 255 };
}

/** The theme for a set of token values (name without `--` -> CSS value). */
export function diagramTheme(dark: boolean, tokens: Record<string, string> = {}): DiagramTheme {
  const fallback = fallbackTokens[dark ? 'dark' : 'light'];
  const color = (name: string): Rgba => {
    const raw = tokens[name]?.trim();
    return (raw && (parseColor(raw) ?? canvasColor(raw))) || parseColor(fallback[name]!)!;
  };
  const white: Rgba = { r: 255, g: 255, b: 255, a: 1 };
  // Light diagrams sit on the sidebar tone, dark ones on the background (er-diagram.css).
  const background = blend(color(dark ? 'background' : 'sidebar'), white);
  const card = blend(color('card'), background);
  const foreground = color('foreground');
  const muted = color('muted-foreground');
  const ring = blend(color('edge'), background);
  const externalCard = blend(card, background, 0.7);
  return {
    dark,
    background: hex(background),
    card: hex(card),
    cardBorder: hex(ring),
    header: hex(dark ? blend(white, card, 0.035) : blend(color('muted'), card, 0.6)),
    headerRule: hex(blend(color('border'), card)),
    text: hex(blend(foreground, card)),
    columnText: hex(blend(foreground, card, 0.9)),
    mutedText: hex(blend(muted, card)),
    primaryKey: hex(blend(color('primary-key'), card)),
    foreignKey: hex(blend(color('brand-text'), card)),
    edge: hex(blend(muted, background, 0.7)),
    labelFill: hex(card),
    labelBorder: hex(ring),
    externalCard: hex(externalCard),
    externalBorder: hex(blend(muted, background, 0.45)),
    externalName: hex(blend(foreground, externalCard, 0.8)),
  };
}

const tokenNames = Object.keys(fallbackTokens.light);

/** The theme of the appearance in force: `.dark` on the root and its current token values. */
export function readDiagramTheme(root: HTMLElement = document.documentElement): DiagramTheme {
  const style = getComputedStyle(root);
  const tokens: Record<string, string> = {};
  for (const name of tokenNames) tokens[name] = style.getPropertyValue(`--${name}`);
  return diagramTheme(root.classList.contains('dark'), tokens);
}
