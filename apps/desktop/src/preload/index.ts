import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron';

function arg(name: string): string {
  const prefix = `--${name}=`;
  const found = process.argv.find((a) => a.startsWith(prefix));
  if (!found) throw new Error(`Missing ${prefix} argument`);
  return found.slice(prefix.length);
}

contextBridge.exposeInMainWorld('kleos', {
  apiBase: arg('kleos-api'),
  token: arg('kleos-token'),
  platform: process.platform,
  vibrancy: process.argv.includes('--kleos-vibrancy=1'),
  setTitle: (title: string) => ipcRenderer.send('kleos:set-title', title),
  closeWindow: () => ipcRenderer.send('kleos:close-window'),
  getAppearance: () => ipcRenderer.invoke('kleos:get-appearance'),
  setAppearance: (mode: string) => ipcRenderer.send('kleos:set-appearance', mode),
  onCommand: (listener: (command: string) => void) => {
    const handler = (_event: IpcRendererEvent, command: string) => listener(command);
    ipcRenderer.on('kleos:command', handler);
    return () => {
      ipcRenderer.removeListener('kleos:command', handler);
    };
  },
});
