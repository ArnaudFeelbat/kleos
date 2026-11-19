import '@fontsource-variable/geist';
import '@fontsource-variable/geist-mono';
import './styles.css';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './app';
import { SettingsWindow } from './features/settings/settings-window';
import { followSystemTheme } from './lib/theme';

followSystemTheme();
// With macOS vibrancy behind the window, the panes turn translucent (see styles.css).
if (window.kleos?.vibrancy) document.documentElement.classList.add('vibrancy');

// One page serves both windows; the preload says which one this is.
createRoot(document.getElementById('root')!).render(
  <StrictMode>{window.kleos?.windowKind === 'settings' ? <SettingsWindow /> : <App />}</StrictMode>,
);
