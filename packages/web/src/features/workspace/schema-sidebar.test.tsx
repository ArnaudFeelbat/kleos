import type { TableRef } from '@kleos/shared';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { shopModel } from '@/features/schema/test-fixtures';
import type { WorkspaceState } from './context';
import { SchemaSidebar } from './schema-sidebar';
import { Providers, workspaceState } from './test-workspace';

/** Holds the selection like WorkspaceScreen does, so highlight follows clicks. */
function Harness({ openTable }: { openTable: WorkspaceState['openTable'] }) {
  const [selected, setSelected] = useState<TableRef | null>(null);
  const state = workspaceState({
    schemaModel: shopModel(),
    selectedTable: selected,
    openTable: (ref, tab) => {
      setSelected(ref);
      openTable(ref, tab);
    },
  });
  return (
    <Providers state={state}>
      <SchemaSidebar schemaError={null} />
    </Providers>
  );
}

function setup() {
  const openTable = vi.fn();
  const user = userEvent.setup();
  render(<Harness openTable={openTable} />);
  const nav = screen.getByRole('navigation', { name: 'Schema objects' });
  return { openTable, user, nav };
}

describe('SchemaSidebar', { timeout: 15_000 }, () => {
  it('lists the current schema by section with counts and row estimates', () => {
    const { nav } = setup();
    const tables = within(nav).getByRole('group', { name: 'Tables' });
    expect(
      within(tables)
        .getAllByRole('button')
        .map((b) => b.textContent),
    ).toEqual(['categories', 'customers12.4k', 'order_items100', 'orders1.2M', 'products2,184']);
    expect(tables).toHaveTextContent('Tables5');
    // invoices lives in the "sales" schema.
    expect(within(nav).queryByText('invoices')).not.toBeInTheDocument();
    expect(within(nav).getByRole('group', { name: 'Views' })).toHaveTextContent('active_customers');
    expect(within(nav).getByRole('group', { name: 'Enums' })).toHaveTextContent('order_status3');
  });

  it('filters every section by name', async () => {
    const { nav, user } = setup();
    await user.type(screen.getByLabelText('Filter tables'), 'ORDER');
    const tables = within(nav).getByRole('group', { name: 'Tables' });
    expect(
      within(tables)
        .getAllByRole('button')
        .map((b) => b.textContent),
    ).toEqual(['order_items100', 'orders1.2M']);
    expect(within(nav).getByRole('group', { name: 'Views' })).toHaveTextContent('Views0');
    expect(within(nav).getByRole('group', { name: 'Enums' })).toHaveTextContent('order_status');

    await user.clear(screen.getByLabelText('Filter tables'));
    await user.type(screen.getByLabelText('Filter tables'), 'zzz');
    expect(within(nav).getByText(/Nothing in public matches/)).toBeInTheDocument();
  });

  it('selects on click and opens the Data tab on double-click or Enter', async () => {
    const { nav, user, openTable } = setup();
    const orders = within(nav).getByRole('button', { name: /^orders/ });
    await user.click(orders);
    expect(openTable).toHaveBeenLastCalledWith({ schema: 'public', name: 'orders' }, undefined);
    expect(orders).toHaveAttribute('aria-current', 'true');
    expect(within(nav).getByRole('button', { name: /^customers/ })).not.toHaveAttribute('aria-current');

    await user.dblClick(within(nav).getByRole('button', { name: /^products/ }));
    expect(openTable).toHaveBeenLastCalledWith({ schema: 'public', name: 'products' }, 'data');

    within(nav)
      .getByRole('button', { name: /^categories/ })
      .focus();
    await user.keyboard('{Enter}');
    expect(openTable).toHaveBeenLastCalledWith({ schema: 'public', name: 'categories' }, 'data');
  });

  it('refreshes the schema from the footer button', async () => {
    const refreshSchema = vi.fn(async () => {});
    const user = userEvent.setup();
    render(
      <Providers state={workspaceState({ schemaModel: shopModel(), refreshSchema })}>
        <SchemaSidebar schemaError={null} />
      </Providers>,
    );
    await user.click(screen.getByRole('button', { name: 'Refresh schema' }));
    expect(refreshSchema).toHaveBeenCalledTimes(1);
  });
});
