import { act, render, screen, waitFor, within } from '@testing-library/react';
import type { ReactNode } from 'react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it } from 'vitest';
import { Dialog, DialogContent, DialogTitle } from '@/components/ui/dialog';
import { resetBridgeStores } from '@/lib/settings';
import { mockBridge } from '@/test/bridge-defaults';
import { UpdateConsent } from './update-consent';

afterEach(() => {
  delete window.kleos;
});

function renderConsent(updateChecks: 'ask' | 'on' | 'off', extra?: ReactNode) {
  const mock = mockBridge({ settings: { updateChecks } });
  window.kleos = mock.bridge;
  const view = render(
    <>
      {extra}
      <UpdateConsent settleMs={0} />
    </>,
  );
  return { ...mock, ...view };
}

const question = () => screen.queryByRole('region', { name: 'Check for new versions?' });

describe('First-time update question', { timeout: 15_000 }, () => {
  it('asks once, with the plain promise; Check automatically turns checks on and the card goes', async () => {
    const user = userEvent.setup();
    const { bridge } = renderConsent('ask');
    const card = await screen.findByRole('region', { name: 'Check for new versions?' });
    expect(card).toHaveTextContent(
      'Once a day, Kleos asks GitHub whether a newer version is out. Nothing else leaves your Mac.',
    );
    // Not a modal: nothing else on the page is blocked.
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();

    await user.click(within(card).getByRole('button', { name: 'Check automatically' }));
    expect(bridge.updateSettings).toHaveBeenCalledWith({ updateChecks: 'on' });
    await waitFor(() => expect(question()).not.toBeInTheDocument());
  });

  it('Not now turns checks off', async () => {
    const user = userEvent.setup();
    const { bridge } = renderConsent('ask');
    await user.click(await screen.findByRole('button', { name: 'Not now' }));
    expect(bridge.updateSettings).toHaveBeenCalledWith({ updateChecks: 'off' });
    await waitFor(() => expect(question()).not.toBeInTheDocument());
  });

  it('never asks once decided, and goes away when Settings decides first', async () => {
    const decided = renderConsent('off');
    await waitFor(() => expect(decided.bridge.getSettings).toHaveBeenCalled());
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(question()).not.toBeInTheDocument();
    decided.unmount();
    resetBridgeStores();
    delete window.kleos;

    const asked = renderConsent('ask');
    await screen.findByRole('region', { name: 'Check for new versions?' });
    act(() => asked.emitSettings({ updateChecks: 'on' }));
    await waitFor(() => expect(question()).not.toBeInTheDocument());
  });

  it('waits while a dialog is open, then asks', async () => {
    const view = renderConsent(
      'ask',
      <Dialog open>
        <DialogContent>
          <DialogTitle>Password for shop_dev</DialogTitle>
        </DialogContent>
      </Dialog>,
    );
    await waitFor(() => expect(view.bridge.getSettings).toHaveBeenCalled());
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(question()).not.toBeInTheDocument();

    view.rerender(<UpdateConsent settleMs={0} />);
    expect(await screen.findByRole('region', { name: 'Check for new versions?' }, { timeout: 3000 })).toBeVisible();
  });
});
