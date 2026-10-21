'use strict';
// Responsiveness probe for a Chromium DevTools HTTP endpoint (e.g. a browser
// started with --remote-debugging-port=9222). Needs Node 22+ (global WebSocket).

const PRINT_PREVIEW = /^chrome(-untrusted)?:\/\/print/;

function base(endpoint) {
  return String(endpoint || process.env.CDP_ENDPOINT || 'http://127.0.0.1:9222').replace(/\/+$/, '');
}

async function listTargets(endpoint, { timeout = 3000 } = {}) {
  const res = await fetch(`${base(endpoint)}/json/list`, { signal: AbortSignal.timeout(timeout) });
  if (!res.ok) throw new Error(`GET /json/list returned HTTP ${res.status}`);
  return res.json();
}

// One Runtime.evaluate round trip over the target's own WebSocket.
// status: responsive | timeout | error | ws-error | closed | no-websocket
function probeTarget(target, { timeout = 3000 } = {}) {
  return new Promise((resolve) => {
    const t0 = Date.now();
    if (!target.webSocketDebuggerUrl) { resolve({ status: 'no-websocket', ms: 0 }); return; }
    let ws = null;
    let settled = false;
    const done = (status, error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { if (ws) ws.close(); } catch (e) { /* already closed */ }
      resolve(error ? { status, ms: Date.now() - t0, error } : { status, ms: Date.now() - t0 });
    };
    const timer = setTimeout(() => done('timeout'), timeout);
    try {
      ws = new WebSocket(target.webSocketDebuggerUrl);
    } catch (e) {
      done('ws-error', e.message);
      return;
    }
    ws.onopen = () => ws.send(JSON.stringify({ id: 1, method: 'Runtime.evaluate', params: { expression: '1', returnByValue: true } }));
    ws.onmessage = (ev) => {
      let msg;
      try { msg = JSON.parse(ev.data); } catch (e) { return; }
      if (msg.id !== 1) return;
      if (msg.error) done('error', msg.error.message);
      else done('responsive');
    };
    ws.onerror = () => done('ws-error');
    ws.onclose = () => done('closed');
  });
}

async function probeTargets(endpoint, { timeout = 3000, types = ['page'] } = {}) {
  const targets = (await listTargets(endpoint, { timeout })).filter((t) => types.includes(t.type));
  return Promise.all(targets.map(async (t) => Object.assign(
    { id: t.id, type: t.type, title: t.title, url: t.url, printPreview: PRINT_PREVIEW.test(t.url) },
    await probeTarget(t, { timeout }),
  )));
}

// Asks the browser to close one target and waits until it is gone from the list.
// Returns false if the browser refused or the target is still listed after `timeout`.
async function closeTarget(endpoint, id, { timeout = 3000 } = {}) {
  const res = await fetch(`${base(endpoint)}/json/close/${encodeURIComponent(id)}`, { signal: AbortSignal.timeout(timeout) });
  if (!res.ok) return false;
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const targets = await listTargets(endpoint, { timeout });
    if (!targets.some((t) => t.id === id)) return true;
    await new Promise((r) => setTimeout(r, 100));
  }
  return false;
}

module.exports = { listTargets, probeTarget, probeTargets, closeTarget };
