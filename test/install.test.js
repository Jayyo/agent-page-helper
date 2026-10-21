'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { chromium } = require('playwright');
const { startServer } = require('./server.js');

let server, browser;
test.before(async () => {
  server = await startServer();
  browser = await chromium.launch();
});
test.after(async () => {
  await browser.close();
  await server.close();
});

test('install() covers pages and frames that were open before it ran', async () => {
  const { install } = require('agent-page-helper/playwright');
  const context = await browser.newContext();
  const page = await context.newPage();
  await page.goto(`${server.origin}/nested-frames.html`);
  const report = await install(context);
  assert.equal(report.injected, 3);
  assert.deepEqual(report.failed, []);
  for (const frame of page.frames()) assert.equal(await frame.evaluate(() => typeof window.__aph__.snapshot), 'function');
  // Running it again finds the script already there.
  const again = await install(context);
  assert.equal(again.injected, 0);
  assert.equal(again.present, 3);
  // New documents get it from the init script.
  await page.goto(`${server.origin}/occluded.html`);
  assert.equal(await page.evaluate(() => window.__aph__.version), require('../package.json').version);
  await context.close();
});

test('install() reports a different version that is already on the page', async () => {
  const { install } = require('agent-page-helper/playwright');
  const context = await browser.newContext();
  const page = await context.newPage();
  await page.goto(`${server.origin}/report.html`);
  await page.evaluate(() => { window.__aph__ = { version: '0.0.1' }; });
  const report = await install(page);
  assert.deepEqual(report.mismatched.map((m) => m.version), ['0.0.1']);
  await context.close();
});

test('works over a raw CDP session, without Playwright evaluate', async () => {
  const { helperSource } = require('agent-page-helper');
  const context = await browser.newContext();
  const page = await context.newPage();
  const cdp = await context.newCDPSession(page);
  await cdp.send('Page.enable');
  await cdp.send('Page.addScriptToEvaluateOnNewDocument', { source: helperSource });
  await page.goto(`${server.origin}/react-controlled.html`);
  await page.waitForSelector('#email');
  const evaluate = async (expression) => (await cdp.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })).result.value;
  const text = await evaluate('window.__aph__.snapshot({ format: "text" })');
  const ref = text.match(/\[([a-z]{4}\d+)\] textbox "Email"/)[1];
  const r = await evaluate(`window.__aph__.fill(${JSON.stringify(ref)}, "cdp@example.com")`);
  assert.equal(r.ok, true);
  await page.click('button[type=submit]');
  assert.equal((await page.evaluate(() => window.__result)).email, 'cdp@example.com');
  await context.close();
});

test('package entry points load from CommonJS and ESM', async () => {
  const core = require('agent-page-helper');
  assert.equal(fs.readFileSync(core.helperPath, 'utf8'), core.helperSource);
  const esm = await import('agent-page-helper/playwright');
  assert.equal(typeof esm.install, 'function');
  assert.equal(typeof esm.uploadFile, 'function');
  const cdp = await import('agent-page-helper/cdp');
  assert.equal(typeof cdp.probeTargets, 'function');
});

test('version is the same in package.json, the userscript header and the global', () => {
  const { version } = require('../package.json');
  const src = require('agent-page-helper').helperSource;
  assert.match(src, new RegExp(`^// @version\\s+${version.replace(/\./g, '\\.')}$`, 'm'));
  assert.match(src, new RegExp(`const VERSION = '${version.replace(/\./g, '\\.')}'`));
});

test('the published package contains only the library files', () => {
  const out = execFileSync('npm', ['pack', '--dry-run', '--json', '--ignore-scripts'], { cwd: path.join(__dirname, '..'), encoding: 'utf8' });
  const files = JSON.parse(out)[0].files.map((f) => f.path);
  const required = ['agent-page-helper.user.js', 'bin/cdp-probe.js', 'cdp.d.ts', 'cdp.js', 'index.d.ts', 'index.js', 'package.json', 'playwright.d.ts', 'playwright.js'];
  for (const f of required) assert.ok(files.includes(f), `missing ${f}`);
  const extra = files.filter((f) => !required.includes(f) && !['LICENSE', 'README.md'].includes(f));
  assert.deepEqual(extra, []);
});
