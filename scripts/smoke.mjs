// Launches the built app (apps/desktop/out) with remote debugging, evaluates an
// expression in the first Kleos window until it returns a truthy value, prints it,
// and quits the app. Usage:
//   node scripts/smoke.mjs ["<js expression>"] [timeoutMs]
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const electron = require('electron');
const appDir = fileURLToPath(new URL('../apps/desktop', import.meta.url));
const expression =
  process.argv[2] ??
  "document.querySelector('[data-testid=health]')?.textContent?.match(/Server ok/) ? document.querySelector('[data-testid=health]').textContent : ''";
const timeoutMs = Number(process.argv[3] ?? 20000);
const port = 9300 + Math.floor(Math.random() * 500);

// Detached stdio so a lingering app never holds the caller's pipe open.
const child = spawn(electron, [appDir, `--remote-debugging-port=${port}`], {
  stdio: ['ignore', 'ignore', process.env.SMOKE_VERBOSE ? 'inherit' : 'ignore'],
  env: { ...process.env, ELECTRON_ENABLE_LOGGING: '0' },
});
let exited = false;
child.on('exit', () => {
  exited = true;
});

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const deadline = Date.now() + timeoutMs;

async function findPage() {
  while (Date.now() < deadline) {
    try {
      const pages = await (await fetch(`http://127.0.0.1:${port}/json`)).json();
      const page = pages.find((p) => p.type === 'page' && p.webSocketDebuggerUrl);
      if (page) return page;
    } catch {
      // Debug port not open yet; retry.
    }
    await sleep(300);
  }
  throw new Error('No Kleos window appeared');
}

async function evaluate(wsUrl) {
  const ws = new WebSocket(wsUrl);
  await new Promise((resolve, reject) => {
    ws.onopen = resolve;
    ws.onerror = reject;
  });
  let id = 0;
  const call = (method, params) =>
    new Promise((resolve) => {
      const msgId = ++id;
      const onMessage = (event) => {
        const msg = JSON.parse(event.data);
        if (msg.id === msgId) {
          ws.removeEventListener('message', onMessage);
          resolve(msg.result);
        }
      };
      ws.addEventListener('message', onMessage);
      ws.send(JSON.stringify({ id: msgId, method, params }));
    });
  while (Date.now() < deadline) {
    const result = await call('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    const value = result?.result?.value;
    if (value) {
      ws.close();
      return value;
    }
    await sleep(300);
  }
  ws.close();
  throw new Error(`Expression stayed falsy for ${timeoutMs} ms: ${expression}`);
}

let code = 0;
try {
  const page = await findPage();
  const value = await evaluate(page.webSocketDebuggerUrl);
  console.log('SMOKE OK:', typeof value === 'string' ? value : JSON.stringify(value));
} catch (err) {
  console.error('SMOKE FAILED:', err.message);
  code = 1;
} finally {
  child.kill('SIGTERM');
  for (let i = 0; i < 20 && !exited; i += 1) await sleep(250);
  if (!exited) {
    console.error('SMOKE: app did not quit within 5 s of SIGTERM; killing it');
    child.kill('SIGKILL');
    code = 1;
  }
}
process.exit(code);
