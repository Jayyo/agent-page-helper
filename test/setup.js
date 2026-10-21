'use strict';
// Shared fixture server + headless Chromium for the test files.
const { chromium } = require('playwright');
const { startServer } = require('./server.js');
const { install } = require('../playwright.js');

async function setup() {
  const server = await startServer();
  const browser = await chromium.launch();
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  await install(context);
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  return {
    server, browser, context, page, errors,
    url: (p) => `${server.origin}/${p}`,
    // Open a fixture and return its text snapshot.
    async open(p, opts = {}) {
      await page.goto(`${server.origin}/${p}`, { waitUntil: 'load' });
      if (opts.wait) await page.waitForSelector(opts.wait);
      return page.evaluate(() => window.__aph__.snapshot({ format: 'text' }));
    },
    snapshot(opts = {}) {
      return page.evaluate((o) => window.__aph__.snapshot(o), opts);
    },
    // Call a helper method by name: call('fill', ref, 'text').
    call(method, ...args) {
      return page.evaluate(([m, a]) => window.__aph__[m](...a), [method, args]);
    },
    async close() {
      await browser.close();
      await server.close();
    },
  };
}

// Find the ref of the first snapshot element matching role and name.
function refOf(snapshot, role, name) {
  const el = snapshot.elements.find((e) => e.role === role && (name instanceof RegExp ? name.test(e.name) : e.name === name));
  if (!el) throw new Error(`no ${role} "${name}" in snapshot:\n${snapshot.elements.map((e) => `${e.role} ${e.name}`).join('\n')}`);
  return el.ref;
}

module.exports = { setup, refOf };
