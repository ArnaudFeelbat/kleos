import { ChevronDown, ChevronRight, Copy, X } from 'lucide-react';
import { useMemo, useState, type ReactNode } from 'react';
import { toast } from 'sonner';
import type { CellValue } from '@kleos/shared';
import { Button } from '@/components/ui/button';
import type { CellKind } from '@/features/cells/classify';
import { BoolMark, NullMark } from '@/features/cells/cell-value';
import { formatJsonExact, parseJsonExact, type JsonNode } from '@/features/cells/json';
import { boolValue, byteaLength, parsePgArray, timestamptzToUtc, type PgArrayItem } from '@/features/cells/preview';
import { formatBytes, formatInt } from '@/lib/format';
import { cn } from '@/lib/utils';
import { copyText } from './copy';

export type ValueInspectorProps = {
  columnName: string;
  /** e.g. "jsonb · row id 100512" */
  subtitle: string;
  kind: CellKind;
  /** undefined: the cell takes its DEFAULT (new row). */
  value: CellValue | undefined;
  /** Editing actions from the caller (Edit, Set null…), shown before Copy. */
  actions?: ReactNode;
  onClose(): void;
};

/**
 * Side panel with the full value of the focused cell: JSON as an indented tree (or raw),
 * arrays as a list, long text with its line breaks, bytea as a hex dump.
 */
export function ValueInspector({ columnName, subtitle, kind, value, actions, onClose }: ValueInspectorProps) {
  const [view, setView] = useState<'tree' | 'raw'>('tree');
  const json = useMemo(() => {
    if (kind !== 'json' || value === null || value === undefined) return undefined;
    const node = parseJsonExact(value);
    return node ? { ok: true as const, value: node } : { ok: false as const };
  }, [kind, value]);

  const copy = async () => {
    if (value === undefined || value === null) return;
    if (await copyText(value)) toast.success(`Copied ${columnName}`);
    else toast.error('The clipboard refused the copy.');
  };

  let body: ReactNode;
  if (value === undefined) {
    body = <NullMark label="DEFAULT" />;
  } else if (value === null) {
    body = <NullMark />;
  } else if (kind === 'json' && json?.ok) {
    body =
      view === 'tree' ? (
        <JsonTree value={json.value} />
      ) : (
        <pre className="font-mono text-xs leading-relaxed whitespace-pre-wrap">{formatJsonExact(json.value)}</pre>
      );
  } else if (kind === 'array') {
    const items = parsePgArray(value);
    body = items ? <ArrayList items={items} /> : <PlainText value={value} />;
  } else if (kind === 'bool') {
    const b = boolValue(value);
    body =
      b === null ? (
        <PlainText value={value} />
      ) : (
        <span className="flex items-center gap-2">
          <BoolMark value={b} /> {String(b)}
        </span>
      );
  } else if (kind === 'bytea') {
    body = <HexDump value={value} />;
  } else if (kind === 'timestamptz') {
    const utc = timestamptzToUtc(value);
    body = (
      <div className="flex flex-col gap-1 font-mono text-xs">
        <span>{value}</span>
        {utc && <span className="text-muted-foreground">UTC {utc}</span>}
      </div>
    );
  } else {
    body = <PlainText value={value} mono={kind !== 'text' && kind !== 'enum'} />;
  }

  return (
    <aside aria-label="Cell value" className="bg-background flex min-h-0 w-[300px] shrink-0 flex-col border-l">
      <div className="flex items-center gap-2 border-b px-3.5 py-3">
        <div className="flex min-w-0 flex-col">
          <b className="truncate font-mono font-semibold">{columnName}</b>
          <span className="text-muted-foreground truncate text-[11px]">{subtitle}</span>
        </div>
        {kind === 'json' && json?.ok && (
          <div role="tablist" aria-label="JSON view" className="bg-muted ml-auto inline-flex gap-0.5 rounded-lg p-0.5">
            {(['tree', 'raw'] as const).map((v) => (
              <button
                key={v}
                type="button"
                role="tab"
                aria-selected={view === v}
                onClick={() => setView(v)}
                className={cn(
                  'text-muted-foreground h-6 rounded-md px-2 text-xs font-medium capitalize',
                  view === v && 'bg-background text-foreground shadow-sm',
                )}
              >
                {v}
              </button>
            ))}
          </div>
        )}
        <Button
          type="button"
          variant="ghost"
          size="icon-xs"
          className={cn(!(kind === 'json' && json?.ok) && 'ml-auto')}
          aria-label="Close value panel"
          onClick={onClose}
        >
          <X />
        </Button>
      </div>
      <div className="selectable min-h-0 flex-1 overflow-auto px-3.5 py-3">{body}</div>
      <div className="flex flex-wrap items-center gap-2 border-t px-3.5 py-3">
        {actions}
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="ml-auto h-7 text-xs"
          disabled={value === null || value === undefined}
          onClick={() => void copy()}
        >
          <Copy className="size-3.5" aria-hidden="true" />
          Copy
        </Button>
      </div>
    </aside>
  );
}

function PlainText({ value, mono = false }: { value: string; mono?: boolean }) {
  if (value === '') return <span className="text-muted-foreground text-xs italic">Empty string</span>;
  return (
    <p className={cn('text-[13px] leading-relaxed break-words whitespace-pre-wrap', mono && 'font-mono text-xs')}>
      {value}
    </p>
  );
}

function ArrayList({ items, depth = 0 }: { items: PgArrayItem[]; depth?: number }) {
  if (items.length === 0) return <span className="text-muted-foreground font-mono text-xs">{'{ }'} empty array</span>;
  return (
    <ol className={cn('flex flex-col gap-0.5 font-mono text-xs', depth > 0 && 'border-l pl-3')}>
      {depth === 0 && (
        <li className="text-muted-foreground mb-1 list-none">
          {formatInt(items.length)} item{items.length === 1 ? '' : 's'}
        </li>
      )}
      {items.map((item, i) => (
        <li key={i} className="flex gap-3">
          <span className="text-muted-foreground w-6 shrink-0 text-right">{i + 1}</span>
          {Array.isArray(item) ? (
            <ArrayList items={item} depth={depth + 1} />
          ) : item === null ? (
            <NullMark />
          ) : (
            <span className="break-all">{item}</span>
          )}
        </li>
      ))}
    </ol>
  );
}

function HexDump({ value }: { value: string }) {
  const size = byteaLength(value);
  const hex = value.startsWith('\\x') ? value.slice(2, 2 + 1024) : '';
  const lines = hex.match(/.{1,32}/g) ?? [];
  return (
    <div className="flex flex-col gap-2 font-mono text-xs">
      <span className="text-muted-foreground">
        {formatBytes(size)} · {formatInt(size)} bytes{size > 512 ? ' · first 512 shown' : ''}
      </span>
      <pre className="leading-relaxed">
        {lines
          .map((l, i) => `${(i * 16).toString(16).padStart(6, '0')}  ${l.match(/../g)?.join(' ') ?? ''}`)
          .join('\n')}
      </pre>
    </div>
  );
}

/** Collapsible JSON tree; objects and arrays deeper than two levels start collapsed. */
export function JsonTree({ value }: { value: JsonNode }) {
  return (
    <div className="font-mono text-xs leading-[1.7]" role="tree" aria-label="JSON value">
      <JsonTreeNode name={null} value={value} depth={0} />
    </div>
  );
}

function JsonTreeNode({ name, value, depth }: { name: string | null; value: JsonNode; depth: number }) {
  const [open, setOpen] = useState(depth < 2);
  const label = name === null ? null : <span>{JSON.stringify(name)}: </span>;
  const indent = { paddingLeft: depth * 18 };
  if (value.t === 'arr' || value.t === 'obj') {
    const isArray = value.t === 'arr';
    const entries: [string | null, JsonNode][] =
      value.t === 'arr' ? value.v.map((v) => [null, v] as [null, JsonNode]) : value.v;
    const summary = isArray
      ? `[ ${entries.length} item${entries.length === 1 ? '' : 's'} ]`
      : `{ ${entries.length} key${entries.length === 1 ? '' : 's'} }`;
    return (
      <div role="treeitem" aria-expanded={open} aria-selected={false}>
        <button
          type="button"
          className="hover:bg-accent flex w-full items-center gap-1 rounded-sm text-left"
          style={{ paddingLeft: Math.max(0, depth * 18 - 14) }}
          onClick={() => setOpen((o) => !o)}
        >
          {open ? (
            <ChevronDown className="text-muted-foreground size-3" aria-hidden="true" />
          ) : (
            <ChevronRight className="text-muted-foreground size-3" aria-hidden="true" />
          )}
          {label}
          <span className="text-muted-foreground">{summary}</span>
        </button>
        {open && (
          <div role="group">
            {entries.map(([k, v], i) => (
              <JsonTreeNode key={k ?? i} name={k} value={v} depth={depth + 1} />
            ))}
          </div>
        )}
      </div>
    );
  }
  return (
    <div role="treeitem" aria-selected={false} style={indent} className="break-all">
      {label}
      <JsonScalar value={value} />
    </div>
  );
}

function JsonScalar({ value }: { value: JsonNode }) {
  if (value.t === 'str') return <span className="text-code-string">{JSON.stringify(value.v)}</span>;
  if (value.t === 'num') return <span className="text-code-number">{value.v}</span>;
  if (value.t === 'bool') return <span className="text-code-keyword">{String(value.v)}</span>;
  return <span className="text-code-keyword">null</span>;
}
