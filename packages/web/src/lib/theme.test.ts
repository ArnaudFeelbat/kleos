import { afterEach, describe, expect, it, vi } from 'vitest';
import { mockBridge } from '@/test/bridge-defaults';
import { followSystemTheme } from './theme';

/** A prefers-color-scheme query whose value the test sets, and which never fires `change`. */
function stubMedia(matches: boolean) {
  vi.stubGlobal(
    'matchMedia',
    vi.fn(() => ({ matches, addEventListener: vi.fn(), removeEventListener: vi.fn() })),
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
  delete window.kleos;
  document.documentElement.classList.remove('dark');
});

describe('followSystemTheme', () => {
  it('follows the system when the appearance is System', () => {
    stubMedia(true);
    const stop = followSystemTheme();
    expect(document.documentElement.classList.contains('dark')).toBe(true);
    stop();
  });

  it('applies Dark and Light from the settings even when the media query never reports the change', async () => {
    stubMedia(false);
    const { bridge, emitSettings } = mockBridge({ settings: { appearance: 'system' } });
    window.kleos = bridge;
    const stop = followSystemTheme();
    await Promise.resolve();
    expect(document.documentElement.classList.contains('dark')).toBe(false);

    emitSettings({ appearance: 'dark' });
    expect(document.documentElement.classList.contains('dark')).toBe(true);

    emitSettings({ appearance: 'light' });
    expect(document.documentElement.classList.contains('dark')).toBe(false);
    stop();
  });

  it('starts from the saved appearance', async () => {
    stubMedia(false);
    window.kleos = mockBridge({ settings: { appearance: 'dark' } }).bridge;
    const stop = followSystemTheme();
    await vi.waitFor(() => expect(document.documentElement.classList.contains('dark')).toBe(true));
    stop();
  });
});
