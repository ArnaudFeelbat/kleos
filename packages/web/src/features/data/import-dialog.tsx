import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { ArrowRight, LoaderCircle } from 'lucide-react';
import { useId, useState, type FormEvent } from 'react';
import type { Column, ImportPreview, TableRef } from '@kleos/shared';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Switch } from '@/components/ui/switch';
import { NullMark } from '@/features/cells/cell-value';
import { Callout } from '@/features/common/callout';
import { fileName } from '@/features/jobs/job-runner';
import { api, errorText } from '@/lib/api';
import { formatBytes, formatInt } from '@/lib/format';
import {
  autoMap,
  importTargets,
  landedRows,
  parseNullValues,
  requestMapping,
  setMapping,
  unmappedColumns,
  type ColumnMapping,
} from './import-mapping';

type Delimiter = ImportPreview['delimiter'];
const delimiterLabels: Record<Delimiter, string> = { ',': 'Comma', ';': 'Semicolon', '\t': 'Tab' };
/** Radix Select can't hold an empty value; this one stands for "skip this file column". */
const SKIP = '__skip__';
const PREVIEW_ROWS = 5;

export type ImportSettings = {
  path: string;
  delimiter: Delimiter;
  hasHeader: boolean;
  mapping: { fileColumn: number; column: string }[];
  nullValues: string[];
  totalRows: number;
};

type ImportDialogProps = {
  table: TableRef;
  /** The table's introspected columns. */
  columns: readonly Column[];
  /** CSV file picked in the open dialog; the dialog is open while it is set. */
  path: string | null;
  onClose(): void;
  onImport(settings: ImportSettings): void;
};

/**
 * Import CSV: reads a preview of the file (server-side, the file never enters the page),
 * lets the user pick the delimiter, the header row, NULL markers and where each file column
 * goes, and shows the first rows as they will land.
 */
export function ImportDialog({ table, columns, path, onClose, onImport }: ImportDialogProps) {
  return (
    <Dialog open={path !== null} onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="flex max-h-[min(720px,90vh)] flex-col gap-4 sm:max-w-3xl">
        {path !== null && (
          <ImportForm key={path} table={table} columns={columns} path={path} onClose={onClose} onImport={onImport} />
        )}
      </DialogContent>
    </Dialog>
  );
}

function ImportForm({ table, columns, path, onClose, onImport }: Omit<ImportDialogProps, 'path'> & { path: string }) {
  const ids = useId();
  // Undefined until the user picks one: the server detects it from the first lines.
  const [delimiter, setDelimiter] = useState<Delimiter | undefined>(undefined);
  const [hasHeader, setHasHeader] = useState(true);
  const [nullText, setNullText] = useState('');
  const preview = useQuery({
    queryKey: ['import-preview', path, delimiter ?? 'detect', hasHeader],
    queryFn: () => api.importPreview({ path, delimiter, hasHeader }),
    placeholderData: keepPreviousData,
    staleTime: Infinity,
    gcTime: 0,
  });
  const data = preview.data;
  const targets = importTargets(columns);

  // The mapping resets to the automatic guess whenever the file's columns change
  // (another delimiter, header on or off); the user's picks hold until then.
  const signature = data ? JSON.stringify([data.columns, hasHeader]) : '';
  const [picked, setPicked] = useState<{ signature: string; mapping: ColumnMapping } | null>(null);
  const mapping: ColumnMapping =
    picked?.signature === signature ? picked.mapping : data ? autoMap(data.columns, targets, hasHeader) : [];
  const changeMapping = (index: number, column: string | null) =>
    setPicked({ signature, mapping: setMapping(mapping, index, column) });

  const nullValues = parseNullValues(nullText);
  const unmapped = unmappedColumns(mapping, targets);
  const required = unmapped.filter((u) => u.required);
  const optional = unmapped.filter((u) => !u.required);
  const landed = data ? landedRows(data.rows.slice(0, PREVIEW_ROWS), mapping, nullValues) : null;
  const mappedCount = requestMapping(mapping).length;
  const canImport = Boolean(data) && !preview.isPlaceholderData && mappedCount > 0;

  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (!data || !canImport) return;
    onImport({
      path,
      delimiter: data.delimiter,
      hasHeader,
      mapping: requestMapping(mapping),
      nullValues,
      totalRows: data.totalRows,
    });
  };

  return (
    <form onSubmit={submit} className="flex min-h-0 flex-col gap-4">
      <DialogHeader>
        <DialogTitle>Import CSV into {table.name}</DialogTitle>
        <DialogDescription className="text-xs">
          <span className="text-foreground font-mono">{fileName(path)}</span>
          {data && (
            <>
              {' '}
              · {formatBytes(data.bytes)} · {formatInt(data.totalRows)} {data.totalRows === 1 ? 'row' : 'rows'}
            </>
          )}
          . The import runs as one transaction: if a row fails, nothing is imported.
        </DialogDescription>
      </DialogHeader>

      <div className="grid grid-cols-[minmax(0,1fr)_minmax(0,1fr)_auto] items-end gap-3">
        <div className="flex flex-col gap-1.5">
          <Label htmlFor={`${ids}-delimiter`} className="text-xs">
            Delimiter
          </Label>
          <Select value={delimiter ?? data?.delimiter ?? ''} onValueChange={(v) => setDelimiter(v as Delimiter)}>
            <SelectTrigger id={`${ids}-delimiter`} size="sm" className="w-full text-xs">
              <SelectValue placeholder="Detecting…" />
            </SelectTrigger>
            <SelectContent position="popper">
              {(Object.keys(delimiterLabels) as Delimiter[]).map((d) => (
                <SelectItem key={d} value={d} className="text-xs">
                  {delimiterLabels[d]}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor={`${ids}-null`} className="text-xs">
            Treat as NULL
          </Label>
          <Input
            id={`${ids}-null`}
            value={nullText}
            placeholder="Empty cells"
            aria-describedby={`${ids}-null-hint`}
            className="h-7 font-mono text-xs"
            onChange={(e) => setNullText(e.target.value)}
          />
          <span id={`${ids}-null-hint`} className="sr-only">
            Empty cells are always NULL; add markers separated by commas, like NULL, \N.
          </span>
        </div>
        <div className="flex h-7 items-center gap-2">
          <Switch id={`${ids}-header`} checked={hasHeader} onCheckedChange={setHasHeader} />
          <Label htmlFor={`${ids}-header`} className="text-xs font-normal">
            First row is a header
          </Label>
        </div>
      </div>

      {preview.isError ? (
        <Callout role="alert" tone="error" title="Couldn’t read the file">
          <span className="font-mono text-xs break-words">{errorText(preview.error)}</span>
        </Callout>
      ) : !data ? (
        <p className="text-muted-foreground flex items-center gap-2 py-6 text-xs" role="status">
          <LoaderCircle className="size-3.5 animate-spin" aria-hidden="true" />
          Reading the file…
        </p>
      ) : (
        <div className="-mx-1 flex min-h-0 flex-col gap-4 overflow-auto px-1">
          <section aria-labelledby={`${ids}-map`} className="flex flex-col gap-2">
            <h3 id={`${ids}-map`} className="text-xs font-semibold">
              Columns
            </h3>
            <div className="rounded-lg shadow-[inset_0_0_0_1px_var(--edge)]">
              <table className="w-full text-xs">
                <thead className="text-muted-foreground text-left">
                  <tr className="border-b">
                    <th className="px-3 py-1.5 font-medium">File column</th>
                    <th className="px-3 py-1.5 font-medium">First value</th>
                    <th className="w-6" aria-hidden="true" />
                    <th className="px-3 py-1.5 font-medium">Table column</th>
                  </tr>
                </thead>
                <tbody>
                  {data.columns.map((name, i) => {
                    const first = data.rows[0]?.[i];
                    return (
                      <tr key={i} className="border-b last:border-b-0">
                        <td className="max-w-48 truncate px-3 py-1 font-mono">{name}</td>
                        <td className="text-muted-foreground max-w-48 truncate px-3 py-1 font-mono">
                          {first === undefined ? '' : nullValues.includes(first) ? <NullMark /> : first}
                        </td>
                        <td aria-hidden="true">
                          <ArrowRight className="text-muted-foreground/70 size-3" />
                        </td>
                        <td className="px-3 py-1">
                          <Select
                            value={mapping[i] ?? SKIP}
                            onValueChange={(v) => changeMapping(i, v === SKIP ? null : v)}
                          >
                            <SelectTrigger
                              size="sm"
                              aria-label={`Table column for ${name}`}
                              className="h-7 w-full font-mono text-xs"
                            >
                              <SelectValue />
                            </SelectTrigger>
                            <SelectContent position="popper">
                              <SelectItem value={SKIP} className="text-xs">
                                Skip
                              </SelectItem>
                              {targets.map((t) => (
                                <SelectItem key={t.name} value={t.name} className="font-mono text-xs">
                                  {t.name}
                                  <span className="text-muted-foreground ml-1">{t.typeName}</span>
                                </SelectItem>
                              ))}
                            </SelectContent>
                          </Select>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
            {optional.length > 0 && (
              <p className="text-muted-foreground text-xs">
                Not in the file, so they take their default:{' '}
                <span className="text-foreground font-mono">{optional.map((u) => u.name).join(', ')}</span>.
              </p>
            )}
            {required.length > 0 && (
              <Callout
                tone="warning"
                role="note"
                title={`${required.map((u) => u.name).join(', ')}: NOT NULL without a default`}
              >
                <span className="text-xs">
                  {required.length === 1 ? 'This column gets' : 'These columns get'} no value from the file, so every
                  row would fail unless a trigger fills {required.length === 1 ? 'it' : 'them'}. Map a file column to{' '}
                  {required.length === 1 ? 'it' : 'them'}.
                </span>
              </Callout>
            )}
            {mappedCount === 0 && (
              <p className="text-destructive text-xs" role="alert">
                Map at least one file column to a table column.
              </p>
            )}
          </section>

          {landed && landed.columns.length > 0 && (
            <section aria-labelledby={`${ids}-preview`} className="flex flex-col gap-2">
              <h3 id={`${ids}-preview`} className="text-xs font-semibold">
                Preview{' '}
                <span className="text-muted-foreground font-normal">
                  first {Math.min(PREVIEW_ROWS, landed.rows.length)} rows as they will land
                </span>
              </h3>
              <div className="overflow-x-auto rounded-lg shadow-[inset_0_0_0_1px_var(--edge)]">
                <table className="w-full font-mono text-xs" aria-label="Rows as they will land">
                  <thead className="text-left">
                    <tr className="bg-sidebar border-b">
                      {landed.columns.map((c) => (
                        <th key={c} className="px-3 py-1.5 font-semibold whitespace-nowrap">
                          {c}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {landed.rows.map((row, r) => (
                      <tr key={r} className="border-b last:border-b-0">
                        {row.map((v, c) => (
                          <td key={c} className="max-w-56 truncate px-3 py-1 whitespace-nowrap">
                            {v === null ? <NullMark /> : v}
                          </td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </section>
          )}
        </div>
      )}

      <DialogFooter>
        <Button type="button" variant="outline" size="sm" onClick={onClose}>
          Cancel
        </Button>
        <Button type="submit" size="sm" disabled={!canImport}>
          {preview.isFetching && <LoaderCircle className="animate-spin" aria-hidden="true" />}
          {data ? `Import ${formatInt(data.totalRows)} ${data.totalRows === 1 ? 'row' : 'rows'}` : 'Import'}
        </Button>
      </DialogFooter>
    </form>
  );
}
