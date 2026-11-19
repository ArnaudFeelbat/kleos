import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { availableUpdateState, idleUpdateState, mockBridge, release051 } from '@/test/bridge-defaults';
import { formatCheckedAt, SettingsWindow, timeoutLabel, type SettingsPane } from './settings-window';

beforeAll(() => {
  // Radix Select captures the pointer; jsdom has no pointer capture.
  Element.prototype.hasPointerCapture ??= () => false;
  Element.prototype.releasePointerCapture ??= () => {};
});

afterEach(() => {
  delete window.kleos;
  window.location.hash = '';
});

function renderSettings(options: Parameters<typeof mockBridge>[0] = {}, initialPane?: SettingsPane) {
  const mock = mockBridge({ windowKind: 'settings', ...options });
  window.kleos = mock.bridge;
  render(<SettingsWindow initialPane={initialPane} />);
  return mock;
}

describe('Settings window', { timeout: 15_000 }, () => {
  it('shows three panes in a toolbar and titles the window after the selected one', async () => {
    const user = userEvent.setup();
    const { bridge } = renderSettings();
    const toolbar = screen.getByRole('tablist', { name: 'Settings' });
    expect(
      within(toolbar)
        .getAllByRole('tab')
        .map((t) => t.textContent),
    ).toEqual(['General', 'Data', 'Updates']);
    expect(within(toolbar).getByRole('tab', { name: 'General' })).toHaveAttribute('aria-selected', 'true');
    expect(bridge.setTitle).toHaveBeenLastCalledWith('General');

    await user.click(within(toolbar).getByRole('tab', { name: 'Data' }));
    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent('Data');
    expect(bridge.setTitle).toHaveBeenLastCalledWith('Data');
  });

  it('opens on the pane the URL names', () => {
    window.location.hash = '#updates';
    renderSettings();
    expect(screen.getByRole('tab', { name: 'Updates' })).toHaveAttribute('aria-selected', 'true');
  });
});

describe('General pane', { timeout: 15_000 }, () => {
  it('saves the appearance at once and follows a change made elsewhere', async () => {
    const user = userEvent.setup();
    const { bridge, emitSettings } = renderSettings();
    const group = screen.getByRole('radiogroup', { name: 'Appearance' });
    await waitFor(() => expect(within(group).getByRole('radio', { name: 'System' })).toBeChecked());

    await user.click(within(group).getByRole('radio', { name: 'Dark' }));
    expect(bridge.updateSettings).toHaveBeenCalledWith({ appearance: 'dark' });
    await waitFor(() => expect(within(group).getByRole('radio', { name: 'Dark' })).toBeChecked());

    // The View menu changes it from the main process.
    act(() => emitSettings({ appearance: 'light' }));
    expect(within(group).getByRole('radio', { name: 'Light' })).toBeChecked();
  });
});

describe('Data pane', { timeout: 15_000 }, () => {
  it('saves rows per page and the query timeout, and says when the timeout applies', async () => {
    const user = userEvent.setup();
    const { bridge, emitSettings } = renderSettings({ settings: { pageSize: 200 } }, 'data');
    const sizes = screen.getByRole('radiogroup', { name: 'Rows per page' });
    expect(
      within(sizes)
        .getAllByRole('radio')
        .map((r) => r.textContent),
    ).toEqual(['100', '200', '500', '1,000']);
    await waitFor(() => expect(within(sizes).getByRole('radio', { name: '200' })).toBeChecked());

    await user.click(within(sizes).getByRole('radio', { name: '1,000' }));
    expect(bridge.updateSettings).toHaveBeenLastCalledWith({ pageSize: 1000 });
    await waitFor(() => expect(within(sizes).getByRole('radio', { name: '1,000' })).toBeChecked());
    // Clicking the selected size again keeps it (a toggle group would otherwise clear it).
    await user.click(within(sizes).getByRole('radio', { name: '1,000' }));
    expect(bridge.updateSettings).toHaveBeenCalledTimes(1);

    const timeout = screen.getByRole('combobox', { name: 'Query timeout' });
    expect(timeout).toHaveTextContent('Off');
    await user.click(timeout);
    expect((await screen.findAllByRole('option')).map((o) => o.textContent)).toEqual([
      'Off',
      '30 seconds',
      '1 minute',
      '5 minutes',
      '15 minutes',
    ]);
    await user.click(screen.getByRole('option', { name: '5 minutes' }));
    expect(bridge.updateSettings).toHaveBeenLastCalledWith({ queryTimeoutSeconds: 300 });
    await waitFor(() => expect(timeout).toHaveTextContent('5 minutes'));

    expect(screen.getByText(/applies to servers connected after the change/)).toHaveTextContent(
      'A statement can still SET statement_timeout for itself.',
    );

    act(() => emitSettings({ pageSize: 100, queryTimeoutSeconds: 30 }));
    expect(within(sizes).getByRole('radio', { name: '100' })).toBeChecked();
    expect(timeout).toHaveTextContent('30 seconds');
  });

  it('labels every timeout', () => {
    expect([0, 30, 60, 300, 900].map((s) => timeoutLabel(s as 0))).toEqual([
      'Off',
      '30 seconds',
      '1 minute',
      '5 minutes',
      '15 minutes',
    ]);
  });
});

describe('Updates pane', { timeout: 15_000 }, () => {
  it('turns automatic checks on and off with the plain promise, and follows the main window’s answer', async () => {
    const user = userEvent.setup();
    const { bridge, emitSettings } = renderSettings({ settings: { updateChecks: 'ask' } }, 'updates');
    const toggle = screen.getByRole('switch', { name: 'Check for new versions automatically' });
    expect(screen.getByText(/Once a day, Kleos asks GitHub whether a newer version is out\./)).toHaveTextContent(
      'Nothing else leaves your Mac.',
    );
    // Undecided reads as off: nothing is checked until the user says so.
    expect(toggle).not.toBeChecked();

    await user.click(toggle);
    expect(bridge.updateSettings).toHaveBeenLastCalledWith({ updateChecks: 'on' });
    await waitFor(() => expect(toggle).toBeChecked());
    await user.click(toggle);
    expect(bridge.updateSettings).toHaveBeenLastCalledWith({ updateChecks: 'off' });

    act(() => emitSettings({ updateChecks: 'on' }));
    expect(toggle).toBeChecked();
  });

  it('shows the running version, checks now and says it is up to date', async () => {
    const user = userEvent.setup();
    const { bridge } = renderSettings({}, 'updates');
    expect(screen.getByText('Kleos 0.5.0')).toBeInTheDocument();
    expect(await screen.findByText('Not checked yet')).toBeInTheDocument();

    bridge.checkForUpdates.mockResolvedValueOnce({
      ...idleUpdateState,
      status: 'current',
      checkedAt: new Date().toISOString(),
    });
    await user.click(screen.getByRole('button', { name: 'Check now' }));
    expect(bridge.checkForUpdates).toHaveBeenCalledTimes(1);
    expect(await screen.findByRole('status')).toHaveTextContent('Kleos is up to date');
    expect(screen.getByText(/^Last checked today at /)).toBeInTheDocument();
  });

  it('shows a newer release with its notes and downloads the DMG, else the release page', async () => {
    const user = userEvent.setup();
    const { bridge, emitUpdate } = renderSettings({ update: availableUpdateState }, 'updates');
    const found = await screen.findByRole('region', { name: 'Kleos 0.5.1 is available' });
    expect(within(found).getByRole('heading', { name: 'Corrigé' })).toBeInTheDocument();
    expect(within(found).getByText('statement_timeout').tagName).toBe('CODE');

    await user.click(within(found).getByRole('button', { name: 'Download' }));
    expect(bridge.openReleasePage).toHaveBeenLastCalledWith(release051.dmgUrl);

    act(() => emitUpdate({ ...availableUpdateState, latest: { ...release051, dmgUrl: null } }));
    await user.click(within(found).getByRole('button', { name: 'Download' }));
    expect(bridge.openReleasePage).toHaveBeenLastCalledWith(release051.url);
  });

  it('reports a failed check', async () => {
    const user = userEvent.setup();
    const { bridge } = renderSettings({}, 'updates');
    bridge.checkForUpdates.mockResolvedValueOnce({ ...idleUpdateState, status: 'error', error: 'GitHub answered 503' });
    await user.click(screen.getByRole('button', { name: 'Check now' }));
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('Couldn’t check for updates');
    expect(alert).toHaveTextContent('GitHub answered 503');

    bridge.checkForUpdates.mockRejectedValueOnce(new Error('bridge gone'));
    await user.click(screen.getByRole('button', { name: 'Check now' }));
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('bridge gone'));
  });

  it('formats the last check in plain words', () => {
    const now = new Date(2026, 10, 19, 15, 0);
    expect(formatCheckedAt(new Date(2026, 10, 19, 9, 5).toISOString(), now)).toMatch(/^today at /);
    expect(formatCheckedAt(new Date(2026, 10, 18, 22, 0).toISOString(), now)).toMatch(/^yesterday at /);
    expect(formatCheckedAt(new Date(2026, 10, 2, 8, 0).toISOString(), now)).toMatch(/^on .*2.* at /);
    expect(formatCheckedAt('nonsense', now)).toBeNull();
  });
});
