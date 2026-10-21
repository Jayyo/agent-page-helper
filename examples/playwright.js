// Print the helper's text snapshot of a page, then act on it by ref.
//   node examples/playwright.js [url]
const { chromium } = require('playwright');
const { install } = require('agent-page-helper/playwright');

(async () => {
  const url = process.argv[2] || 'https://news.ycombinator.com/';
  const browser = await chromium.launch();
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  await install(context);
  const page = await context.newPage();
  await page.goto(url);

  // What an LLM would see: one line per control, refs in brackets.
  const text = await page.evaluate(() => window.__aph__.snapshot({ format: 'text', maxElements: 40 }));
  console.log(text);

  // Acting on a ref: find a "More" link and click it.
  const [more] = await page.evaluate(() => window.__aph__.find('More', { role: 'link', exact: true }));
  if (more) {
    const before = page.url();
    const result = await page.evaluate((ref) => window.__aph__.click(ref), more.ref);
    console.log('\nclick', more.ref, JSON.stringify(result));
    await page.waitForURL((u) => u.href !== before);
    console.log('now at', page.url());
  }
  await browser.close();
})();
