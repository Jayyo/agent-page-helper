'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const net = require('node:net');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { chromium } = require('playwright');
const { startServer } = require('./server.js');
const { probeTargets, closeTarget } = require('../cdp.js');

const CLI = path.join(__dirname, '..', 'bin', 'cdp-probe.js');

function freePort() {
  return new Promise((resolve) => {
    const s = net.createServer().listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); });
  });
}
function cli(args) {
  return new Promise((resolve) => {
    execFile(process.execPath, [CLI, ...args], (err, stdout, stderr) => resolve({ code: err ? err.code : 0, stdout, stderr }));
  });
}

let server, browser, endpoint, frozenUrl;
test.before(async () => {
  server = await startServer();
  const port = await freePort();
  endpoint = `http://127.0.0.1:${port}`;
  browser = await chromium.launch({ args: [`--remote-debugging-port=${port}`] });
  const context = await browser.newContext();
  const ok = await context.newPage();
  await ok.goto(`${server.origin}/report.html`);
  // A hostile title must not reach the terminal as an escape sequence.
  await ok.evaluate(() => { document.title = 'Report \u001b[31mred\u001b[0m'; });
  // Different site (localhost vs 127.0.0.1), so it gets its own renderer process.
  const stuck = await context.newPage();
  frozenUrl = `${server.origin.replace('127.0.0.1', 'localhost')}/report.html`;
  await stuck.goto(frozenUrl);
  await stuck.evaluate(() => { setTimeout(() => { for (;;) { /* spin */ } }, 0); });
});
test.after(async () => {
  await browser.close();
  await server.close();
});

test('probe tells the frozen page apart from the responsive one', async () => {
  const results = await probeTargets(endpoint, { timeout: 1500 });
  const frozen = results.find((r) => r.url === frozenUrl);
  const fine = results.find((r) => r.url.startsWith(server.origin));
  assert.equal(frozen.status, 'timeout');
  assert.equal(fine.status, 'responsive');
});

test('cli: exit 1 with a frozen page, --json output, --close, then exit 0', async () => {
  const table = await cli(['--endpoint', endpoint, '--timeout', '1500']);
  assert.equal(table.code, 1);
  assert.match(table.stdout, /^timeout\s+\d+ms/m);
  assert.ok(!table.stdout.includes('\u001b'), 'control characters must be stripped');
  assert.ok(table.stdout.includes(`cdp-probe --endpoint ${endpoint} --close <id>`));
  const json = await cli(['--endpoint', endpoint, '--timeout', '1500', '--json']);
  const frozen = JSON.parse(json.stdout).find((r) => r.status === 'timeout');
  assert.equal(frozen.url, frozenUrl);
  const closed = await cli(['--endpoint', endpoint, '--close', frozen.id]);
  assert.equal(closed.code, 0);
  const after = await cli(['--endpoint', endpoint, '--timeout', '1500']);
  assert.equal(after.code, 0, after.stdout);
});

test('cli: unreachable endpoint and bad arguments exit 2', async () => {
  const port = await freePort();
  assert.equal((await cli(['--endpoint', `http://127.0.0.1:${port}`])).code, 2);
  assert.equal((await cli(['--nope'])).code, 2);
});

test('closeTarget returns false for an unknown id', async () => {
  assert.equal(await closeTarget(endpoint, 'no-such-target'), false);
});
