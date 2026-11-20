import { useReactFlow } from '@xyflow/react';
import { ChevronDown, ImageDown, LoaderCircle } from 'lucide-react';
import { useState } from 'react';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuShortcut,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import type { ErGraph } from '../er-model';
import type { XY } from '../layout';
import { exportDiagram, type DiagramFormat } from './export-diagram';

/**
 * "Export diagram…" in the schema toolbar: PNG or SVG of the tables as drawn now (positions
 * from React Flow, so a table being dragged is exported where it is). Must sit inside the
 * diagram's ReactFlowProvider.
 */
export function ExportDiagramMenu({ graph, schema }: { graph: ErGraph; schema: string }) {
  const { getNodes } = useReactFlow();
  const [busy, setBusy] = useState(false);

  async function exportAs(format: DiagramFormat) {
    const positions: Record<string, XY> = {};
    for (const node of getNodes()) positions[node.id] = node.position;
    setBusy(true);
    try {
      await exportDiagram({ format, schema, graph, positions });
    } finally {
      setBusy(false);
    }
  }

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button type="button" variant="outline" size="sm" disabled={busy || graph.nodes.length === 0}>
          {busy ? <LoaderCircle className="animate-spin" aria-hidden="true" /> : <ImageDown aria-hidden="true" />}
          {busy ? 'Exporting…' : 'Export diagram…'}
          <ChevronDown className="text-muted-foreground -mr-0.5 size-3" aria-hidden="true" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-60">
        <DropdownMenuLabel className="text-muted-foreground text-xs leading-snug font-normal">
          The tables drawn, as placed, in the current appearance.
        </DropdownMenuLabel>
        <DropdownMenuSeparator />
        <DropdownMenuItem onSelect={() => void exportAs('png')}>
          PNG image
          <DropdownMenuShortcut className="tracking-normal">2×</DropdownMenuShortcut>
        </DropdownMenuItem>
        <DropdownMenuItem onSelect={() => void exportAs('svg')}>
          SVG image
          <DropdownMenuShortcut className="tracking-normal">vector</DropdownMenuShortcut>
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
