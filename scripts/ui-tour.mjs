// Drives the BUILT app (apps/desktop/out) through a real session against a Postgres you
// provide, with real mouse/keyboard events over the Chrome DevTools Protocol, and saves a
// screenshot per step. Isolated from your real app data via KLEOS_DATA_DIR.
//
//   node scripts/ui-tour.mjs '<pg json>' <screenshot dir>
//   pg json: {"host":"127.0.0.1","port":55432,"user":"kleos","password":"…","database":"shop","schema":"shop","table":"orders"}
import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const electron = require('electron');
const pgInfo = JSON.parse(process.argv[2] ?? '{}');
const shotDir = process.argv[3] ?? join(tmpdir(), 'kleos-tour');
mkdirSync(shotDir, { recursive: true });
const dataDir = mkdtempSync(join(tmpdir(), 'kleos-tour-data-'));
const appDir = fileURLToPath(new URL('../apps/desktop', import.meta.url));
const port = 9300 + Math.floor(Math.random() * 500);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const child = spawn(electron, [appDir, `--remote-debugging-port=${port}`], {
  stdio: ['ignore', 'ignore', process.env.TOUR_VERBOSE ? 'inherit' : 'ignore'],
  env: { ...process.env, KLEOS_DATA_DIR: dataDir },
});

async function pages() {
  try {
    return await (await fetch(`http://127.0.0.1:${port}/json`)).json();
  } catch {
    return [];
  }
}

async function attach(match, timeoutMs = 20000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const page = (await pages()).find((p) => p.type === 'page' && p.webSocketDebuggerUrl && match(p.url));
    if (page) return connect(page.webSocketDebuggerUrl);
    await sleep(250);
  }
  throw new Error('page not found');
}

async function connect(wsUrl) {
  const ws = new WebSocket(wsUrl);
  await new Promise((resolve, reject) => {
    ws.onopen = resolve;
    ws.onerror = reject;
  });
  let id = 0;
  const call = (method, params = {}) =>
    new Promise((resolve, reject) => {
      const msgId = ++id;
      ws.addEventListener('message', function onMessage(event) {
        const msg = JSON.parse(event.data);
        if (msg.id !== msgId) return;
        ws.removeEventListener('message', onMessage);
        if (msg.error) reject(new Error(`${method}: ${msg.error.message}`));
        else resolve(msg.result);
      });
      ws.send(JSON.stringify({ id: msgId, method, params }));
    });
  const evaluate = async (expression) => {
    const r = await call('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    if (r.exceptionDetails) throw new Error(`eval failed: ${r.exceptionDetails.exception?.description ?? expression}`);
    return r.result?.value;
  };
  const waitFor = async (expression, label, timeoutMs = 15000) => {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const v = await evaluate(expression).catch(() => null);
      if (v) return v;
      await sleep(200);
    }
    throw new Error(`timed out waiting for ${label}`);
  };
  /** Clicks the centre of the element an expression returns, with real mouse events. */
  const click = async (elementExpr, label, clickCount = 1) => {
    const rect = await waitFor(
      `(() => { const el = ${elementExpr}; if (!el) return null; el.scrollIntoView({block:'center', inline:'center'}); const r = el.getBoundingClientRect(); return r.width && r.height ? { x: r.x + r.width / 2, y: r.y + r.height / 2 } : null; })()`,
      label,
    );
    for (let n = 1; n <= clickCount; n += 1) {
      await call('Input.dispatchMouseEvent', { type: 'mouseMoved', x: rect.x, y: rect.y });
      await call('Input.dispatchMouseEvent', {
        type: 'mousePressed',
        x: rect.x,
        y: rect.y,
        button: 'left',
        clickCount: n,
      });
      await call('Input.dispatchMouseEvent', {
        type: 'mouseReleased',
        x: rect.x,
        y: rect.y,
        button: 'left',
        clickCount: n,
      });
    }
  };
  const key = async (keyName, code, keyCode, modifiers = 0) => {
    // A plain Enter needs its text so it produces the keypress that submits forms.
    const text = keyName === 'Enter' && modifiers === 0 ? '\r' : undefined;
    await call('Input.dispatchKeyEvent', {
      type: 'keyDown',
      key: keyName,
      code,
      windowsVirtualKeyCode: keyCode,
      modifiers,
      ...(text ? { text } : {}),
    });
    await call('Input.dispatchKeyEvent', {
      type: 'keyUp',
      key: keyName,
      code,
      windowsVirtualKeyCode: keyCode,
      modifiers,
    });
  };
  const type = (text) => call('Input.insertText', { text });
  const shot = async (name) => {
    const { data } = await call('Page.captureScreenshot', { format: 'jpeg', quality: 75 });
    const file = join(shotDir, `${name}.jpg`);
    writeFileSync(file, Buffer.from(data, 'base64'));
    console.log(`  screenshot ${file}`);
  };
  return { call, evaluate, waitFor, click, key, type, shot, close: () => ws.close() };
}

const byText = (selector, text) =>
  `[...document.querySelectorAll(${JSON.stringify(selector)})].find((e) => e.textContent.trim().includes(${JSON.stringify(text)}))`;

let failed = false;
let current = null;
async function step(name, fn) {
  process.stdout.write(`- ${name}\n`);
  try {
    await fn();
  } catch (err) {
    failed = true;
    console.error(`  FAILED: ${err.message}`);
    if (current) await current.shot(`failure-${name.replace(/\W+/g, '-')}`).catch(() => {});
    throw err;
  }
}

try {
  const start = await attach((url) => !url.includes('#/w/'));
  current = start;
  const nickname = 'tour-shop';

  await step('start window answers', () =>
    start.waitFor(`document.querySelector('[data-testid=health]')?.textContent.includes('Server ok')`, 'health'),
  );
  await step('create a favorite (no saved password)', async () => {
    await start.evaluate(
      `fetch(window.kleos.apiBase + '/api/connections', { method: 'POST', headers: { authorization: 'Bearer ' + window.kleos.token, 'content-type': 'application/json' }, body: JSON.stringify(${JSON.stringify(
        {
          nickname,
          host: pgInfo.host,
          port: pgInfo.port,
          user: pgInfo.user,
          database: pgInfo.database,
          sslMode: 'disable',
          color: 'blue',
          readOnly: false,
          password: null,
          savePassword: false,
        },
      )}) }).then((r) => r.status)`,
    );
    await start.evaluate('location.reload()');
    await start.waitFor(
      `${byText('nav[aria-label="Saved connections"] button', nickname)} ? true : false`,
      'favorite in list',
    );
    await start.shot('01-connections');
  });
  await step('double-click connects and prompts for the password', async () => {
    await start.click(byText('nav[aria-label="Saved connections"] button', nickname), 'favorite', 2);
    await start.click(`document.querySelector('#prompt-password')`, 'password field');
    await start.type(pgInfo.password);
    await start.shot('02-password-prompt');
    await start.key('Enter', 'Enter', 13);
  });

  let ws;
  await step('a workspace window opens', async () => {
    ws = await attach((url) => url.includes('#/w/'), 20000);
  });
  current = ws;
  await step('workspace opens with the schema sidebar', async () => {
    await ws.waitFor(`!!document.querySelector('nav[aria-label="Schema objects"]')`, 'schema sidebar');
    await sleep(800);
    await ws.shot('03-workspace');
  });
  await step(`switch to schema ${pgInfo.schema}`, async () => {
    await ws.click(`document.querySelector('aside [role=combobox]')`, 'schema picker');
    await ws.click(byText('[role=option]', pgInfo.schema), `option ${pgInfo.schema}`);
    await ws.waitFor(`document.querySelectorAll('.react-flow__node').length > 1`, 'diagram nodes', 20000);
    await sleep(1200);
    await ws.shot('04-schema-diagram');
  });
  await step(`select ${pgInfo.table} and open its data`, async () => {
    await ws.click(byText('nav[aria-label="Schema objects"] button', pgInfo.table), 'table in sidebar');
    await sleep(600);
    await ws.shot('05-schema-detail');
    await ws.click(byText('nav[aria-label="Schema objects"] button', pgInfo.table), 'table in sidebar', 2);
    await ws.waitFor(`${byText('[role=tab]', 'Data')}?.getAttribute('aria-selected') === 'true'`, 'Data tab active');
    await ws.waitFor(`document.querySelectorAll('[role=gridcell], [role=row]').length > 3`, 'grid rows', 20000);
    await sleep(800);
    await ws.shot('06-data-grid');
  });
  await step('stage an edit and show the pending SQL', async () => {
    await ws.click(`document.querySelectorAll('[role=gridcell]')[2]`, 'a cell', 2);
    await sleep(400);
    await ws.key('a', 'KeyA', 65, 4);
    await ws.type('staged by the tour');
    await ws.key('Enter', 'Enter', 13);
    await sleep(600);
    await ws.shot('07-data-staged');
  });
  await step('run a query', async () => {
    await ws.click(byText('[role=tab]', 'Query'), 'Query tab');
    await ws.click(`document.querySelector('.cm-content')`, 'editor');
    await ws.key('a', 'KeyA', 65, 4);
    await ws.type(
      `select date_trunc('hour', now()) - (g || ' hours')::interval as hour,\n       (random() * 100)::int as web,\n       (random() * 60)::int as ios,\n       (random() * 30)::int as android\nfrom generate_series(1, 48) g\norder by 1;`,
    );
    await ws.key('Enter', 'Enter', 13, 4);
    await ws.waitFor(`document.body.innerText.match(/48 rows/)`, 'result count', 20000);
    await sleep(600);
    await ws.shot('08-query-results');
  });
  await step('chart the results', async () => {
    await ws.click(byText('[aria-label="Result view"] *', 'Chart'), 'Chart view');
    await sleep(1500);
    await ws.shot('09-query-chart');
  });
  await step('explain the query', async () => {
    await ws.click(`document.querySelector('.cm-content')`, 'editor');
    await ws.key('e', 'KeyE', 69, 4);
    await ws.waitFor(`document.body.innerText.match(/Execution|execution/)`, 'explain plan', 20000);
    await sleep(600);
    await ws.shot('10-explain');
  });
  await step('an error is underlined', async () => {
    await ws.click(`document.querySelector('.cm-content')`, 'editor');
    await ws.key('a', 'KeyA', 65, 4);
    await ws.type(`select o.stauts from ${pgInfo.schema}.${pgInfo.table} o;`);
    await ws.key('Enter', 'Enter', 13, 4);
    await ws.waitFor(`document.body.innerText.includes('42703')`, 'error 42703', 20000);
    await sleep(500);
    await ws.shot('11-query-error');
  });
  await step('monitor panels', async () => {
    await ws.click(byText('[role=tab]', 'Monitor'), 'Monitor tab');
    await sleep(11000);
    await ws.shot('12-monitor');
  });
  console.log('TOUR OK');
} catch {
  console.log('TOUR FAILED');
} finally {
  child.kill('SIGTERM');
  for (let i = 0; i < 20 && child.exitCode === null; i += 1) await sleep(250);
  if (child.exitCode === null) child.kill('SIGKILL');
  rmSync(dataDir, { recursive: true, force: true });
}
process.exit(failed ? 1 : 0);
