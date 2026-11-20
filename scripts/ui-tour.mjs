// Drives the BUILT app (apps/desktop/out) through a real session against a Postgres you
// provide, with real mouse/keyboard events over the Chrome DevTools Protocol, and saves a
// screenshot per step. Isolated from your real app data via KLEOS_DATA_DIR.
//
//   node scripts/ui-tour.mjs '<pg json>' <screenshot dir>
//   pg json: {"host":"127.0.0.1","port":55432,"user":"kleos","password":"…","database":"shop","schema":"shop","table":"orders"}
// Opens two servers as window tabs, walks every screen, then repeats key screens in dark mode.
import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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
// TOUR_APPEARANCE=light|dark|system starts the app in that appearance (README screenshots).
if (process.env.TOUR_APPEARANCE) {
  writeFileSync(join(dataDir, 'preferences.json'), JSON.stringify({ appearance: process.env.TOUR_APPEARANCE }));
}
const appDir = fileURLToPath(new URL('../apps/desktop', import.meta.url));
// Native save/open sheets answer with paths in here (KLEOS_FAKE_DIALOGS): exports land in it,
// and the import reads import.csv from it.
const filesDir = mkdtempSync(join(tmpdir(), 'kleos-tour-files-'));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// A stand-in for GitHub's latest-release API (KLEOS_UPDATE_URL): reports Kleos 9.9.9.
const releasePort = 9900 + Math.floor(Math.random() * 90);
const releaseServer = spawn(
  process.execPath,
  [fileURLToPath(new URL('./mock-release-server.mjs', import.meta.url)), '9.9.9', String(releasePort)],
  {
    stdio: 'ignore',
  },
);

let port;
let child;
/** Starts the built app on the tour's own profile; called again to test the restored window. */
function launch() {
  port = 9300 + Math.floor(Math.random() * 500);
  child = spawn(electron, [appDir, `--remote-debugging-port=${port}`], {
    stdio: ['ignore', 'ignore', process.env.TOUR_VERBOSE ? 'inherit' : 'ignore'],
    env: {
      ...process.env,
      KLEOS_DATA_DIR: dataDir,
      KLEOS_FAKE_DIALOGS: filesDir,
      KLEOS_UPDATE_URL: `http://127.0.0.1:${releasePort}/latest`,
    },
  });
}
async function quit() {
  child.kill('SIGTERM');
  for (let i = 0; i < 20 && child.exitCode === null; i += 1) await sleep(250);
  if (child.exitCode === null) child.kill('SIGKILL');
}
launch();

async function pages() {
  try {
    return await (await fetch(`http://127.0.0.1:${port}/json`)).json();
  } catch {
    return [];
  }
}

/** Attaches to a page that wasn't open before (e.g. the Settings window). */
async function attachNew(known, timeoutMs = 20000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const page = (await pages()).find(
      (p) => p.type === 'page' && p.webSocketDebuggerUrl && !known.has(p.webSocketDebuggerUrl),
    );
    if (page) return connect(page.webSocketDebuggerUrl);
    await sleep(250);
  }
  throw new Error('new page not found');
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
    const quality = Number(process.env.TOUR_QUALITY ?? 75);
    const { data } = await call('Page.captureScreenshot', { format: 'jpeg', quality });
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
    await win.click(`document.querySelector('[role="dialog"] input[type="password"]')`, 'password field');
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
  const buttonText = (text) => `${visible('button')}.find((b) => b.textContent.trim() === ${JSON.stringify(text)})`;
  await step('asks once before checking for updates, then shows a newer release', async () => {
    await win.waitFor(`document.body.innerText.includes('Check for new versions?')`, 'consent card', 15000);
    await sleep(500);
    await win.shot('00a-update-consent');
    await win.click(buttonText('Check automatically'), 'Check automatically');
    await win.waitFor(`!!${buttonText('Update available')}`, 'update pill', 20000);
    await sleep(400);
    await win.shot('00b-update-pill');
    await win.click(buttonText('Update available'), 'Update available');
    await win.waitFor(`document.querySelector('[role=dialog]')?.textContent.includes('9.9.9')`, 'update dialog');
    await sleep(500);
    await win.shot('00c-update-dialog');
    await win.click(
      `[...document.querySelectorAll('[role=dialog] button')].find((b) => b.textContent.trim() === 'Later')`,
      'Later',
    );
    await win.waitFor(
      // A window in the background doesn't run CSS animations, so a closing Radix dialog can stay
      // mounted with data-state="closed" until it comes forward: closed counts as closed.
      `![...document.querySelectorAll('[role=dialog][data-state=open]')].some((d) => d.textContent.includes('9.9.9'))`,
      'update dialog closed',
    );
  });
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
    await win.click(`document.querySelector('[role="dialog"] input[type="password"]')`, 'password field');
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
  await step('stage a new table, read its exact SQL, apply it', async () => {
    const field = (label) => `document.querySelector('[role=dialog] [aria-label=${JSON.stringify(label)}]')`;
    await win.click(`${visible('button')}.find((b) => b.textContent.trim().startsWith('New table'))`, 'New table…');
    await win.waitFor(
      `!!document.querySelector('[role=dialog] input[placeholder="e.g. invoices"]')`,
      'new table dialog',
    );
    await win.click(`document.querySelector('[role=dialog] input[placeholder="e.g. invoices"]')`, 'table name');
    await win.type('tour_notes');
    await win.click(field('Column 1 name'), 'column 1 name');
    await win.type('id');
    await win.click(field('Column 1 type'), 'column 1 type');
    await win.type('bigint');
    await win.click(field('Column 1 primary key'), 'primary key');
    await win.click(
      `[...document.querySelectorAll('[role=dialog] button')].find((b) => b.textContent.trim() === 'Add column')`,
      'Add column',
    );
    await win.click(field('Column 2 name'), 'column 2 name');
    await win.type('body');
    await win.click(field('Column 2 type'), 'column 2 type');
    await win.type('text');
    await sleep(300);
    await win.shot('05a-new-table-dialog');
    await win.click(
      `[...document.querySelectorAll('[role=dialog] button')].find((b) => b.textContent.trim() === 'Stage table')`,
      'Stage table',
    );
    await win.waitFor(
      `document.querySelector('[aria-label="SQL that will run"]')?.textContent.toLowerCase().includes('create table')`,
      'previewed SQL',
      15000,
    );
    await sleep(500);
    await win.shot('05b-schema-pending');
    await win.click(`${visible('button')}.find((b) => /^Apply [0-9]/.test(b.textContent.trim()))`, 'Apply');
    await win.waitFor(
      `[...document.querySelectorAll('[data-sonner-toast]')].some((t) => t.textContent.includes('Applied'))`,
      'applied toast',
      20000,
    );
    await win.waitFor(`${front}.textContent.includes('tour_notes')`, 'new table in the sidebar', 20000);
    await sleep(800);
    await win.shot('05c-schema-applied');
  });
  await step('export the diagram as SVG and PNG', async () => {
    for (const [label, file] of [
      ['SVG image', `${pgInfo.schema}-diagram.svg`],
      ['PNG image', `${pgInfo.schema}-diagram.png`],
    ]) {
      await win.click(
        `${visible('button')}.find((b) => b.textContent.trim().startsWith('Export diagram'))`,
        'Export diagram…',
      );
      await win.click(
        `[...document.querySelectorAll('[role=menu] [role=menuitem]')].find((i) => i.textContent.trim().startsWith(${JSON.stringify(label)}))`,
        label,
      );
      await win.waitFor(
        `[...document.querySelectorAll('[data-sonner-toast]')].some((t) => t.textContent.includes(${JSON.stringify(file)}))`,
        `export toast for ${file}`,
        20000,
      );
    }
    const svg = readFileSync(join(filesDir, `${pgInfo.schema}-diagram.svg`), 'utf8');
    if (!svg.startsWith('<svg') && !svg.startsWith('<?xml')) throw new Error('not an SVG');
    if (!svg.includes('tour_notes')) throw new Error('the SVG lacks the new table');
    const png = readFileSync(join(filesDir, `${pgInfo.schema}-diagram.png`));
    if (png[0] !== 0x89 || png[1] !== 0x50) throw new Error('not a PNG');
    writeFileSync(join(shotDir, '05d-exported-diagram.png'), png);
    console.log(`  ${pgInfo.schema}-diagram.svg ${svg.length} bytes · .png ${png.length} bytes`);
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
  const toast = (text) =>
    `[...document.querySelectorAll('[data-sonner-toast]')].some((t) => t.textContent.includes(${JSON.stringify(text)}))`;
  await step('Settings window: panes, and rows per page reaches the Data tab', async () => {
    const known = new Set((await pages()).map((p) => p.webSocketDebuggerUrl));
    await win.evaluate('window.kleos.openSettings()');
    const prefs = await attachNew(known);
    const tab = (name) =>
      `[...document.querySelectorAll('[role=tab]')].find((t) => t.textContent.trim() === ${JSON.stringify(name)})`;
    await prefs.waitFor(`!!${tab('General')}`, 'Settings panes');
    await sleep(800);
    await prefs.shot('06s1-settings-general');
    await prefs.click(tab('Data'), 'Data pane');
    await sleep(500);
    await prefs.shot('06s2-settings-data');
    await prefs.click(
      `[...document.querySelectorAll('[aria-labelledby="page-size-label"] button')].find((b) => b.textContent.trim() === '100')`,
      'Rows per page 100',
    );
    await win.waitFor(`document.body.innerText.includes('100 per page')`, 'main window follows the page size');
    await prefs.click(tab('Updates'), 'Updates pane');
    await prefs.waitFor(`document.body.innerText.includes('9.9.9')`, 'Updates pane shows the newer release', 10000);
    await sleep(500);
    await prefs.shot('06s3-settings-updates');
    await prefs.evaluate('window.kleos.closeWindow()').catch(() => {});
    prefs.close();
    await sleep(400);
  });
  await step('export the table to CSV', async () => {
    await win.click(`${visible('button')}.find((b) => b.textContent.trim().startsWith('Export'))`, 'Export…');
    await win.waitFor(`!!document.querySelector('[role=menu]')`, 'export menu');
    await sleep(300);
    await win.shot('06a-export-menu');
    await win.click(
      `[...document.querySelectorAll('[role=menu] [role=menuitem]')].find((i) => i.textContent.trim().startsWith('CSV'))`,
      'CSV',
    );
    await win.waitFor(toast('Exported'), 'export done toast', 20000);
    await sleep(300);
    await win.shot('06b-export-done');
    const csv = readFileSync(join(filesDir, `${pgInfo.table}.csv`), 'utf8');
    const lines = csv
      .replace(/^\uFEFF/, '')
      .trim()
      .split('\n');
    if (lines.length < 2) throw new Error(`export wrote ${lines.length} lines`);
    console.log(`  ${pgInfo.table}.csv: ${lines.length - 1} rows, header ${lines[0]}`);
  });
  await step('import a CSV into the table', async () => {
    // Assumes the seeded shop.orders (id, customer_id, status, total, note).
    writeFileSync(
      join(filesDir, 'import.csv'),
      'id,customer_id,status,total,note\n101,1,paid,42.00,imported by the tour\n102,2,pending,9.90,\n103,3,shipped,18.25,"quoted, with a comma"\n',
    );
    await win.click(`${visible('button')}.find((b) => b.textContent.trim().startsWith('Import CSV'))`, 'Import CSV…');
    await win.waitFor(
      `document.querySelector('[role=dialog]')?.textContent.includes('Import 3 rows')`,
      'import dialog',
    );
    await sleep(500);
    await win.shot('06c-import-dialog');
    await win.click(
      `[...document.querySelectorAll('[role=dialog] button')].find((b) => b.textContent.trim().startsWith('Import 3 rows'))`,
      'Import 3 rows',
    );
    await win.waitFor(toast('Imported 3 rows'), 'import done toast', 20000);
    await win.waitFor(
      `${visible('[role=gridcell]')}.some((c) => c.textContent.includes('imported by the tour'))`,
      'imported row in the grid',
      20000,
    );
    await sleep(400);
    await win.shot('06d-imported');
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
  await step('export the query results to JSON', async () => {
    await win.click(`${visible('button')}.find((b) => b.textContent.trim().startsWith('Export'))`, 'results Export…');
    await win.click(
      `[...document.querySelectorAll('[role=menu] [role=menuitem]')].find((i) => i.textContent.trim().startsWith('JSON'))`,
      'JSON',
    );
    await win.waitFor(toast('Exported 48 rows'), 'query export toast', 20000);
    const rows = JSON.parse(readFileSync(join(filesDir, 'query-results.json'), 'utf8'));
    if (rows.length !== 48 || typeof rows[0].web !== 'number') throw new Error('unexpected JSON export');
    console.log(`  query-results.json: ${rows.length} objects, keys ${Object.keys(rows[0]).join(', ')}`);
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
  const editorText = `${visible('.cm-content')}[0]?.innerText ?? ''`;
  const replaceEditor = async (sql) => {
    await win.click(`${visible('.cm-content')}[0]`, 'editor');
    await win.key('a', 'KeyA', 65, 4);
    await win.type(sql);
  };
  const apiCall = (method, path, body) =>
    win.evaluate(
      `fetch(window.kleos.apiBase + '/api' + ${JSON.stringify(path)}, { method: ${JSON.stringify(method)}, headers: { authorization: 'Bearer ' + window.kleos.token, 'content-type': 'application/json' }, body: ${body ? JSON.stringify(JSON.stringify(body)) : 'undefined'} }).then((r) => r.json())`,
    );
  await step('Run all: a 20-statement migration stops at the failing line', async () => {
    const lines = ['create table shop.tour_migration (id int primary key, label text);'];
    for (let i = 1; i <= 18; i += 1) {
      // Statement 15 inserts id 3 again: a duplicate key, on line 15 of the script.
      const id = i === 14 ? 3 : i;
      lines.push(`insert into shop.tour_migration values (${id}, 'row ${i}');`);
    }
    lines.push('select count(*) from shop.tour_migration;');
    await replaceEditor(lines.join('\n'));
    await win.click(`${visible('button')}.find((b) => b.textContent.trim().startsWith('Run all'))`, 'Run all');
    await win.waitFor(`document.body.innerText.includes('23505')`, 'the duplicate key error', 30000);
    await win.waitFor(
      `/Statement 15 of 20/.test(document.body.innerText) && /line 15/.test(document.body.innerText)`,
      'statement 15, line 15',
    );
    await sleep(600);
    await win.shot('11a-run-all-stops');
  });
  await step('parameters prompt before running', async () => {
    await replaceEditor('select id, status, total from shop.orders where id = :id and status = :status;');
    await win.key('Enter', 'Enter', 13, 4);
    await win.waitFor(
      `document.querySelector('[role=dialog]')?.textContent.includes('Parameters')`,
      'parameter dialog',
    );
    await win.click(`document.querySelectorAll('[role=dialog] input:not([type=checkbox])')[0]`, 'first value');
    await win.type('1');
    await win.click(`document.querySelectorAll('[role=dialog] input:not([type=checkbox])')[1]`, 'second value');
    await win.type('paid');
    await sleep(300);
    await win.shot('11b-parameters');
    await win.key('Enter', 'Enter', 13);
    await win.waitFor(`document.body.innerText.match(/1 row(?![a-z])/)`, 'one row', 20000);
    await sleep(400);
    await win.shot('11c-parameters-result');
  });
  await step('Format SQL', async () => {
    await replaceEditor(
      'select o.id,o.status,c.email from shop.orders o join shop.customers c on c.id=o.customer_id where o.total>10 order by o.id;',
    );
    await win.click(`document.querySelector('button[aria-label="Format SQL"]')`, 'Format SQL');
    await win.waitFor(
      `${visible('.cm-content')}[0]?.querySelectorAll('.cm-line').length > 4`,
      'formatted over several lines',
    );
    await sleep(300);
    await win.shot('11d-formatted');
  });
  await step('search the history', async () => {
    await win.click(`${visible('[role=tab]')}.find((t) => t.textContent.trim() === 'History')`, 'History tab');
    await win.click(`document.querySelector('input[aria-label="Search history"]')`, 'history search');
    await win.type('tour_migration');
    await win.waitFor(`!!document.querySelector('ul[aria-label="Matching runs"] li')`, 'matching runs', 15000);
    await sleep(400);
    await win.shot('11e-history-search');
  });
  await step('insert a snippet', async () => {
    await apiCall('POST', '/snippets', {
      name: 'Recent orders',
      body: 'select * from shop.orders order by id desc limit 10;',
    });
    await replaceEditor('');
    await win.click(`${visible('[role=tab]')}.find((t) => t.textContent.trim() === 'Snippets')`, 'Snippets tab');
    await win.click(`document.querySelector('button[aria-label="Insert Recent orders"]')`, 'Insert Recent orders');
    await win.waitFor(`(${editorText}).includes('order by id desc limit 10')`, 'snippet in the editor');
    await sleep(300);
    await win.shot('11f-snippet-inserted');
  });
  await step('⌘K reruns a saved query with its remembered parameter', async () => {
    const tabs = await win.evaluate(
      `fetch(window.kleos.apiBase + '/api/connections', { headers: { authorization: 'Bearer ' + window.kleos.token } }).then((r) => r.json())`,
    );
    const dev = tabs.find((c) => c.nickname === 'shop (dev)');
    await apiCall('POST', '/saved-queries', {
      connectionId: dev.id,
      name: 'Orders by status',
      sql: 'select id, status, total from shop.orders where status = :status order by id;',
      chart: null,
      paramValues: { ':status': 'paid' },
    });
    await win.click(`document.querySelector('button[aria-label="Open the command palette"]')`, 'Search button');
    await win.waitFor(`!!document.querySelector('[cmdk-input]')`, 'palette input');
    await win.type('Orders by status');
    await win.waitFor(
      `[...document.querySelectorAll('[cmdk-item]')][0]?.textContent.includes('Run saved query')`,
      'Run saved query ranked first',
      15000,
    );
    await win.key('Enter', 'Enter', 13);
    await win.waitFor(
      `[...document.querySelectorAll('[role=dialog] input:not([type=checkbox])')].some((i) => i.value === 'paid')`,
      'prompt prefilled with paid',
      15000,
    );
    await sleep(300);
    await win.shot('11g-saved-query-prompt');
    await win.key('Enter', 'Enter', 13);
    await win.waitFor(
      `!document.querySelector('[role=dialog]') && ${visible('[role=gridcell]')}.some((c) => c.textContent.trim() === 'paid')`,
      'paid orders',
      20000,
    );
    await sleep(400);
    await win.shot('11h-saved-query-rerun');
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
  await step('SSH tunnel section of a new favorite', async () => {
    await win.click(`${visible('button')}.find((b) => b.textContent.trim() === 'New')`, 'New favorite');
    await win.click(
      `document.getElementById([...document.querySelectorAll('label')].find((l) => l.textContent.trim() === 'Connect through SSH')?.htmlFor)`,
      'SSH switch',
    );
    await win.waitFor(`document.body.innerText.includes('SSH agent')`, 'SSH fields');
    await sleep(500);
    await win.shot('18-dark-ssh-form');
  });
  await step('relaunch restores the open servers and their query tabs', async () => {
    await sleep(1500); // past the window-state save debounce
    win.close();
    await quit();
    launch();
    const again = await attach(() => true, 30000);
    current = again;
    await again.waitFor(
      `!!${tabButton('shop (dev)')} && !!${tabButton('shop (read-only)')}`,
      'both server tabs restored',
      30000,
    );
    await again.click(tabButton('shop (dev)'), 'restored tab');
    // Passwords were never saved: the tab waits for one in its reconnect state.
    await again.waitFor(
      `${visible('button')}.some((b) => b.textContent.trim() === 'Connect')`,
      'reconnect state',
      20000,
    );
    await sleep(500);
    await again.shot('19-restored-reconnect');
    await again.click(`${visible('button')}.find((b) => b.textContent.trim() === 'Connect')`, 'Connect');
    await again.click(`document.querySelector('[role="dialog"] input[type="password"]')`, 'password field');
    await again.type(pgInfo.password);
    await again.key('Enter', 'Enter', 13);
    await again.waitFor(`!!${front}`, 'restored workspace', 20000);
    await again.click(`${visible('[role=tab]')}.find((t) => t.textContent.trim() === 'Query')`, 'Query tab');
    await again.waitFor(
      `${visible('.cm-content')}[0]?.textContent.includes('where status = :status') && document.body.innerText.includes('Query 1') && document.body.innerText.includes('Orders by status')`,
      'restored query tabs and SQL',
      20000,
    );
    await sleep(600);
    await again.shot('20-restored-query');
  });
  console.log('TOUR OK');
} catch {
  console.log('TOUR FAILED');
} finally {
  releaseServer.kill();
  await quit();
  rmSync(dataDir, { recursive: true, force: true });
  rmSync(filesDir, { recursive: true, force: true });
}
process.exit(failed ? 1 : 0);
