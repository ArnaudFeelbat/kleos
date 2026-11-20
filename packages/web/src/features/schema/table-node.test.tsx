import { fireEvent, render, screen, within } from '@testing-library/react';
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
  mocked.getLayout.mockResolvedValue({
    positions: { 'public.orders': { x: 0, y: 0 }, 'sales.invoices': { x: 400, y: 0 } },
  });
});
afterEach(() => vi.clearAllMocks());

describe('external table node', { timeout: 20_000 }, () => {
  it('shows the other schema’s table by its qualified name with only its key columns', async () => {
    render(
      <Providers state={workspaceState({ schemaModel: shopModel(), currentSchema: 'sales' })}>
        <SchemaTab />
      </Providers>,
    );
    const diagram = screen.getByRole('region', { name: 'ER diagram' });
    const node = await within(diagram).findByTitle(/In schema public/, undefined, { timeout: 8000 });
    expect(node).toHaveTextContent(/^public\.orders/);
    expect(within(node).getByText('id')).toBeInTheDocument();
    expect(within(node).queryByText('customer_id')).not.toBeInTheDocument();
    // The edge is drawn; nothing is left in the "not drawn" note.
    expect(within(diagram).queryByText(/not drawn/)).not.toBeInTheDocument();
  });

  it('switches the diagram to its schema on double-click, not on a single click', async () => {
    const state = workspaceState({ schemaModel: shopModel(), currentSchema: 'sales' });
    render(
      <Providers state={state}>
        <SchemaTab />
      </Providers>,
    );
    const node = await screen.findByTitle(/In schema public/, undefined, { timeout: 8000 });
    fireEvent.click(node);
    expect(state.openTable).not.toHaveBeenCalled();
    fireEvent.doubleClick(node);
    // openTable picks the table's schema: the diagram follows, with the table selected.
    expect(state.openTable).toHaveBeenCalledTimes(1);
    expect(state.openTable).toHaveBeenCalledWith({ schema: 'public', name: 'orders' });
  });
});
