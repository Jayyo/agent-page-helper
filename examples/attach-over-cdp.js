// Attach to a Chrome you started yourself and snapshot its first tab.
//
// Start Chrome with a separate profile (Chrome 136+ refuses remote debugging
// on the default profile):
//   google-chrome --remote-debugging-port=9222 --user-data-dir="$HOME/.cache/agent-chrome"
//
//   node examples/attach-over-cdp.js [http://127.0.0.1:9222]
const { chromium } = require('playwright');
const { install } = require('agent-page-helper/playwright');

(async () => {
  const endpoint = process.argv[2] || 'http://127.0.0.1:9222';
  const browser = await chromium.connectOverCDP(endpoint);
  const context = browser.contexts()[0];
  // Init script for new documents + injection into tabs that are already open.
  const report = await install(context);
  console.error(`helper ${report.version}: injected into ${report.injected} frame(s), already present in ${report.present}`);
  const page = context.pages()[0] || (await context.newPage());
  console.log(await page.evaluate(() => window.__aph__.snapshot({ format: 'text' })));
  // Disconnects without closing the user's browser.
  await browser.close();
})();
