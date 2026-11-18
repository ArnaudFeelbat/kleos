import { contextBridge, ipcRenderer } from 'electron';

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
  openWorkspace: (args: { sid: string; title: string; color: string }) =>
    ipcRenderer.invoke('kleos:open-workspace', args),
  setTitle: (title: string) => ipcRenderer.send('kleos:set-title', title),
});
