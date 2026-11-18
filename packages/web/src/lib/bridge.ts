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
  /** Subscribes to menu commands; returns the unsubscribe function. */
  onCommand(listener: (command: ShellCommand) => void): () => void;
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
