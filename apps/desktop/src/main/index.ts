import { randomBytes } from 'node:crypto';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { BrowserWindow, app, ipcMain, nativeTheme, shell } from 'electron';
import { startServer, type RunningServer } from '@kleos/server';
import { installMenu } from './menu';

const here = fileURLToPath(new URL('.', import.meta.url));
const rendererDevUrl = process.env['ELECTRON_RENDERER_URL'];

app.setName('Kleos');

let server: RunningServer | null = null;
let startWindow: BrowserWindow | null = null;
/** One window per open session. */
const workspaceWindows = new Map<string, BrowserWindow>();
const token = randomBytes(32).toString('hex');
/** Set once a quit starts, so macOS `activate` cannot re-open a window and cancel it. */
let quitting = false;

function rendererUrl(hash: string): string {
  const base = rendererDevUrl ?? `${server!.url}/`;
  return `${base}${hash}`;
}

function allowedOrigin(url: string): boolean {
  const origin = new URL(url).origin;
  return origin === new URL(rendererUrl('')).origin;
}

function createWindow(options: { width: number; height: number; title: string; hash: string }): BrowserWindow {
  const win = new BrowserWindow({
    width: options.width,
    height: options.height,
    minWidth: 820,
    minHeight: 560,
    title: options.title,
    show: false,
    titleBarStyle: 'hiddenInset',
    trafficLightPosition: { x: 14, y: 13 },
    backgroundColor: nativeTheme.shouldUseDarkColors ? '#09090b' : '#ffffff',
    webPreferences: {
      preload: join(here, '../preload/index.cjs'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      additionalArguments: [`--kleos-api=${server!.url}`, `--kleos-token=${token}`],
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
  void win.loadURL(rendererUrl(options.hash));
  return win;
}

export function openStartWindow(): void {
  if (quitting) return;
  if (startWindow && !startWindow.isDestroyed()) {
    startWindow.focus();
    return;
  }
  startWindow = createWindow({ width: 1100, height: 720, title: 'Kleos', hash: '#/' });
  startWindow.on('closed', () => {
    startWindow = null;
  });
}

function openWorkspaceWindow(args: { sid: string; title: string }): void {
  const existing = workspaceWindows.get(args.sid);
  if (existing && !existing.isDestroyed()) {
    existing.focus();
    return;
  }
  const win = createWindow({
    width: 1440,
    height: 900,
    title: args.title,
    hash: `#/w/${encodeURIComponent(args.sid)}`,
  });
  workspaceWindows.set(args.sid, win);
  win.on('closed', () => {
    workspaceWindows.delete(args.sid);
    void server?.closeSession(args.sid);
  });
}

ipcMain.handle('kleos:open-workspace', (_event, args: { sid: string; title: string; color: string }) => {
  if (typeof args?.sid !== 'string' || typeof args.title !== 'string') return;
  openWorkspaceWindow(args);
});

ipcMain.on('kleos:set-title', (event, title: unknown) => {
  if (typeof title !== 'string') return;
  BrowserWindow.fromWebContents(event.sender)?.setTitle(title);
});

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => openStartWindow());

  void app.whenReady().then(async () => {
    server = await startServer({
      token,
      // KLEOS_DATA_DIR isolates scripted runs (scripts/ui-tour.mjs) from the real app.db.
      dataDir: process.env['KLEOS_DATA_DIR'] ?? app.getPath('userData'),
      staticDir: rendererDevUrl ? undefined : join(here, '../renderer'),
      allowedOrigins: rendererDevUrl ? [new URL(rendererDevUrl).origin] : [],
      version: app.getVersion(),
    });
    installMenu({ openStartWindow });
    openStartWindow();

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) openStartWindow();
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
