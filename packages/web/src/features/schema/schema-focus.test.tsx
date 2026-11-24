import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type * as XyflowModule from '@xyflow/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Providers, workspaceState } from '@/features/workspace/test-workspace';
import type * as ApiModule from '@/lib/api';
import { api } from '@/lib/api';
import { framingViewport, SchemaTab, TABLE_FOCUS } from './schema-tab';
import { shopModel } from './test-fixtures';

vi.mock('@/lib/api', async (importOriginal) => {
  const actual = await importOriginal<typeof ApiModule>();
  return { ...actual, api: { getLayout: vi.fn(), saveLayout: vi.fn() } };
});

// jsdom measures nothing: tables report a size and bounds, and the view moves are observed.
const TABLE = { x: 100, y: 40, width: 260, height: 180 };
const ALL = { x: 0, y: 0, width: 1400, height: 600 };
const setViewport = vi.fn(async () => true);
vi.mock('@xyflow/react', async (importOriginal) => {
  const actual = await importOriginal<typeof XyflowModule>();
  return {
    ...actual,
    useReactFlow: () => {
      const flow = actual.useReactFlow();
      return {
        ...flow,
        setViewport,
        getInternalNode: (id: string) => {
          const node = flow.getInternalNode(id);
          return node ? { ...node, measured: { width: TABLE.width, height: TABLE.height } } : undefined;
        },
        getNodesBounds: (nodes: unknown[]) => (nodes.length === 1 ? TABLE : ALL),
      };
    },
  };
});

const PANE = { width: 1000, height: 700 };
const framedTable = () => [framingViewport(TABLE, PANE, TABLE_FOCUS), { duration: 300 }];
const orders = { schema: 'public', name: 'orders' };

beforeEach(() => {
  vi.mocked(api.getLayout).mockResolvedValue({ positions: {} });
  vi.mocked(api.saveLayout).mockResolvedValue(undefined);
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({
    ...PANE,
    x: 0,
    y: 0,
    top: 0,
    left: 0,
    right: PANE.width,
    bottom: PANE.height,
    toJSON: () => ({}),
  });
});
afterEach(() => {
  vi.restoreAllMocks();
  setViewport.mockClear();
});

async function drawn(state = workspaceState({ schemaModel: shopModel() })) {
  const view = render(
    <Providers state={state}>
      <SchemaTab />
    </Providers>,
  );
  const diagram = screen.getByRole('region', { name: 'ER diagram' });
  await within(diagram).findByText('order_items', undefined, { timeout: 8000 });
  return { ...view, state, diagram };
}

describe('framing a table on the diagram (0.7.1)', { timeout: 20_000 }, () => {
  it('centers the whole table, capped at 125 %, and zooms out for a long one', () => {
    const small = framingViewport({ x: 0, y: 0, width: 220, height: 120 }, PANE, TABLE_FOCUS);
    expect(small.zoom).toBe(1.25);
    // Centered: the table's middle lands on the pane's middle.
    expect(small.x + 110 * small.zoom).toBeCloseTo(PANE.width / 2);
    expect(small.y + 60 * small.zoom).toBeCloseTo(PANE.height / 2);
    const long = framingViewport({ x: 0, y: 0, width: 220, height: 2000 }, PANE, TABLE_FOCUS);
    // 10 % of the pane kept free on each side: 700 px × 0.8 / 2000.
    expect(long.zoom).toBeCloseTo(0.28);
  });

  it('frames the selected table from the detail panel button and with F', async () => {
    const user = userEvent.setup();
    await drawn(workspaceState({ schemaModel: shopModel(), selectedTable: orders }));
    await waitFor(() => expect(setViewport).toHaveBeenCalledWith(...framedTable()));
    setViewport.mockClear();

    await user.click(screen.getByRole('button', { name: 'Center on table' }));
    await waitFor(() => expect(setViewport).toHaveBeenCalledWith(...framedTable()));
    setViewport.mockClear();

    await user.keyboard('f');
    await waitFor(() => expect(setViewport).toHaveBeenCalledWith(...framedTable()));
  });

  it('ignores F while typing in a field', async () => {
    const user = userEvent.setup();
    await drawn(workspaceState({ schemaModel: shopModel(), selectedTable: orders }));
    await waitFor(() => expect(setViewport).toHaveBeenCalled());
    const input = document.createElement('input');
    document.body.append(input);
    input.focus();
    setViewport.mockClear();
    await user.keyboard('f');
    await new Promise((r) => setTimeout(r, 100));
    expect(setViewport).not.toHaveBeenCalled();
    input.remove();
  });

  it('frames a table selected from outside, but not one clicked on the diagram', async () => {
    const { rerender, state, diagram } = await drawn();
    setViewport.mockClear();

    const title = within(diagram).getByText('customers', { selector: 'span' });
    fireEvent.click(title.closest('.react-flow__node')!);
    expect(state.openTable).toHaveBeenCalledWith(expect.objectContaining({ schema: 'public', name: 'customers' }));
    rerender(
      <Providers state={{ ...state, selectedTable: { schema: 'public', name: 'customers' } }}>
        <SchemaTab />
      </Providers>,
    );
    await new Promise((r) => setTimeout(r, 100));
    expect(setViewport).not.toHaveBeenCalled();

    rerender(
      <Providers state={{ ...state, selectedTable: orders }}>
        <SchemaTab />
      </Providers>,
    );
    await waitFor(() => expect(setViewport).toHaveBeenCalledWith(...framedTable()));
  });

  it("shows every table from the zoom controls' Fit to view; a double-click on a table still opens its data", async () => {
    const user = userEvent.setup();
    const { state, diagram } = await drawn();
    setViewport.mockClear();

    await user.click(within(diagram).getByRole('button', { name: 'Fit to view' }));
    expect(setViewport).toHaveBeenCalledWith(framingViewport(ALL, PANE, { padding: '7%', maxZoom: 2 }), {
      duration: 300,
    });

    setViewport.mockClear();
    const title = within(diagram).getByText('orders', { selector: 'span' });
    fireEvent.doubleClick(title.closest('.react-flow__node')!);
    expect(state.openTable).toHaveBeenCalledWith(expect.objectContaining({ name: 'orders' }), 'data');
    expect(setViewport).not.toHaveBeenCalled();
  });
});
