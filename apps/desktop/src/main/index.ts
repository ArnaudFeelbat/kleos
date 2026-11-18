import { randomBytes } from 'node:crypto';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { BrowserWindow, app, ipcMain, shell } from 'electron';
import { startServer, type RunningServer } from '@kleos/server';
import { installMenu, type ShellCommand } from './menu';

const here = fileURLToPath(new URL('.', import.meta.url));
const rendererDevUrl = process.env['ELECTRON_RENDERER_URL'];
const isMac = process.platform === 'darwin';

app.setName('Kleos');

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

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => openMainWindow());

  void app.whenReady().then(async () => {
    server = await startServer({
      token,
      // KLEOS_DATA_DIR isolates scripted runs (scripts/ui-tour.mjs) from the real app.db.
      dataDir: process.env['KLEOS_DATA_DIR'] ?? app.getPath('userData'),
      staticDir: rendererDevUrl ? undefined : join(here, '../renderer'),
      allowedOrigins: rendererDevUrl ? [new URL(rendererDevUrl).origin] : [],
      version: app.getVersion(),
    });
    installMenu({ openMainWindow, sendCommand });
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
