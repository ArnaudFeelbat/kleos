import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import { availableUpdateState, idleUpdateState, mockBridge, release051 } from '@/test/bridge-defaults';
import { announcedRelease, UpdateNotice } from './update-notice';
import { defaultSettings } from '@kleos/shared';

afterEach(() => {
  delete window.kleos;
});

function Harness() {
  const [open, setOpen] = useState(false);
  return <UpdateNotice open={open} onOpenChange={setOpen} />;
}

function renderNotice(options: Parameters<typeof mockBridge>[0] = {}) {
  const mock = mockBridge({ update: availableUpdateState, ...options });
  window.kleos = mock.bridge;
  render(<Harness />);
  return mock;
}

describe('Update notice', { timeout: 15_000 }, () => {
  it('shows a calm pill once a newer release is known, and the dialog it opens', async () => {
    const user = userEvent.setup();
    renderNotice();
    await user.click(await screen.findByRole('button', { name: 'Update available' }));
    const dialog = await screen.findByRole('dialog', { name: 'Kleos 0.5.1 is available' });
    expect(dialog).toHaveTextContent('You have 0.5.0.');
    const notes = within(dialog).getByRole('region', { name: 'What’s new' });
    expect(within(notes).getByRole('heading', { name: 'Corrigé' })).toBeInTheDocument();
    expect(within(notes).getAllByRole('listitem')).toHaveLength(2);
  });

  it('Download opens the DMG, or the release page when there is none', async () => {
    const user = userEvent.setup();
    const { bridge, emitUpdate } = renderNotice();
    await user.click(await screen.findByRole('button', { name: 'Update available' }));
    await user.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'Download' }));
    expect(bridge.openReleasePage).toHaveBeenLastCalledWith(release051.dmgUrl);
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());

    act(() => emitUpdate({ ...availableUpdateState, latest: { ...release051, dmgUrl: null } }));
    await user.click(screen.getByRole('button', { name: 'Update available' }));
    await user.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'Download' }));
    expect(bridge.openReleasePage).toHaveBeenLastCalledWith(release051.url);
  });

  it('Skip this version saves it and the pill goes away; Later only closes', async () => {
    const user = userEvent.setup();
    const { bridge } = renderNotice();
    await user.click(await screen.findByRole('button', { name: 'Update available' }));
    await user.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'Later' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(bridge.updateSettings).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: 'Update available' })).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Update available' }));
    await user.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'Skip this version' }));
    expect(bridge.updateSettings).toHaveBeenCalledWith({ skippedVersion: '0.5.1' });
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Update available' })).not.toBeInTheDocument());
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('stays hidden for a skipped version, before any check, and appears when a check finds one', async () => {
    const skipped = renderNotice({ settings: { skippedVersion: '0.5.1' } });
    await waitFor(() => expect(skipped.bridge.getSettings).toHaveBeenCalled());
    expect(screen.queryByRole('button', { name: 'Update available' })).not.toBeInTheDocument();

    // A later release than the skipped one is announced again.
    act(() => skipped.emitUpdate({ ...availableUpdateState, latest: { ...release051, version: '0.5.2' } }));
    expect(await screen.findByRole('button', { name: 'Update available' })).toBeInTheDocument();
  });

  it('announces only a newer, not skipped release', () => {
    expect(announcedRelease(idleUpdateState, defaultSettings)).toBeNull();
    expect(announcedRelease(availableUpdateState, defaultSettings)).toBe(release051);
    expect(announcedRelease(availableUpdateState, { ...defaultSettings, skippedVersion: '0.5.1' })).toBeNull();
    // Kept while a later check runs, so the pill doesn't blink.
    expect(announcedRelease({ ...availableUpdateState, status: 'checking' }, defaultSettings)).toBe(release051);
    // Never a release older than (or equal to) the running one.
    expect(announcedRelease({ ...availableUpdateState, current: '0.5.1' }, defaultSettings)).toBeNull();
    expect(announcedRelease({ ...availableUpdateState, status: 'error' }, defaultSettings)).toBe(release051);
    expect(announcedRelease({ ...availableUpdateState, status: 'current' }, defaultSettings)).toBeNull();
  });
});
