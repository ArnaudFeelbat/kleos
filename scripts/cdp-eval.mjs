// Evaluates a JS expression in the first page of an already-running Kleos started
// with a remote-debugging port, retrying until it is truthy. Usage:
//   node scripts/cdp-eval.mjs <port> "<expression>" [timeoutMs]
const [port, expression, timeoutArg] = process.argv.slice(2);
const deadline = Date.now() + Number(timeoutArg ?? 20000);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let wsUrl;
while (!wsUrl && Date.now() < deadline) {
  try {
    const pages = await (await fetch(`http://127.0.0.1:${port}/json`)).json();
    wsUrl = pages.find((p) => p.type === 'page' && p.webSocketDebuggerUrl)?.webSocketDebuggerUrl;
  } catch {
    // not listening yet
  }
  if (!wsUrl) await sleep(300);
}
if (!wsUrl) {
  console.error('CDP: no page');
  process.exit(1);
}
const ws = new WebSocket(wsUrl);
await new Promise((resolve, reject) => {
  ws.onopen = resolve;
  ws.onerror = reject;
});
let id = 0;
const call = (method, params) =>
  new Promise((resolve) => {
    const msgId = ++id;
    ws.addEventListener('message', function onMessage(event) {
      const msg = JSON.parse(event.data);
      if (msg.id !== msgId) return;
      ws.removeEventListener('message', onMessage);
      resolve(msg.result);
    });
    ws.send(JSON.stringify({ id: msgId, method, params }));
  });
while (Date.now() < deadline) {
  const result = await call('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
  const value = result?.result?.value;
  if (value) {
    console.log('CDP OK:', typeof value === 'string' ? value : JSON.stringify(value));
    ws.close();
    process.exit(0);
  }
  await sleep(300);
}
console.error('CDP: expression stayed falsy');
ws.close();
process.exit(1);
