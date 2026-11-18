import '@fontsource-variable/geist';
import '@fontsource-variable/geist-mono';
import './styles.css';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './app';
import { followSystemTheme } from './lib/theme';

followSystemTheme();
// With macOS vibrancy behind the window, the panes turn translucent (see styles.css).
if (window.kleos?.vibrancy) document.documentElement.classList.add('vibrancy');

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
