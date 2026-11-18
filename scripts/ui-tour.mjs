// Drives the BUILT app (apps/desktop/out) through a real session against a Postgres you
// provide, with real mouse/keyboard events over the Chrome DevTools Protocol, and saves a
// screenshot per step. Isolated from your real app data via KLEOS_DATA_DIR.
//
//   node scripts/ui-tour.mjs '<pg json>' <screenshot dir>
//   pg json: {"host":"127.0.0.1","port":55432,"user":"kleos","password":"…","database":"shop","schema":"shop","table":"orders"}
// Opens two servers as window tabs, walks every screen, then repeats key screens in dark mode.
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
    // CDP captures web content only: the native vibrancy behind translucent panes would
    // come out black. Paint a stand-in close to macOS's sidebar material instead.
    await evaluate(
      `(() => { const h = document.documentElement; if (h.classList.contains('vibrancy')) h.style.backgroundColor = h.classList.contains('dark') ? '#2a2a2e' : '#e8e8eb'; })()`,
    );
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
  const win = await attach(() => true);
  current = win;
  const favorite = (nickname, color, readOnly) => ({
    nickname,
    host: pgInfo.host,
    port: pgInfo.port,
    user: pgInfo.user,
    database: pgInfo.database,
    sslMode: 'disable',
    color,
    readOnly,
    password: null,
    savePassword: false,
  });
  const createFavorite = (body) =>
    win.evaluate(
      `fetch(window.kleos.apiBase + '/api/connections', { method: 'POST', headers: { authorization: 'Bearer ' + window.kleos.token, 'content-type': 'application/json' }, body: JSON.stringify(${JSON.stringify(body)}) }).then((r) => r.status)`,
    );
  const tabButton = (name) =>
    `[...document.querySelectorAll('nav[aria-label="Open connections"] button')].find((b) => b.textContent.trim() === ${JSON.stringify(name)})`;
  const connectWithPassword = async (nickname) => {
    await win.click(byText('nav[aria-label="Saved connections"] button', nickname), `favorite ${nickname}`, 2);
    await win.click(`document.querySelector('#prompt-password')`, 'password field');
    await win.type(pgInfo.password);
    await win.key('Enter', 'Enter', 13);
    await win.waitFor(
      `${tabButton(nickname)}?.getAttribute('aria-current') === 'page'`,
      `tab ${nickname} in front`,
      20000,
    );
  };
  const front = `[...document.querySelectorAll('nav[aria-label="Schema objects"]')].find((n) => n.offsetParent !== null)`;
  const visible = (selector) =>
    `[...document.querySelectorAll(${JSON.stringify(selector)})].filter((e) => e.offsetParent !== null)`;

  await step('window answers', () =>
    win.waitFor(`document.querySelector('[data-testid=health]')?.textContent.includes('Server ok')`, 'health'),
  );
  await step('two favorites on the Connections tab', async () => {
    await createFavorite(favorite('shop (dev)', 'blue', false));
    await createFavorite(favorite('shop (read-only)', 'red', true));
    await win.evaluate('location.reload()');
    await win.waitFor(
      `${byText('nav[aria-label="Saved connections"] button', 'shop (dev)')} ? true : false`,
      'favorites',
    );
    await sleep(500);
    await win.shot('01-connections');
  });
  await step('connect the first server: password prompt, then its tab', async () => {
    await win.click(byText('nav[aria-label="Saved connections"] button', 'shop (dev)'), 'favorite', 2);
    await win.click(`document.querySelector('#prompt-password')`, 'password field');
    await win.type(pgInfo.password);
    await win.shot('02-password-prompt');
    await win.key('Enter', 'Enter', 13);
    await win.waitFor(
      `${tabButton('shop (dev)')}?.getAttribute('aria-current') === 'page'`,
      'first tab in front',
      20000,
    );
    await win.waitFor(`!!${front}`, 'schema sidebar');
    await sleep(1200);
    await win.shot('03-workspace');
  });
  await step('a second server opens in its own tab', async () => {
    await win.click(
      `document.querySelector('nav[aria-label="Open connections"] button[aria-label="Connections"]')`,
      'Connections tab',
    );
    await connectWithPassword('shop (read-only)');
    await win.waitFor(`!!${front}`, 'second sidebar');
    await sleep(1200);
    await win.shot('04-second-tab');
    await win.click(tabButton('shop (dev)'), 'first tab');
    await sleep(400);
  });
  await step(`switch to schema ${pgInfo.schema}`, async () => {
    await win.click(`${visible('aside [role=combobox]')}[0]`, 'schema picker');
    await win.click(byText('[role=option]', pgInfo.schema), `option ${pgInfo.schema}`);
    await win.waitFor(`${visible('.react-flow__node')}.length > 1`, 'diagram nodes', 20000);
    await sleep(1200);
    await win.shot('05-schema-diagram');
  });
  await step(`open ${pgInfo.table} in Data`, async () => {
    await win.click(
      `[...${front}.querySelectorAll('button')].find((b) => b.textContent.trim().startsWith(${JSON.stringify(pgInfo.table)}))`,
      'table',
      2,
    );
    await win.waitFor(`${visible('[role=gridcell]')}.length > 3`, 'grid cells', 20000);
    await sleep(800);
    await win.shot('06-data-grid');
  });
  await step('stage an edit', async () => {
    const cell = `${visible('[role=gridcell]')}.find((c) => c.getAttribute('aria-colindex') === '6' || c.textContent.trim() === '')`;
    await win.click(`${cell} ?? ${visible('[role=gridcell]')}[5]`, 'a text cell', 2);
    await sleep(300);
    await win.key('a', 'KeyA', 65, 4);
    await win.type('staged by the tour');
    await win.key('Enter', 'Enter', 13);
    await sleep(600);
    await win.shot('07-data-staged');
  });
  await step('run a query', async () => {
    await win.click(`${visible('[role=tab]')}.find((t) => t.textContent.trim() === 'Query')`, 'Query tab');
    await win.click(`${visible('.cm-content')}[0]`, 'editor');
    await win.key('a', 'KeyA', 65, 4);
    await win.type(
      `select date_trunc('hour', now()) - (g || ' hours')::interval as hour,\n       (40 + 30 * sin(g / 4.0))::int as web,\n       (25 + 12 * cos(g / 5.0))::int as ios,\n       (12 + 6 * sin(g / 3.0))::int as android\nfrom generate_series(1, 48) g\norder by 1;`,
    );
    await win.key('Enter', 'Enter', 13, 4);
    await win.waitFor(`document.body.innerText.match(/48 rows/)`, 'result count', 20000);
    await sleep(600);
    await win.shot('08-query-results');
  });
  await step('chart the results', async () => {
    await win.click(
      `${visible('[aria-label="Result view"] *')}.find((e) => e.textContent.trim() === 'Chart')`,
      'Chart view',
    );
    await sleep(1500);
    await win.shot('09-query-chart');
  });
  await step('explain', async () => {
    await win.click(`${visible('.cm-content')}[0]`, 'editor');
    await win.key('e', 'KeyE', 69, 4);
    await win.waitFor(`document.body.innerText.match(/Execution/)`, 'explain', 20000);
    await sleep(600);
    await win.shot('10-explain');
  });
  await step('an error is underlined', async () => {
    await win.click(`${visible('.cm-content')}[0]`, 'editor');
    await win.key('a', 'KeyA', 65, 4);
    await win.type(`select o.stauts from ${pgInfo.schema}.${pgInfo.table} o;`);
    await win.key('Enter', 'Enter', 13, 4);
    await win.waitFor(`document.body.innerText.includes('42703')`, 'error 42703', 20000);
    await sleep(500);
    await win.shot('11-query-error');
  });
  await step('monitor', async () => {
    await win.click(`${visible('[role=tab]')}.find((t) => t.textContent.trim() === 'Monitor')`, 'Monitor tab');
    await sleep(11000);
    await win.shot('12-monitor');
  });
  const palette = async (query) => {
    await win.click(`document.querySelector('button[aria-label="Open the command palette"]')`, 'Search button');
    await win.waitFor(`!!document.querySelector('[cmdk-input]')`, 'palette input');
    await win.type(query);
    await sleep(400);
  };
  await step('command palette opens a table by name', async () => {
    await palette('order_items');
    await win.shot('13a-palette-search');
    await win.key('Enter', 'Enter', 13);
    await win.waitFor(
      `document.body.innerText.includes('order_items') && ${visible('[role=gridcell]')}.length > 0`,
      'order_items rows',
      20000,
    );
    await sleep(600);
    await win.shot('13b-palette-opened-table');
  });
  await step('dark mode from the palette', async () => {
    await palette('appearance');
    await win.shot('13c-palette-appearance');
    await win.click(
      `[...document.querySelectorAll('[cmdk-item]')].find((i) => i.textContent.includes('Appearance: Dark'))`,
      'Appearance: Dark',
    );
    await win.waitFor(`document.documentElement.classList.contains('dark')`, 'dark class', 10000);
    await win.click(`${visible('[role=tab]')}.find((t) => t.textContent.trim() === 'Monitor')`, 'Monitor tab');
    await sleep(800);
    await win.shot('13-dark-monitor');
    for (const [tab, name] of [
      ['Data', '14-dark-data'],
      ['Query', '15-dark-query'],
      ['Schema', '16-dark-schema'],
    ]) {
      await win.click(`${visible('[role=tab]')}.find((t) => t.textContent.trim() === ${JSON.stringify(tab)})`, tab);
      await sleep(900);
      await win.shot(name);
    }
    await win.click(
      `document.querySelector('nav[aria-label="Open connections"] button[aria-label="Connections"]')`,
      'Connections tab',
    );
    await sleep(600);
    await win.shot('17-dark-connections');
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
