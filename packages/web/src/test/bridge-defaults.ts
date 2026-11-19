import { defaultSettings, type Settings, type UpdateInfo, type UpdateState } from '@kleos/shared';
import { vi } from 'vitest';
import type { KleosBridge } from '@/lib/bridge';

/** The update state a bridge mock answers with: no check made yet. */
export const idleUpdateState: UpdateState = {
  current: '0.5.0',
  status: 'idle',
  latest: null,
  checkedAt: null,
  error: null,
};

/** A newer release, as the main process reports it after a check. */
export const release051: UpdateInfo = {
  version: '0.5.1',
  url: 'https://github.com/ArnaudFeelbat/kleos/releases/tag/v0.5.1',
  notes: '### Corrigé\n- **Données** : la pagination suit les réglages.\n- `statement_timeout` respecté',
  publishedAt: '2026-11-20T09:00:00Z',
  dmgUrl: 'https://github.com/ArnaudFeelbat/kleos/releases/download/v0.5.1/Kleos-0.5.1-arm64.dmg',
};

export const availableUpdateState: UpdateState = {
  current: '0.5.0',
  status: 'available',
  latest: release051,
  checkedAt: '2026-11-19T08:30:00Z',
  error: null,
};

/**
 * A full 0.5 bridge that behaves like the main process for settings and updates: updateSettings
 * merges, answers and broadcasts to every onSettingsChanged listener; `emitSettings` and
 * `emitUpdate` stand for changes made elsewhere (another window, the View menu, a daily check).
 */
export function mockBridge(
  options: { settings?: Partial<Settings>; update?: UpdateState; windowKind?: KleosBridge['windowKind'] } = {},
) {
  let settings: Settings = { ...defaultSettings, ...options.settings };
  let update: UpdateState = options.update ?? idleUpdateState;
  const settingsListeners = new Set<(s: Settings) => void>();
  const updateListeners = new Set<(s: UpdateState) => void>();

  const emitSettings = (patch: Partial<Settings>) => {
    settings = { ...settings, ...patch };
    for (const l of settingsListeners) l(settings);
  };
  const emitUpdate = (state: UpdateState) => {
    update = state;
    for (const l of updateListeners) l(update);
  };

  const bridge = {
    apiBase: '',
    token: '',
    platform: 'darwin',
    vibrancy: false,
    setTitle: vi.fn(),
    closeWindow: vi.fn(),
    getAppearance: vi.fn(async () => settings.appearance),
    setAppearance: vi.fn(),
    saveFileDialog: vi.fn(async () => null),
    openFileDialog: vi.fn<KleosBridge['openFileDialog']>(async () => null),
    revealInFinder: vi.fn(),
    onCommand: vi.fn<KleosBridge['onCommand']>(() => () => {}),
    appVersion: '0.5.0',
    windowKind: options.windowKind ?? 'main',
    getSettings: vi.fn(async () => settings),
    updateSettings: vi.fn(async (patch: Partial<Settings>) => {
      emitSettings(patch);
      return settings;
    }),
    onSettingsChanged: vi.fn((listener: (s: Settings) => void) => {
      settingsListeners.add(listener);
      return () => void settingsListeners.delete(listener);
    }),
    openSettings: vi.fn(),
    getUpdateState: vi.fn(async () => update),
    checkForUpdates: vi.fn<KleosBridge['checkForUpdates']>(async () => update),
    onUpdateState: vi.fn((listener: (s: UpdateState) => void) => {
      updateListeners.add(listener);
      return () => void updateListeners.delete(listener);
    }),
    openReleasePage: vi.fn(),
  } satisfies KleosBridge;

  return { bridge, emitSettings, emitUpdate, settings: () => settings };
}
