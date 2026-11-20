import { toast } from 'sonner';
import { fileName } from '@/features/jobs/job-runner';
import { errorText } from '@/lib/api';
import { getBridge, type KleosBridge } from '@/lib/bridge';
import type { ErGraph } from '../er-model';
import type { XY } from '../layout';
import { buildDiagramSvg } from './diagram-svg';
import { readDiagramTheme, type DiagramTheme } from './diagram-theme';
import { pngScale, svgToPng } from './rasterize';

export type DiagramFormat = 'png' | 'svg';

export type ExportDiagramArgs = {
  format: DiagramFormat;
  schema: string;
  graph: Pick<ErGraph, 'nodes' | 'edges'>;
  /** Top-left corner of each node as currently drawn. */
  positions: Record<string, XY>;
  /** Seams for tests; the defaults read the page. */
  bridge?: Pick<KleosBridge, 'saveFileDialog' | 'writeFile' | 'revealInFinder'>;
  theme?: () => DiagramTheme;
  rasterize?: typeof svgToPng;
};

/** Electron prefixes main-process errors; the toast only needs what the handler said. */
function cleanError(err: unknown): string {
  return errorText(err).replace(/^Error invoking remote method '[^']+': (?:\w*Error: )?/, '');
}

/**
 * "Export diagram…": asks where to save, builds the SVG of the diagram as drawn (in the current
 * appearance), rasterizes it for PNG, and has the main process write it. Resolves to the path
 * written, or null when cancelled or failed (a toast says which).
 */
export async function exportDiagram({
  format,
  schema,
  graph,
  positions,
  bridge = getBridge(),
  theme = readDiagramTheme,
  rasterize = svgToPng,
}: ExportDiagramArgs): Promise<string | null> {
  const path = await bridge.saveFileDialog({ defaultName: `${schema}-diagram`, format });
  if (!path) return null;
  try {
    const drawn = buildDiagramSvg({ graph, positions, theme: theme(), title: `${schema} — ER diagram` });
    const data =
      format === 'svg'
        ? drawn.svg
        : await rasterize(drawn.svg, drawn.width, drawn.height, pngScale(drawn.width, drawn.height));
    await bridge.writeFile(path, data);
  } catch (err) {
    toast.error('Couldn’t export the diagram', { description: cleanError(err), duration: 15_000 });
    return null;
  }
  toast.success(`Exported diagram to ${fileName(path)}`, {
    duration: 10_000,
    action: { label: 'Show in Finder', onClick: () => bridge.revealInFinder(path) },
  });
  return path;
}
