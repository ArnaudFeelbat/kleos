import { ChevronDown, Download, LoaderCircle } from 'lucide-react';
import { useState } from 'react';
import type { ExportFormat, ExportSource } from '@kleos/shared';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuShortcut,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { api } from '@/lib/api';
import { getBridge } from '@/lib/bridge';
import { runJob, useJobRunning } from './job-runner';

export type CsvDelimiter = ',' | ';' | '\t';
export type CsvOptions = { delimiter: CsvDelimiter; header: boolean };

const delimiters: { value: CsvDelimiter; label: string }[] = [
  { value: ',', label: 'Comma' },
  { value: ';', label: 'Semicolon' },
  { value: '\t', label: 'Tab' },
];

// Remembered for the window's lifetime: the next export offers the last choice.
let lastCsvOptions: CsvOptions = { delimiter: ',', header: true };

export type ExportMenuProps = {
  sid: string;
  source: ExportSource;
  /** File name offered by the save dialog, without its extension. */
  defaultName: string;
  /** What the toasts name, e.g. "customers" or "query results". */
  subject: string;
  /** Exports on the same key can't overlap; the menu is off while one runs. */
  sourceKey: string;
  /** First line of the menu, saying what is exported. */
  scopeNote: string;
  disabled?: boolean;
  className?: string;
};

/**
 * "Export…" menu: CSV (with its delimiter and header options), JSON or an Excel workbook.
 * The server writes the file to the path picked in the native save dialog.
 */
export function ExportMenu({
  sid,
  source,
  defaultName,
  subject,
  sourceKey,
  scopeNote,
  disabled,
  className,
}: ExportMenuProps) {
  const running = useJobRunning(sourceKey);
  const [csv, setCsv] = useState<CsvOptions>(lastCsvOptions);
  const setCsvOptions = (next: CsvOptions) => {
    lastCsvOptions = next;
    setCsv(next);
  };

  const exportAs = async (format: ExportFormat) => {
    const path = await getBridge().saveFileDialog({ defaultName, format });
    if (!path) return;
    await runJob({
      kind: 'export',
      sourceKey,
      subject,
      start: (jobId) =>
        api.startExport(sid, {
          jobId,
          source,
          format,
          path,
          ...(format === 'csv' ? { csv: { delimiter: csv.delimiter, header: csv.header } } : {}),
        }),
    });
  };

  const csvSummary = `${delimiters.find((d) => d.value === csv.delimiter)!.label.toLowerCase()}${csv.header ? ', header' : ''}`;
  // Items keep the menu open while options change.
  const keepOpen = (e: Event) => e.preventDefault();

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button type="button" variant="outline" size="sm" disabled={disabled || running} className={className}>
          {running ? <LoaderCircle className="animate-spin" aria-hidden="true" /> : <Download aria-hidden="true" />}
          {running ? 'Exporting…' : 'Export…'}
          <ChevronDown className="text-muted-foreground -mr-0.5 size-3" aria-hidden="true" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-64">
        <DropdownMenuLabel className="text-muted-foreground text-xs leading-snug font-normal">
          {scopeNote}
        </DropdownMenuLabel>
        <DropdownMenuSeparator />
        <DropdownMenuItem onSelect={() => void exportAs('csv')}>
          CSV
          <DropdownMenuShortcut className="tracking-normal">{csvSummary}</DropdownMenuShortcut>
        </DropdownMenuItem>
        <DropdownMenuItem onSelect={() => void exportAs('json')}>JSON</DropdownMenuItem>
        <DropdownMenuItem onSelect={() => void exportAs('xlsx')}>Excel workbook</DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuSub>
          <DropdownMenuSubTrigger>CSV options</DropdownMenuSubTrigger>
          <DropdownMenuSubContent className="w-44">
            <DropdownMenuLabel className="text-muted-foreground text-xs font-normal">Delimiter</DropdownMenuLabel>
            <DropdownMenuRadioGroup
              value={csv.delimiter}
              onValueChange={(v) => setCsvOptions({ ...csv, delimiter: v as CsvDelimiter })}
            >
              {delimiters.map((d) => (
                <DropdownMenuRadioItem key={d.label} value={d.value} onSelect={keepOpen}>
                  {d.label}
                </DropdownMenuRadioItem>
              ))}
            </DropdownMenuRadioGroup>
            <DropdownMenuSeparator />
            <DropdownMenuCheckboxItem
              checked={csv.header}
              onCheckedChange={(header) => setCsvOptions({ ...csv, header: header === true })}
              onSelect={keepOpen}
            >
              Header row
            </DropdownMenuCheckboxItem>
          </DropdownMenuSubContent>
        </DropdownMenuSub>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/** Test hook: the remembered CSV options go back to comma + header. */
export function resetExportOptions(): void {
  lastCsvOptions = { delimiter: ',', header: true };
}
