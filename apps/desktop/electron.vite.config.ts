import { resolve } from 'node:path';
import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'electron-vite';

const webRoot = resolve(__dirname, '../../packages/web');

export default defineConfig({
  main: {
    build: {
      // This package's `dependencies` stay outside the bundle and ship in node_modules: the
      // two native modules, ssh2 (optional native crypto, loaded through try/require) and
      // exceljs (large CommonJS tree). pg, hono, zod, csv-parse and the workspace packages
      // are bundled.
      externalizeDeps: { include: ['better-sqlite3', '@napi-rs/keyring', 'ssh2', 'exceljs'] },
      rollupOptions: {
        input: { index: resolve(__dirname, 'src/main/index.ts') },
        external: ['pg-native', 'better-sqlite3', '@napi-rs/keyring', 'ssh2', 'exceljs'],
      },
    },
  },
  preload: {
    build: {
      rollupOptions: {
        input: { index: resolve(__dirname, 'src/preload/index.ts') },
        // Sandboxed preloads must be CommonJS.
        output: { format: 'cjs', entryFileNames: '[name].cjs' },
      },
    },
  },
  renderer: {
    root: webRoot,
    plugins: [react(), tailwindcss()],
    resolve: { alias: { '@': resolve(webRoot, 'src') } },
    build: {
      outDir: resolve(__dirname, 'out/renderer'),
      rollupOptions: { input: resolve(webRoot, 'index.html') },
    },
  },
});
