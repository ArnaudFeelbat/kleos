import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ReactFlow, ReactFlowProvider, type Node } from '@xyflow/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { KleosBridge } from '@/lib/bridge';
import { mockBridge } from '@/test/bridge-defaults';
import { buildErGraph } from '../er-model';
import { shopModel } from '../test-fixtures';
import { diagramTheme } from './diagram-theme';
import { exportDiagram } from './export-diagram';
import { ExportDiagramMenu } from './export-diagram-menu';

const toastMock = vi.hoisted(() => {
  const fn = vi.fn() as ReturnType<typeof vi.fn> & Record<'success' | 'error', ReturnType<typeof vi.fn>>;
  fn.success = vi.fn();
  fn.error = vi.fn();
  return fn;
});
vi.mock('sonner', () => ({ toast: toastMock }));

type ToastAction = { action?: { label: string; onClick(): void }; description?: string };
const lastOptions = (fn: ReturnType<typeof vi.fn>) => fn.mock.calls.at(-1)![1] as ToastAction;

const graph = buildErGraph(shopModel(), 'sales', null);
const positions = { 'sales.invoices': { x: 400, y: 0 }, 'public.orders': { x: 0, y: 0 } };
const theme = () => diagramTheme(false);

function exportBridge() {
  return {
    ...mockBridge().bridge,
    saveFileDialog: vi.fn<KleosBridge['saveFileDialog']>(async () => null),
    writeFile: vi.fn<KleosBridge['writeFile']>(async () => {}),
  } satisfies KleosBridge;
}

let bridge: ReturnType<typeof exportBridge>;
beforeEach(() => {
  bridge = exportBridge();
});
afterEach(() => {
  vi.clearAllMocks();
  delete window.kleos;
});

describe('exportDiagram', () => {
  it('writes the SVG text to the picked file and offers to show it in Finder', async () => {
    bridge.saveFileDialog.mockResolvedValue('/Users/me/Downloads/sales-diagram.svg');
    const path = await exportDiagram({ format: 'svg', schema: 'sales', graph, positions, bridge, theme });
    expect(path).toBe('/Users/me/Downloads/sales-diagram.svg');
    expect(bridge.saveFileDialog).toHaveBeenCalledWith({ defaultName: 'sales-diagram', format: 'svg' });
    const [writtenPath, data] = bridge.writeFile.mock.calls[0]!;
    expect(writtenPath).toBe('/Users/me/Downloads/sales-diagram.svg');
    expect(typeof data).toBe('string');
    expect(data).toContain('<title>sales — ER diagram</title>');
    expect(data).toContain('invoices');

    expect(toastMock.success).toHaveBeenCalledWith('Exported diagram to sales-diagram.svg', expect.anything());
    const action = lastOptions(toastMock.success).action!;
    expect(action.label).toBe('Show in Finder');
    action.onClick();
    expect(bridge.revealInFinder).toHaveBeenCalledWith('/Users/me/Downloads/sales-diagram.svg');
  });

  it('rasterizes for PNG at 2× and writes the bytes', async () => {
    bridge.saveFileDialog.mockResolvedValue('/tmp/out/sales-diagram.png');
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47]);
    const rasterize = vi.fn(async () => png);
    await exportDiagram({ format: 'png', schema: 'sales', graph, positions, bridge, theme, rasterize });
    expect(bridge.saveFileDialog).toHaveBeenCalledWith({ defaultName: 'sales-diagram', format: 'png' });
    const [svg, width, height, scale] = rasterize.mock.calls[0]! as unknown as [string, number, number, number];
    expect(svg).toContain('<svg xmlns="http://www.w3.org/2000/svg"');
    expect(svg).toContain(`width="${width}" height="${height}"`);
    expect(scale).toBe(2);
    expect(bridge.writeFile).toHaveBeenCalledWith('/tmp/out/sales-diagram.png', png);
    expect(toastMock.success).toHaveBeenCalledWith('Exported diagram to sales-diagram.png', expect.anything());
  });

  it('does nothing more when the save dialog is cancelled', async () => {
    bridge.saveFileDialog.mockResolvedValue(null);
    const rasterize = vi.fn();
    expect(await exportDiagram({ format: 'png', schema: 'sales', graph, positions, bridge, theme, rasterize })).toBe(
      null,
    );
    expect(rasterize).not.toHaveBeenCalled();
    expect(bridge.writeFile).not.toHaveBeenCalled();
    expect(toastMock.success).not.toHaveBeenCalled();
    expect(toastMock.error).not.toHaveBeenCalled();
  });

  it('says why when the file cannot be written', async () => {
    bridge.saveFileDialog.mockResolvedValue('/Users/me/Downloads/sales-diagram.svg');
    bridge.writeFile.mockRejectedValue(
      new Error(
        "Error invoking remote method 'kleos:write-file': Error: Only the file just picked in the save dialog can be written.",
      ),
    );
    expect(await exportDiagram({ format: 'svg', schema: 'sales', graph, positions, bridge, theme })).toBe(null);
    expect(toastMock.error).toHaveBeenCalledWith('Couldn’t export the diagram', expect.anything());
    expect(lastOptions(toastMock.error).description).toBe(
      'Only the file just picked in the save dialog can be written.',
    );
    expect(toastMock.success).not.toHaveBeenCalled();
  });
});

describe('ExportDiagramMenu', () => {
  it('exports the tables where React Flow currently draws them', async () => {
    const user = userEvent.setup();
    window.kleos = bridge;
    bridge.saveFileDialog.mockResolvedValue('/Users/me/Downloads/sales-diagram.svg');
    const nodes: Node[] = [
      { id: 'sales.invoices', position: { x: 512, y: 64 }, data: { label: 'invoices' } },
      { id: 'public.orders', position: { x: 0, y: 0 }, data: { label: 'orders' } },
    ];
    render(
      <ReactFlowProvider>
        <ExportDiagramMenu graph={graph} schema="sales" />
        <div style={{ width: 800, height: 600 }}>
          <ReactFlow nodes={nodes} edges={[]} />
        </div>
      </ReactFlowProvider>,
    );
    await user.click(screen.getByRole('button', { name: /Export diagram/ }));
    expect(screen.getByRole('menuitem', { name: /PNG image/ })).toBeInTheDocument();
    await user.click(screen.getByRole('menuitem', { name: /SVG image/ }));
    await waitFor(() => expect(bridge.writeFile).toHaveBeenCalledTimes(1));
    const svg = bridge.writeFile.mock.calls[0]![1] as string;
    // invoices sits at x 512: its card rect starts there.
    expect(svg).toMatch(/<g id="table-sales\.invoices"><rect x="512" y="64"/);
    expect(svg).toMatch(/<g id="table-public\.orders"><rect x="0" y="0"/);
  });

  it('is off while nothing is drawn', () => {
    render(
      <ReactFlowProvider>
        <ExportDiagramMenu graph={{ ...graph, nodes: [], edges: [] }} schema="sales" />
      </ReactFlowProvider>,
    );
    expect(screen.getByRole('button', { name: /Export diagram/ })).toBeDisabled();
  });
});
