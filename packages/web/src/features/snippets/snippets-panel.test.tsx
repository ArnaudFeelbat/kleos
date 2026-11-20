import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Snippet } from '@kleos/shared';
import { resetWorkspaceIntents, useWorkspaceIntent } from '@/features/shell/workspace-intents';
import { Providers, workspaceState } from '@/features/workspace/test-workspace';
import type * as ApiModule from '@/lib/api';
import { api, ApiError } from '@/lib/api';
import { SnippetsPanel } from './snippets-panel';

vi.mock('@/lib/api', async (importOriginal) => {
  const actual = await importOriginal<typeof ApiModule>();
  return {
    ...actual,
    api: { snippets: vi.fn(), createSnippet: vi.fn(), updateSnippet: vi.fn(), deleteSnippet: vi.fn() },
  };
});
// CodeMirror needs layout jsdom lacks; the editor is a seam, a textarea stands in for it.
vi.mock('./snippet-editor', () => ({
  SnippetEditor: (props: { value: string; onChange(v: string): void; label: string }) => (
    <textarea aria-label={props.label} value={props.value} onChange={(e) => props.onChange(e.target.value)} />
  ),
}));
const mocked = vi.mocked(api);

const snippet = (patch: Partial<Snippet>): Snippet => ({
  id: 'n1',
  name: 'Recent orders',
  body: '\n  select * from orders\n  order by created_at desc limit 50',
  createdAt: '',
  updatedAt: '',
  ...patch,
});

function IntentProbe() {
  const intent = useWorkspaceIntent('s1');
  return <p data-testid="intent">{intent ? JSON.stringify(intent.intent) : 'none'}</p>;
}

function renderPanel() {
  render(
    <Providers state={workspaceState({ activeTab: 'query' })}>
      <SnippetsPanel />
      <IntentProbe />
    </Providers>,
  );
}

const recent = snippet({});
beforeEach(() => {
  mocked.snippets.mockResolvedValue([recent, snippet({ id: 'n2', name: 'Locks', body: 'select * from pg_locks' })]);
});
afterEach(() => {
  vi.clearAllMocks();
  resetWorkspaceIntents();
});

describe('SnippetsPanel', () => {
  it('lists snippets by name with their first line', async () => {
    renderPanel();
    const list = await screen.findByRole('list', { name: 'Snippets' });
    const items = within(list).getAllByRole('listitem');
    expect(items[0]).toHaveTextContent('Recent orders');
    expect(items[0]).toHaveTextContent('select * from orders');
    expect(items[0]).not.toHaveTextContent('created_at');
    expect(items[1]).toHaveTextContent('Locks');
  });

  it('shows an empty state with nothing saved', async () => {
    mocked.snippets.mockResolvedValue([]);
    renderPanel();
    expect(await screen.findByText('No snippets yet')).toBeInTheDocument();
  });

  it('inserts a snippet into the current query tab with Insert or a double-click', async () => {
    const user = userEvent.setup();
    renderPanel();
    await user.click(await screen.findByRole('button', { name: 'Insert Locks' }));
    expect(screen.getByTestId('intent')).toHaveTextContent(
      JSON.stringify({ kind: 'insert-sql', text: 'select * from pg_locks' }),
    );
    await user.dblClick(screen.getByText('Recent orders'));
    expect(screen.getByTestId('intent').textContent).toBe(JSON.stringify({ kind: 'insert-sql', text: recent.body }));
  });

  it('creates a snippet and refreshes the list', async () => {
    const user = userEvent.setup();
    mocked.createSnippet.mockResolvedValue(snippet({ id: 'n3', name: 'Bloat', body: 'select 1' }));
    renderPanel();
    await screen.findByRole('list', { name: 'Snippets' });
    await user.click(screen.getByRole('button', { name: 'New snippet' }));
    const dialog = await screen.findByRole('dialog', { name: 'New snippet' });
    const create = within(dialog).getByRole('button', { name: 'Create snippet' });
    expect(create).toBeDisabled();
    await user.type(within(dialog).getByLabelText('Name'), '  Bloat ');
    await user.type(within(dialog).getByLabelText('Snippet SQL'), 'select 1');
    await user.click(create);
    expect(mocked.createSnippet).toHaveBeenCalledWith({ name: 'Bloat', body: 'select 1' });
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(mocked.snippets).toHaveBeenCalledTimes(2);
  });

  it('shows the server’s message under the name when the name is taken, and keeps the dialog open', async () => {
    const user = userEvent.setup();
    mocked.createSnippet.mockRejectedValue(
      new ApiError(409, { code: 'KLEOS_SNIPPET_NAME_TAKEN', message: 'A snippet named "Locks" already exists' }),
    );
    renderPanel();
    await user.click(await screen.findByRole('button', { name: 'New snippet' }));
    const dialog = await screen.findByRole('dialog', { name: 'New snippet' });
    const name = within(dialog).getByLabelText('Name');
    await user.type(name, 'locks');
    await user.type(within(dialog).getByLabelText('Snippet SQL'), 'select 2');
    await user.click(within(dialog).getByRole('button', { name: 'Create snippet' }));
    expect(await within(dialog).findByText('A snippet named "Locks" already exists')).toBeInTheDocument();
    expect(name).toHaveAttribute('aria-invalid', 'true');
    expect(name).toHaveAccessibleDescription('A snippet named "Locks" already exists');
    // Editing the name clears the message.
    await user.type(name, ' 2');
    expect(within(dialog).queryByText('A snippet named "Locks" already exists')).not.toBeInTheDocument();
  });

  it('edits a snippet from its actions menu', async () => {
    const user = userEvent.setup();
    mocked.updateSnippet.mockResolvedValue(snippet({ name: 'Latest orders' }));
    renderPanel();
    await user.click(await screen.findByRole('button', { name: 'Actions for Recent orders' }));
    await user.click(await screen.findByRole('menuitem', { name: 'Edit…' }));
    const dialog = await screen.findByRole('dialog', { name: 'Edit snippet' });
    const name = within(dialog).getByLabelText('Name');
    expect(name).toHaveValue('Recent orders');
    expect(within(dialog).getByLabelText('Snippet SQL')).toHaveValue(recent.body);
    await user.clear(name);
    await user.type(name, 'Latest orders');
    await user.click(within(dialog).getByRole('button', { name: 'Save' }));
    expect(mocked.updateSnippet).toHaveBeenCalledWith('n1', { name: 'Latest orders', body: recent.body });
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
  });

  it('deletes a snippet after confirmation', async () => {
    const user = userEvent.setup();
    mocked.deleteSnippet.mockResolvedValue(undefined);
    renderPanel();
    await user.click(await screen.findByRole('button', { name: 'Actions for Locks' }));
    await user.click(await screen.findByRole('menuitem', { name: 'Delete…' }));
    const confirm = await screen.findByRole('alertdialog', { name: 'Delete “Locks”?' });
    expect(mocked.deleteSnippet).not.toHaveBeenCalled();
    await user.click(within(confirm).getByRole('button', { name: 'Delete' }));
    expect(mocked.deleteSnippet).toHaveBeenCalledWith('n2');
    await waitFor(() => expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument());
  });
});
