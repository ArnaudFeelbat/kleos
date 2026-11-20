import { randomBytes } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { BrowserWindow, app, dialog, ipcMain, nativeTheme, net, shell } from 'electron';
import { kleosReleaseUrl } from '@kleos/shared';
import { startServer, type RunningServer } from '@kleos/server';
import { installMenu, type ShellCommand } from './menu';
import { isAppearance, openSettingsStore, type Appearance } from './preferences';
import { createUpdateChecker, latestReleaseUrl } from './updates';

const here = fileURLToPath(new URL('.', import.meta.url));
const rendererDevUrl = process.env['ELECTRON_RENDERER_URL'];
const isMac = process.platform === 'darwin';

app.setName('Kleos');
// Scripted runs (KLEOS_DATA_DIR) get a whole profile of their own, so they neither collide with
// nor quit because of the Kleos you have open (single-instance lock, caches, preferences).
if (process.env['KLEOS_DATA_DIR']) app.setPath('userData', process.env['KLEOS_DATA_DIR']);

let server: RunningServer | null = null;
/** One main window; each connected server is a tab inside it. */
let mainWindow: BrowserWindow | null = null;
/** At most one Settings window (⌘,). */
let settingsWindow: BrowserWindow | null = null;
const token = randomBytes(32).toString('hex');
/** Set once a quit starts, so macOS `activate` cannot re-open a window and cancel it. */
let quitting = false;

type WindowKind = 'main' | 'settings';

function rendererUrl(): string {
  return rendererDevUrl ?? `${server!.url}/`;
}

function allowedOrigin(url: string): boolean {
  return new URL(url).origin === new URL(rendererUrl()).origin;
}

/** Both windows run the same renderer bundle and preload; `--kleos-window` tells them apart. */
function webPreferences(kind: WindowKind): Electron.WebPreferences {
  return {
    preload: join(here, '../preload/index.cjs'),
    contextIsolation: true,
    sandbox: true,
    nodeIntegration: false,
    additionalArguments: [
      `--kleos-api=${server!.url}`,
      `--kleos-token=${token}`,
      `--kleos-vibrancy=${isMac ? 1 : 0}`,
      `--kleos-window=${kind}`,
      `--kleos-version=${app.getVersion()}`,
    ],
  };
}

/** Native sidebar material behind the translucent panes; the content panels stay opaque. */
const vibrancy: Partial<Electron.BrowserWindowConstructorOptions> = isMac
  ? { vibrancy: 'sidebar', visualEffectState: 'followWindow', backgroundColor: '#00000000' }
  : { backgroundColor: '#ffffff' };

/** Links open in the browser; a window never navigates away from Kleos. */
function keepInsideKleos(win: BrowserWindow): void {
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//.test(url)) void shell.openExternal(url);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (event, url) => {
    if (!allowedOrigin(url)) event.preventDefault();
  });
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
    ...vibrancy,
    webPreferences: webPreferences('main'),
  });
  win.once('ready-to-show', () => win.show());
  keepInsideKleos(win);
  win.on('closed', () => {
    mainWindow = null;
    // Every tab's session belonged to this window.
    void server?.deps.sessions.closeAll();
  });
  void win.loadURL(rendererUrl());
  mainWindow = win;
}

/**
 * Opens the Settings window, or brings the open one forward. `pane` (the page reads it from the
 * URL hash, `#updates`) picks the pane it shows; without one an open window keeps its pane.
 */
function openSettingsWindow(pane?: 'updates'): void {
  if (quitting || !server) return;
  if (settingsWindow && !settingsWindow.isDestroyed()) {
    // A hash change, not a reload: the page follows it through `hashchange`.
    if (pane) void settingsWindow.webContents.executeJavaScript(`location.hash = '${pane}'`);
    settingsWindow.show();
    settingsWindow.focus();
    return;
  }
  const win = new BrowserWindow({
    width: 600,
    height: 480,
    resizable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    title: 'Settings',
    show: false,
    // The page draws the title row and pane toolbar itself, beside the traffic lights.
    titleBarStyle: 'hidden',
    trafficLightPosition: { x: 14, y: 12 },
    ...vibrancy,
    webPreferences: webPreferences('settings'),
  });
  // The page names the window after its pane (setTitle); its <title> must not replace that.
  win.on('page-title-updated', (event) => event.preventDefault());
  win.once('ready-to-show', () => win.show());
  keepInsideKleos(win);
  win.on('closed', () => {
    settingsWindow = null;
  });
  const url = new URL(rendererUrl());
  if (pane) url.hash = pane;
  void win.loadURL(url.href);
  settingsWindow = win;
}

/**
 * Menu commands belong to the main window's tab strip. With Settings in front, ⌘W closes it
 * and ⌘T still reaches the main window (the menu has just opened or focused it); the rest
 * would act on a window the user is not looking at, so they wait.
 */
function sendCommand(command: ShellCommand): void {
  const focused = BrowserWindow.getFocusedWindow();
  if (focused && focused === settingsWindow) {
    if (command === 'close-tab') focused.close();
    if (command !== 'new-tab') return;
  }
  const target = mainWindow ?? focused;
  if (target && !target.isDestroyed()) target.webContents.send('kleos:command', command);
}

/** Every open window hears settings and update changes, including the one that caused them. */
function broadcast(channel: string, payload: unknown): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) win.webContents.send(channel, payload);
  }
}

ipcMain.on('kleos:set-title', (event, title: unknown) => {
  if (typeof title !== 'string') return;
  BrowserWindow.fromWebContents(event.sender)?.setTitle(title);
});

ipcMain.on('kleos:close-window', (event) => {
  BrowserWindow.fromWebContents(event.sender)?.close();
});

// --- Settings (0.5): appearance, page size, query timeout, update checks; preferences.json. ---
// KLEOS_DATA_DIR isolates scripted runs (scripts/ui-tour.mjs) from the real app data.
const dataDir = process.env['KLEOS_DATA_DIR'] ?? app.getPath('userData');
const settings = openSettingsStore(dataDir);

function refreshMenu(): void {
  installMenu({
    openMainWindow,
    sendCommand,
    appearance: settings.get().appearance,
    setAppearance,
    toggleAppearance,
    openSettings: () => openSettingsWindow(),
    checkForUpdates: () => {
      openSettingsWindow('updates');
      void updates.check();
    },
  });
}

/** The View › Appearance radios, ⌘⇧L and the bridge's setAppearance all go through the store. */
function setAppearance(mode: Appearance): void {
  settings.update({ appearance: mode });
}

function toggleAppearance(): void {
  setAppearance(nativeTheme.shouldUseDarkColors ? 'light' : 'dark');
}

settings.onChange((next, previous) => {
  if (next.appearance !== previous.appearance) {
    // The renderer follows prefers-color-scheme, which themeSource drives; vibrancy follows too.
    nativeTheme.themeSource = next.appearance;
    refreshMenu();
  }
  // Turning checks on checks within a few seconds; ask/off cancel the timers.
  if (next.updateChecks !== previous.updateChecks) updates.schedule(next.updateChecks, 3_000);
  broadcast('kleos:settings-changed', next);
});

ipcMain.handle('kleos:get-settings', () => settings.get());
// An invalid patch throws, which rejects the renderer's invoke; nothing is saved.
ipcMain.handle('kleos:update-settings', (_event, patch: unknown) => settings.update(patch));
ipcMain.on('kleos:open-settings', (_event, pane: unknown) => openSettingsWindow(pane === 'updates' ? pane : undefined));

ipcMain.handle('kleos:get-appearance', () => settings.get().appearance);
ipcMain.on('kleos:set-appearance', (_event, mode: unknown) => {
  if (isAppearance(mode)) setAppearance(mode);
});

// --- Updates (0.5): GitHub's latest release, only when allowed or asked. -----------------
// KLEOS_UPDATE_URL=<url> (scripted UI tours only) reads the "latest release" JSON from a local
// mock instead of api.github.com.
const updates = createUpdateChecker({
  currentVersion: app.getVersion(),
  url: process.env['KLEOS_UPDATE_URL'] || latestReleaseUrl,
  fetch: (url, init) => net.fetch(url, init),
  onState: (state) => broadcast('kleos:update-state', state),
});

ipcMain.handle('kleos:get-update-state', () => updates.state());
ipcMain.handle('kleos:check-updates', () => updates.check());
ipcMain.on('kleos:open-release', (_event, url: unknown) => {
  // Release pages and DMG downloads only; anything else a page asks to open is ignored.
  const href = kleosReleaseUrl(url);
  if (href) void shell.openExternal(href);
});

// --- Files: export and import pick paths through native dialogs; the server reads/writes them. ---
// KLEOS_FAKE_DIALOGS=<dir> (scripted UI tours only) answers every dialog with a path in <dir>
// instead of showing it: native sheets can't be driven over the DevTools protocol.
const fakeDialogDir = process.env.KLEOS_FAKE_DIALOGS || null;
const exportFilters: Record<string, Electron.FileFilter> = {
  csv: { name: 'CSV', extensions: ['csv'] },
  json: { name: 'JSON', extensions: ['json'] },
  xlsx: { name: 'Excel workbook', extensions: ['xlsx'] },
  png: { name: 'PNG image', extensions: ['png'] },
  svg: { name: 'SVG image', extensions: ['svg'] },
};

/**
 * The last path the save dialog returned to each window (webContents id). `kleos:write-file`
 * writes only there, once: the renderer can't pick a path on its own, only fill the file the
 * user just chose.
 */
const pickedPaths = new Map<number, string>();
const forgetsOnClose = new WeakSet<Electron.WebContents>();

function rememberPick(sender: Electron.WebContents, path: string | null): string | null {
  if (!forgetsOnClose.has(sender)) {
    forgetsOnClose.add(sender);
    const id = sender.id;
    sender.once('destroyed', () => pickedPaths.delete(id));
  }
  if (path) pickedPaths.set(sender.id, path);
  else pickedPaths.delete(sender.id);
  return path;
}

ipcMain.handle('kleos:save-dialog', async (event, args: { defaultName?: unknown; format?: unknown }) => {
  const format = typeof args?.format === 'string' && args.format in exportFilters ? args.format : 'csv';
  const name = typeof args?.defaultName === 'string' ? args.defaultName.replace(/[/\\:]/g, '-') : 'export';
  if (fakeDialogDir) return rememberPick(event.sender, join(fakeDialogDir, `${name}.${format}`));
  const win = BrowserWindow.fromWebContents(event.sender);
  const options: Electron.SaveDialogOptions = {
    defaultPath: join(app.getPath('downloads'), `${name}.${format}`),
    filters: [exportFilters[format]!],
    properties: ['createDirectory', 'showOverwriteConfirmation'],
  };
  const result = win ? await dialog.showSaveDialog(win, options) : await dialog.showSaveDialog(options);
  return rememberPick(event.sender, result.canceled || !result.filePath ? null : result.filePath);
});

// Files the renderer produces itself (diagram exports). Strings are written as UTF-8, bytes as is.
ipcMain.handle('kleos:write-file', async (event, path: unknown, data: unknown) => {
  let bytes: string | Uint8Array;
  if (typeof data === 'string' || data instanceof Uint8Array) bytes = data;
  else if (data instanceof ArrayBuffer) bytes = new Uint8Array(data);
  else throw new Error('Kleos can only write text or bytes to a file.');
  if (typeof path !== 'string' || pickedPaths.get(event.sender.id) !== path) {
    throw new Error('Only the file just picked in the save dialog can be written.');
  }
  pickedPaths.delete(event.sender.id);
  await writeFile(path, bytes, typeof bytes === 'string' ? 'utf8' : undefined);
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

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => openMainWindow());

  void app.whenReady().then(async () => {
    // Before any window exists, so the first paint is already in the chosen appearance.
    nativeTheme.themeSource = settings.get().appearance;
    server = await startServer({
      token,
      dataDir,
      staticDir: rendererDevUrl ? undefined : join(here, '../renderer'),
      allowedOrigins: rendererDevUrl ? [new URL(rendererDevUrl).origin] : [],
      version: app.getVersion(),
    });
    refreshMenu();
    openMainWindow();
    // Nothing leaves the Mac unless update checks are on; then the first check waits for launch to settle.
    updates.schedule(settings.get().updateChecks, 10_000);

    // A click on the Dock icon brings the main window back, even with only Settings open.
    app.on('activate', () => {
      if (!mainWindow) openMainWindow();
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
    updates.dispose();
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
