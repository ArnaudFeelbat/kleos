import { Menu, app, shell, type MenuItemConstructorOptions } from 'electron';
import type { Appearance } from './preferences';

/** Window commands handled by the renderer's tab strip. */
export type ShellCommand =
  'new-tab' | 'close-tab' | 'next-tab' | 'prev-tab' | 'palette' | `select-tab-${1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9}`;

export type MenuActions = {
  openMainWindow: () => void;
  sendCommand: (c: ShellCommand) => void;
  appearance: Appearance;
  setAppearance: (mode: Appearance) => void;
  toggleAppearance: () => void;
};

/**
 * Native macOS menu bar. Tab and palette commands are forwarded to the focused window;
 * call again after the appearance changes so the radio items show the current mode.
 */
export function installMenu(actions: MenuActions): void {
  const appearanceItem = (mode: Appearance, label: string): MenuItemConstructorOptions => ({
    label,
    type: 'radio',
    checked: actions.appearance === mode,
    click: () => actions.setAppearance(mode),
  });
  const tab = (n: 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9): MenuItemConstructorOptions => ({
    label: n === 9 ? 'Last Tab' : `Tab ${n}`,
    accelerator: `CmdOrCtrl+${n}`,
    click: () => actions.sendCommand(`select-tab-${n}`),
  });
  const template: MenuItemConstructorOptions[] = [
    {
      label: app.name,
      submenu: [
        { role: 'about' },
        { type: 'separator' },
        { role: 'services' },
        { type: 'separator' },
        { role: 'hide' },
        { role: 'hideOthers' },
        { role: 'unhide' },
        { type: 'separator' },
        { role: 'quit' },
      ],
    },
    {
      label: 'File',
      submenu: [
        {
          label: 'New Connection Tab',
          accelerator: 'CmdOrCtrl+T',
          click: () => {
            actions.openMainWindow();
            actions.sendCommand('new-tab');
          },
        },
        { type: 'separator' },
        { label: 'Close Tab', accelerator: 'CmdOrCtrl+W', click: () => actions.sendCommand('close-tab') },
        { label: 'Close Window', accelerator: 'CmdOrCtrl+Shift+W', role: 'close' },
      ],
    },
    { role: 'editMenu' },
    {
      label: 'View',
      submenu: [
        { label: 'Command Palette…', accelerator: 'CmdOrCtrl+K', click: () => actions.sendCommand('palette') },
        { type: 'separator' },
        {
          label: 'Appearance',
          submenu: [
            appearanceItem('system', 'Use System Setting'),
            appearanceItem('light', 'Light'),
            appearanceItem('dark', 'Dark'),
            { type: 'separator' },
            { label: 'Toggle Light / Dark', accelerator: 'CmdOrCtrl+Shift+L', click: () => actions.toggleAppearance() },
          ],
        },
        { type: 'separator' },
        { role: 'reload' },
        { role: 'toggleDevTools' },
        { type: 'separator' },
        { role: 'resetZoom' },
        { role: 'zoomIn' },
        { role: 'zoomOut' },
        { type: 'separator' },
        { role: 'togglefullscreen' },
      ],
    },
    {
      label: 'Window',
      submenu: [
        { role: 'minimize' },
        { role: 'zoom' },
        { type: 'separator' },
        { label: 'Show Next Tab', accelerator: 'CmdOrCtrl+Shift+]', click: () => actions.sendCommand('next-tab') },
        { label: 'Show Previous Tab', accelerator: 'CmdOrCtrl+Shift+[', click: () => actions.sendCommand('prev-tab') },
        { type: 'separator' },
        tab(1),
        tab(2),
        tab(3),
        tab(4),
        tab(5),
        tab(6),
        tab(7),
        tab(8),
        tab(9),
        { type: 'separator' },
        { role: 'front' },
      ],
    },
    {
      role: 'help',
      submenu: [
        {
          label: 'PostgreSQL Documentation',
          click: () => void shell.openExternal('https://www.postgresql.org/docs/current/'),
        },
      ],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}
