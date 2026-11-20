import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron';
import type { Settings, UpdateState } from '@kleos/shared';

function arg(name: string): string {
  const prefix = `--${name}=`;
  const found = process.argv.find((a) => a.startsWith(prefix));
  if (!found) throw new Error(`Missing ${prefix} argument`);
  return found.slice(prefix.length);
}

function optionalArg(name: string): string | null {
  const prefix = `--${name}=`;
  return process.argv.find((a) => a.startsWith(prefix))?.slice(prefix.length) ?? null;
}

/** Subscribes to a main-process broadcast; returns the unsubscribe function. */
function subscribe<T>(channel: string, listener: (payload: T) => void): () => void {
  const handler = (_event: IpcRendererEvent, payload: T) => listener(payload);
  ipcRenderer.on(channel, handler);
  return () => {
    ipcRenderer.removeListener(channel, handler);
  };
}

// The shape is KleosBridge in packages/web/src/lib/bridge.ts.
contextBridge.exposeInMainWorld('kleos', {
  apiBase: arg('kleos-api'),
  token: arg('kleos-token'),
  platform: process.platform,
  vibrancy: process.argv.includes('--kleos-vibrancy=1'),
  setTitle: (title: string) => ipcRenderer.send('kleos:set-title', title),
  closeWindow: () => ipcRenderer.send('kleos:close-window'),
  getAppearance: () => ipcRenderer.invoke('kleos:get-appearance'),
  setAppearance: (mode: string) => ipcRenderer.send('kleos:set-appearance', mode),
  saveFileDialog: (args: { defaultName: string; format: string }) => ipcRenderer.invoke('kleos:save-dialog', args),
  // 0.6: the main process writes only the path the save dialog just returned to this window.
  writeFile: (path: string, data: string | Uint8Array): Promise<void> =>
    ipcRenderer.invoke('kleos:write-file', path, data),
  openFileDialog: (kind: string = 'csv') => ipcRenderer.invoke('kleos:open-dialog', kind),
  revealInFinder: (path: string) => ipcRenderer.send('kleos:reveal', path),
  onCommand: (listener: (command: string) => void) => subscribe('kleos:command', listener),

  // 0.5: settings and updates, owned by the main process.
  appVersion: optionalArg('kleos-version') ?? '0.0.0',
  windowKind: optionalArg('kleos-window') === 'settings' ? 'settings' : 'main',
  getSettings: (): Promise<Settings> => ipcRenderer.invoke('kleos:get-settings'),
  updateSettings: (patch: Partial<Settings>): Promise<Settings> => ipcRenderer.invoke('kleos:update-settings', patch),
  onSettingsChanged: (listener: (settings: Settings) => void) => subscribe('kleos:settings-changed', listener),
  // An optional 'updates' opens Settings on that pane (beyond the bridge type, for W to adopt).
  openSettings: (pane?: 'updates') => ipcRenderer.send('kleos:open-settings', pane),
  getUpdateState: (): Promise<UpdateState> => ipcRenderer.invoke('kleos:get-update-state'),
  checkForUpdates: (): Promise<UpdateState> => ipcRenderer.invoke('kleos:check-updates'),
  onUpdateState: (listener: (state: UpdateState) => void) => subscribe('kleos:update-state', listener),
  openReleasePage: (url: string) => ipcRenderer.send('kleos:open-release', url),
});
