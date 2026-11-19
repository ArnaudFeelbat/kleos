import { randomBytes } from 'node:crypto';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { BrowserWindow, app, dialog, ipcMain, nativeTheme, shell } from 'electron';
import { startServer, type RunningServer } from '@kleos/server';
import { installMenu, type ShellCommand } from './menu';
import { isAppearance, loadPreferences, savePreferences, type Appearance } from './preferences';

const here = fileURLToPath(new URL('.', import.meta.url));
const rendererDevUrl = process.env['ELECTRON_RENDERER_URL'];
const isMac = process.platform === 'darwin';

app.setName('Kleos');
// Scripted runs (KLEOS_DATA_DIR) get a whole profile of their own, so they neither collide with
// nor quit because of the Kleos you have open (single-instance lock, caches, preferences).
if (process.env['KLEOS_DATA_DIR']) app.setPath('userData', process.env['KLEOS_DATA_DIR']);

let server: RunningServer | null = null;
/** One window; each connected server is a tab inside it. */
let mainWindow: BrowserWindow | null = null;
const token = randomBytes(32).toString('hex');
/** Set once a quit starts, so macOS `activate` cannot re-open a window and cancel it. */
let quitting = false;

function rendererUrl(): string {
  return rendererDevUrl ?? `${server!.url}/`;
}

function allowedOrigin(url: string): boolean {
  return new URL(url).origin === new URL(rendererUrl()).origin;
}

export function openMainWindow(): void {
  if (quitting) return;
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.focus();
    return;
  }
  const win = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 900,
    minHeight: 580,
    title: 'Kleos',
    show: false,
    titleBarStyle: 'hiddenInset',
    trafficLightPosition: { x: 16, y: 14 },
    // Native sidebar material behind the translucent panes; the content panels stay opaque.
    ...(isMac ? { vibrancy: 'sidebar' as const, visualEffectState: 'followWindow' as const } : {}),
    backgroundColor: isMac ? '#00000000' : '#ffffff',
    webPreferences: {
      preload: join(here, '../preload/index.cjs'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      additionalArguments: [
        `--kleos-api=${server!.url}`,
        `--kleos-token=${token}`,
        `--kleos-vibrancy=${isMac ? 1 : 0}`,
      ],
    },
  });
  win.once('ready-to-show', () => win.show());
  // Links open in the browser; the window never navigates away from Kleos.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//.test(url)) void shell.openExternal(url);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (event, url) => {
    if (!allowedOrigin(url)) event.preventDefault();
  });
  win.on('closed', () => {
    mainWindow = null;
    // Every tab's session belonged to this window.
    void server?.deps.sessions.closeAll();
  });
  void win.loadURL(rendererUrl());
  mainWindow = win;
}

function sendCommand(command: ShellCommand): void {
  const target = BrowserWindow.getFocusedWindow() ?? mainWindow;
  if (target && !target.isDestroyed()) target.webContents.send('kleos:command', command);
}

ipcMain.on('kleos:set-title', (event, title: unknown) => {
  if (typeof title !== 'string') return;
  BrowserWindow.fromWebContents(event.sender)?.setTitle(title);
});

ipcMain.on('kleos:close-window', (event) => {
  BrowserWindow.fromWebContents(event.sender)?.close();
});

// --- Appearance: System / Light / Dark, remembered between launches. -------------------
// KLEOS_DATA_DIR isolates scripted runs (scripts/ui-tour.mjs) from the real app data.
const dataDir = process.env['KLEOS_DATA_DIR'] ?? app.getPath('userData');
let appearance: Appearance = loadPreferences(dataDir).appearance;

function refreshMenu(): void {
  installMenu({ openMainWindow, sendCommand, appearance, setAppearance, toggleAppearance });
}

function setAppearance(mode: Appearance): void {
  appearance = mode;
  // The renderer follows prefers-color-scheme, which themeSource drives; vibrancy follows too.
  nativeTheme.themeSource = mode;
  savePreferences(dataDir, { appearance: mode });
  refreshMenu();
}

function toggleAppearance(): void {
  setAppearance(nativeTheme.shouldUseDarkColors ? 'light' : 'dark');
}

ipcMain.handle('kleos:get-appearance', () => appearance);

// --- Files: export and import pick paths through native dialogs; the server reads/writes them. ---
// KLEOS_FAKE_DIALOGS=<dir> (scripted UI tours only) answers every dialog with a path in <dir>
// instead of showing it: native sheets can't be driven over the DevTools protocol.
const fakeDialogDir = process.env.KLEOS_FAKE_DIALOGS || null;
const exportFilters: Record<string, Electron.FileFilter> = {
  csv: { name: 'CSV', extensions: ['csv'] },
  json: { name: 'JSON', extensions: ['json'] },
  xlsx: { name: 'Excel workbook', extensions: ['xlsx'] },
};

ipcMain.handle('kleos:save-dialog', async (event, args: { defaultName?: unknown; format?: unknown }) => {
  const format = typeof args?.format === 'string' && args.format in exportFilters ? args.format : 'csv';
  const name = typeof args?.defaultName === 'string' ? args.defaultName.replace(/[/\\:]/g, '-') : 'export';
  if (fakeDialogDir) return join(fakeDialogDir, `${name}.${format}`);
  const win = BrowserWindow.fromWebContents(event.sender);
  const options: Electron.SaveDialogOptions = {
    defaultPath: join(app.getPath('downloads'), `${name}.${format}`),
    filters: [exportFilters[format]!],
    properties: ['createDirectory', 'showOverwriteConfirmation'],
  };
  const result = win ? await dialog.showSaveDialog(win, options) : await dialog.showSaveDialog(options);
  return result.canceled || !result.filePath ? null : result.filePath;
});

const openKinds: Record<string, Pick<Electron.OpenDialogOptions, 'filters' | 'defaultPath' | 'title'>> = {
  csv: { title: 'Import a CSV file', filters: [{ name: 'CSV or TSV', extensions: ['csv', 'tsv', 'txt'] }] },
  // Private keys usually have no extension (id_ed25519); start in ~/.ssh, show hidden files.
  key: { title: 'Choose an SSH private key', defaultPath: join(app.getPath('home'), '.ssh') },
  cert: {
    title: 'Choose a CA certificate',
    filters: [
      { name: 'Certificates', extensions: ['pem', 'crt', 'cer'] },
      { name: 'All files', extensions: ['*'] },
    ],
  },
};

ipcMain.handle('kleos:open-dialog', async (event, kind: unknown) => {
  if (fakeDialogDir)
    return join(fakeDialogDir, kind === 'key' ? 'id_ed25519' : kind === 'cert' ? 'ca.pem' : 'import.csv');
  const win = BrowserWindow.fromWebContents(event.sender);
  const options: Electron.OpenDialogOptions = {
    properties: ['openFile', 'showHiddenFiles'],
    ...(openKinds[typeof kind === 'string' && kind in openKinds ? kind : 'csv'] ?? {}),
  };
  const result = win ? await dialog.showOpenDialog(win, options) : await dialog.showOpenDialog(options);
  return result.canceled ? null : (result.filePaths[0] ?? null);
});

ipcMain.on('kleos:reveal', (_event, path: unknown) => {
  if (fakeDialogDir) return;
  if (typeof path === 'string' && path.startsWith('/')) shell.showItemInFolder(path);
});
ipcMain.on('kleos:set-appearance', (_event, mode: unknown) => {
  if (isAppearance(mode)) setAppearance(mode);
});

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => openMainWindow());

  void app.whenReady().then(async () => {
    // Before any window exists, so the first paint is already in the chosen appearance.
    nativeTheme.themeSource = appearance;
    server = await startServer({
      token,
      dataDir,
      staticDir: rendererDevUrl ? undefined : join(here, '../renderer'),
      allowedOrigins: rendererDevUrl ? [new URL(rendererDevUrl).origin] : [],
      version: app.getVersion(),
    });
    refreshMenu();
    openMainWindow();

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) openMainWindow();
    });
  });

  // macOS convention: the app stays open with no windows.
  app.on('window-all-closed', () => {});

  // Ctrl-C in `pnpm dev` and `kill` should close sessions and quit like ⌘Q.
  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.on(signal, () => app.quit());
  }

  app.on('before-quit', () => {
    quitting = true;
  });
  // Windows are gone by now: close database sessions and the server, then exit.
  // Bounded, so a socket that never drains cannot keep Kleos running.
  let shuttingDown = false;
  app.on('will-quit', (event) => {
    if (!server) return;
    event.preventDefault();
    if (shuttingDown) return;
    shuttingDown = true;
    const timeout = new Promise((resolve) => setTimeout(resolve, 2000));
    void Promise.race([server.close(), timeout])
      .catch((err: unknown) => console.error('[kleos] shutdown failed', err))
      .finally(() => app.exit(0));
  });
}
