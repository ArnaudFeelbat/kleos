import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Providers, workspaceState } from '@/features/workspace/test-workspace';
import type * as ApiModule from '@/lib/api';
import { api } from '@/lib/api';
import { SchemaTab } from './schema-tab';
import { shopModel } from './test-fixtures';

vi.mock('@/lib/api', async (importOriginal) => {
  const actual = await importOriginal<typeof ApiModule>();
  return { ...actual, api: { getLayout: vi.fn(), saveLayout: vi.fn() } };
});

const mocked = vi.mocked(api);

beforeEach(() => {
  mocked.saveLayout.mockResolvedValue(undefined);
});
afterEach(() => vi.clearAllMocks());

// elk runs cold in jsdom and can take seconds when the machine is busy.
describe('SchemaTab', { timeout: 20_000 }, () => {
  it('lays out a schema without saved positions with elk and saves it', async () => {
    mocked.getLayout.mockResolvedValue({ positions: {} });
    render(
      <Providers state={workspaceState({ schemaModel: shopModel() })}>
        <SchemaTab />
      </Providers>,
    );
    const diagram = screen.getByRole('region', { name: 'ER diagram' });
    expect(await within(diagram).findByText('order_items', undefined, { timeout: 8000 })).toBeInTheDocument();
    expect(within(diagram).getAllByLabelText('Primary key').length).toBeGreaterThanOrEqual(5);
    expect(within(diagram).getByText('jsonb?')).toBeInTheDocument();
    await waitFor(() => expect(mocked.saveLayout).toHaveBeenCalledTimes(1), { timeout: 8000 });
    const [connectionId, schema, layout] = mocked.saveLayout.mock.calls[0]!;
    expect([connectionId, schema]).toEqual(['c1', 'public']);
    expect(Object.keys(layout.positions).sort()).toEqual([
      'public.categories',
      'public.customers',
      'public.order_items',
      'public.orders',
      'public.products',
      // External node: sales.invoices references public.orders.
      'sales.invoices',
    ]);
  });

  it('reopens with saved positions without saving again', async () => {
    const positions = Object.fromEntries(
      ['categories', 'customers', 'order_items', 'orders', 'products'].map((n, i) => [
        `public.${n}`,
        { x: i * 300, y: 0 },
      ]),
    );
    mocked.getLayout.mockResolvedValue({ positions });
    render(
      <Providers state={workspaceState({ schemaModel: shopModel() })}>
        <SchemaTab />
      </Providers>,
    );
    expect(await screen.findByText('order_items', undefined, { timeout: 8000 })).toBeInTheDocument();
    await new Promise((r) => setTimeout(r, 800));
    expect(mocked.saveLayout).not.toHaveBeenCalled();
  });

  it('shows the selected table in the detail panel with its actions', async () => {
    const user = userEvent.setup();
    mocked.getLayout.mockResolvedValue({ positions: {} });
    const state = workspaceState({ schemaModel: shopModel(), selectedTable: { schema: 'public', name: 'orders' } });
    render(
      <Providers state={state}>
        <SchemaTab />
      </Providers>,
    );
    const panel = screen.getByRole('complementary', { name: 'Table details' });
    expect(panel).toHaveTextContent('~1,204,380 rows (estimate) · 412 MB · 3 columns');
    await user.click(within(panel).getByRole('button', { name: /customers\.id/ }));
    expect(state.openTable).toHaveBeenCalledWith({ schema: 'public', name: 'customers' });
    await user.click(within(panel).getByRole('button', { name: /View data/ }));
    expect(state.openTable).toHaveBeenLastCalledWith(expect.objectContaining({ name: 'orders' }), 'data');
    await user.click(within(panel).getByRole('button', { name: 'Open in query' }));
    expect(state.openInQuery).toHaveBeenCalledWith('select * from "public"."orders" limit 100;');
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('complementary', { name: 'Table details' })).not.toBeInTheDocument();
  });
});
