import type { ConnectionColor } from '@kleos/shared';

/** What the Electron preload exposes on window.kleos. */
export type KleosBridge = {
  /** http://127.0.0.1:<port> of the local server */
  apiBase: string;
  /** Random per-launch token sent as `Authorization: Bearer` */
  token: string;
  platform: string;
  /** Opens the workspace for an open session in its own window (one window per connection). */
  openWorkspace(args: { sid: string; title: string; color: ConnectionColor }): Promise<void>;
  /** Updates the native window title of the calling window. */
  setTitle(title: string): void;
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
