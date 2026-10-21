#!/usr/bin/env node
// Probe every page target of a CDP endpoint with a short Runtime.evaluate.
// A target that prints TIMEOUT has a frozen renderer (print preview, native dialog,
// hung viewer) and can block connectOverCDP for every command. Close that one
// target instead of restarting the browser.
// Usage: cdp-probe [endpoint=http://127.0.0.1:9222] [timeoutMs=5000]
const endpoint = (process.argv[2] || 'http://127.0.0.1:9222').replace(/\/$/, '');
const tmo = parseInt(process.argv[3] || '5000', 10);

async function getTargets() {
  const res = await fetch(`${endpoint}/json/list`);
  return res.json();
}
function probe(t) {
  return new Promise((res) => {
    const ws = new WebSocket(t.webSocketDebuggerUrl);
    const timer = setTimeout(() => { try { ws.close(); } catch (e) {} res('TIMEOUT'); }, tmo);
    ws.onopen = () => ws.send(JSON.stringify({ id: 1, method: 'Runtime.evaluate', params: { expression: 'location.href', returnByValue: true } }));
    ws.onmessage = (ev) => { const m = JSON.parse(ev.data); if (m.id === 1) { clearTimeout(timer); ws.close(); res('ok'); } };
    ws.onerror = () => { clearTimeout(timer); res('WS_ERR'); };
  });
}
(async () => {
  const targets = await getTargets();
  const pages = targets.filter((t) => t.type === 'page');
  let bad = 0;
  for (const t of pages) {
    const r = await probe(t);
    if (r !== 'ok') bad++;
    console.log(`${r.padEnd(7)} ${t.id} ${(t.title || '').slice(0, 28).padEnd(28)} ${t.url.slice(0, 70)}`);
  }
  const printTargets = targets.filter((t) => /^chrome(-untrusted)?:\/\/print/.test(t.url));
  if (printTargets.length) console.log(`\nprint-preview targets present: ${printTargets.map((t) => t.id).join(', ')} -> curl ${endpoint}/json/close/<id>`);
  console.log(bad ? `\n${bad} unresponsive page(s). Close them with: curl -s ${endpoint}/json/close/<id>` : '\nall pages responsive; the hang is not a frozen tab');
  process.exit(bad ? 1 : 0);
})().catch((e) => { console.error('ERR', e.message); process.exit(2); });
