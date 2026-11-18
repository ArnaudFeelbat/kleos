import type { CellValue } from '@kleos/shared';
import { formatBytes } from '@/lib/format';
import type { CellKind } from './classify';

/** Characters kept in a one-line preview; the side panel shows the whole value. */
export const PREVIEW_CHARS = 300;

/** First line of a text value, and whether anything was cut. */
export function firstLine(text: string): { text: string; truncated: boolean } {
  const eol = text.search(/\r?\n/);
  const line = eol === -1 ? text : text.slice(0, eol);
  if (line.length > PREVIEW_CHARS) return { text: `${line.slice(0, PREVIEW_CHARS)}…`, truncated: true };
  return { text: eol === -1 ? line : `${line}…`, truncated: eol !== -1 };
}

/** Collapses line breaks and their indentation so formatted JSON reads on one line. */
export function oneLine(text: string): string {
  const flat = text.replace(/\s*\r?\n\s*/g, ' ');
  return flat.length > PREVIEW_CHARS ? `${flat.slice(0, PREVIEW_CHARS)}…` : flat;
}

/** Byte length of a bytea value in Postgres hex output ("\x89504e47…"). */
export function byteaLength(value: string): number {
  return value.startsWith('\\x') ? Math.floor((value.length - 2) / 2) : value.length;
}

/** "2.4 kB · 89 50 4e 47 0d 0a…": size and the first bytes in hex. */
export function byteaPreview(value: string, firstBytes = 6): string {
  const size = formatBytes(byteaLength(value));
  if (!value.startsWith('\\x')) return size;
  const hex = value.slice(2);
  const bytes = hex.slice(0, firstBytes * 2).match(/../g) ?? [];
  if (bytes.length === 0) return size;
  const more = hex.length > firstBytes * 2 ? '…' : '';
  return `${size} · ${bytes.join(' ')}${more}`;
}

/** Postgres prints bool as t / f. */
export function boolValue(value: string): boolean | null {
  const v = value.toLowerCase();
  if (v === 't' || v === 'true') return true;
  if (v === 'f' || v === 'false') return false;
  return null;
}

const timestamptzPattern =
  /^(\d{4,})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})(\.\d+)?\s*([+-])(\d{2})(?::?(\d{2}))?(?::?(\d{2}))?$/;

/**
 * UTC wall time of a timestamptz in Postgres output form ("2026-11-17 18:42:13+04"
 * -> "2026-11-17 14:42:13"). Fractional seconds are carried over as text, never rounded.
 * Returns null for infinity, BC dates or anything it cannot read.
 */
export function timestamptzToUtc(value: string): string | null {
  const m = timestamptzPattern.exec(value.trim());
  if (!m) return null;
  const [, y, mo, d, h, mi, s, frac = '', sign, oh, om = '0', os = '0'] = m;
  const offsetSeconds = (Number(oh) * 3600 + Number(om) * 60 + Number(os)) * (sign === '-' ? -1 : 1);
  const date = new Date(0);
  date.setUTCFullYear(Number(y), Number(mo) - 1, Number(d));
  date.setUTCHours(Number(h), Number(mi), Number(s) - offsetSeconds, 0);
  if (Number.isNaN(date.getTime())) return null;
  const pad = (n: number, w = 2) => String(n).padStart(w, '0');
  return (
    `${pad(date.getUTCFullYear(), 4)}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())} ` +
    `${pad(date.getUTCHours())}:${pad(date.getUTCMinutes())}:${pad(date.getUTCSeconds())}${frac}`
  );
}

/**
 * The text a grid cell shows for a value: exact digits for numbers, the first line for
 * text, a one-line preview for JSON and arrays, size and hex for bytea. Null and booleans
 * are drawn by the cell component, so they return null here.
 */
export function previewText(kind: CellKind, value: CellValue): string | null {
  if (value === null) return null;
  switch (kind) {
    case 'bool':
      return null;
    case 'text':
    case 'enum':
    case 'other':
      return firstLine(value).text;
    case 'json':
    case 'array':
      return oneLine(value);
    case 'bytea':
      return byteaPreview(value);
    default:
      return value;
  }
}

/**
 * Parses a Postgres array literal ("{a,\"b c\",NULL,{1,2}}") into nested lists of text,
 * with NULL as null. Returns null when the literal is malformed.
 */
export type PgArrayItem = string | null | PgArrayItem[];

export function parsePgArray(literal: string): PgArrayItem[] | null {
  let text = literal.trim();
  // Arrays with non-default bounds are printed as "[0:2]={...}".
  const bounds = /^(\[\d+:\d+\])+=/.exec(text);
  if (bounds) text = text.slice(bounds[0].length);
  let i = 0;

  const parseArray = (): PgArrayItem[] | null => {
    if (text[i] !== '{') return null;
    i += 1;
    const items: PgArrayItem[] = [];
    if (text[i] === '}') {
      i += 1;
      return items;
    }
    for (;;) {
      while (text[i] === ' ') i += 1;
      const ch = text[i];
      if (ch === undefined) return null;
      if (ch === '{') {
        const nested = parseArray();
        if (!nested) return null;
        items.push(nested);
      } else if (ch === '"') {
        i += 1;
        let out = '';
        while (i < text.length && text[i] !== '"') {
          if (text[i] === '\\') i += 1;
          out += text[i] ?? '';
          i += 1;
        }
        if (text[i] !== '"') return null;
        i += 1;
        items.push(out);
      } else {
        let out = '';
        while (i < text.length && text[i] !== ',' && text[i] !== '}') {
          if (text[i] === '\\') i += 1;
          out += text[i] ?? '';
          i += 1;
        }
        const raw = out.trim();
        items.push(raw.toUpperCase() === 'NULL' ? null : raw);
      }
      while (text[i] === ' ') i += 1;
      if (text[i] === ',') {
        i += 1;
        continue;
      }
      if (text[i] === '}') {
        i += 1;
        return items;
      }
      return null;
    }
  };

  const result = parseArray();
  return result && i === text.length ? result : null;
}
