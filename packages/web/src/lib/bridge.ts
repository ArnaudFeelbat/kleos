import type { Settings, UpdateState } from '@kleos/shared';

/** Window commands sent by the main process from the native menu. */
export type ShellCommand =
  'new-tab' | 'close-tab' | 'next-tab' | 'prev-tab' | 'palette' | `select-tab-${1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9}`;

/** System follows macOS; Light and Dark override it. Remembered by the main process. */
export type Appearance = 'system' | 'light' | 'dark';

/** What the Electron preload exposes on window.kleos. */
export type KleosBridge = {
  /** http://127.0.0.1:<port> of the local server */
  apiBase: string;
  /** Random per-launch token sent as `Authorization: Bearer` */
  token: string;
  platform: string;
  /** True when the window has macOS vibrancy behind it: panes become translucent. */
  vibrancy: boolean;
  /** Updates the native window title. */
  setTitle(title: string): void;
  /** Closes the window (⌘W on the Connections tab). */
  closeWindow(): void;
  getAppearance(): Promise<Appearance>;
  /** Applies and remembers the appearance; the page follows through prefers-color-scheme. */
  setAppearance(mode: Appearance): void;
  /** Native save dialog for an export; resolves to the chosen absolute path, or null when cancelled. (0.4) */
  saveFileDialog(args: { defaultName: string; format: 'csv' | 'json' | 'xlsx' }): Promise<string | null>;
  /**
   * Native open dialog; null when cancelled. (0.4)
   * `csv` for an import, `key` for an SSH private key (starts in ~/.ssh), `cert` for a CA file.
   */
  openFileDialog(kind?: 'csv' | 'key' | 'cert'): Promise<string | null>;
  /** Shows the file in Finder. (0.4) */
  revealInFinder(path: string): void;
  /** Subscribes to menu commands; returns the unsubscribe function. */
  onCommand(listener: (command: ShellCommand) => void): () => void;

  // --- 0.5: settings and updates (owned by the main process) ---
  /** The running app's version, e.g. "0.5.0". */
  appVersion: string;
  /** Which page this window shows: the main window, or the Settings window (⌘,). */
  windowKind: 'main' | 'settings';
  getSettings(): Promise<Settings>;
  /** Merges, validates, saves and broadcasts; resolves to the settings now in force. */
  updateSettings(patch: Partial<Settings>): Promise<Settings>;
  /** Every window hears every change, including its own. */
  onSettingsChanged(listener: (settings: Settings) => void): () => void;
  /** Opens (or focuses) the Settings window. */
  openSettings(): void;
  getUpdateState(): Promise<UpdateState>;
  /** Checks GitHub Releases now, whatever Settings › updateChecks says (the user asked). */
  checkForUpdates(): Promise<UpdateState>;
  onUpdateState(listener: (state: UpdateState) => void): () => void;
  /** Opens a Kleos release page or DMG download in the default browser (only github.com/ArnaudFeelbat/kleos URLs). */
  openReleasePage(url: string): void;
};

declare global {
  interface Window {
    kleos?: KleosBridge;
  }
}

export function getBridge(): KleosBridge {
  if (!window.kleos) {
    throw new Error('Kleos bridge missing: the page must run inside the Kleos app window.');
  }
  return window.kleos;
}
