// Runs a Node script with Electron's bundled Node (ELECTRON_RUN_AS_NODE=1).
// better-sqlite3 is rebuilt for Electron's ABI at install time, so server tests
// must load it under the same runtime the app uses.
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const electronBinary = require('electron');

const child = spawn(electronBinary, process.argv.slice(2), {
  stdio: 'inherit',
  env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
});
child.on('exit', (code, signal) => {
  if (signal) process.kill(process.pid, signal);
  else process.exit(code ?? 1);
});
