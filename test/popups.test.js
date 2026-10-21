'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { setup, refOf } = require('./setup.js');

let t;
test.before(async () => { t = await setup(); });
test.after(async () => { await t.close(); });

test('window.open is untouched until capture is turned on', async () => {
  await t.open('popup.html');
  assert.equal(await t.page.evaluate(() => window.open.toString().includes('[native code]')), true);
  assert.deepEqual(await t.call('popups'), []);
});

test('record mode logs window.open and target=_blank and lets them open', async () => {
  await t.open('popup.html');
  await t.call('capturePopups', 'record');
  const s = await t.snapshot();
  const [popup] = await Promise.all([t.context.waitForEvent('page'), t.call('click', refOf(s, 'button', 'Open report'))]);
  await popup.close();
  const [tab] = await Promise.all([t.context.waitForEvent('page'), t.call('click', refOf(s, 'link', 'Report 7 (new tab)'))]);
  await tab.close();
  const log = await t.call('popups');
  assert.deepEqual(log.map((p) => [p.via, new URL(p.url).pathname + new URL(p.url).search]), [
    ['window.open', '/report.html?id=42'],
    ['link', '/report.html?id=7'],
  ]);
});

test('same-tab mode keeps the agent in one tab', async () => {
  await t.open('popup.html');
  await t.call('capturePopups', 'same-tab');
  const open = refOf(await t.snapshot(), 'button', 'Open report');
  await Promise.all([t.page.waitForURL(/report\.html\?id=42/), t.call('click', open)]);
  assert.equal(t.context.pages().length, 1);
});

test('block mode returns null like a popup blocker, off restores window.open', async () => {
  await t.open('popup.html');
  await t.call('capturePopups', 'block');
  await t.call('click', refOf(await t.snapshot(), 'button', 'Open report'));
  assert.equal(await t.page.textContent('#out'), 'blocked');
  assert.equal(t.context.pages().length, 1);
  await t.call('capturePopups', 'off');
  assert.equal(await t.page.evaluate(() => window.open.toString().includes('[native code]')), true);
  await assert.rejects(t.call('capturePopups', 'sometimes'), /unknown popup mode/);
});

test('dispose removes the global and restores window.open', async () => {
  await t.open('popup.html');
  await t.call('capturePopups', 'record');
  await t.call('dispose');
  assert.equal(await t.page.evaluate(() => typeof window.__aph__), 'undefined');
  assert.equal(await t.page.evaluate(() => window.open.toString().includes('[native code]')), true);
});

test('turning capture off does not break a page that wrapped window.open again', async () => {
  await t.open('popup.html');
  await t.call('capturePopups', 'record');
  await t.page.evaluate(() => {
    const inner = window.open;
    window.open = function (...args) { window.__wrapped = (window.__wrapped || 0) + 1; return inner.apply(window, args); };
  });
  await t.call('capturePopups', 'off');
  const [popup] = await Promise.all([t.context.waitForEvent('page'), t.page.evaluate(() => { window.open('report.html?id=1'); })]);
  await popup.close();
  assert.equal(await t.page.evaluate(() => window.__wrapped), 1);
  assert.deepEqual((await t.call('popups')).length, 0);
});

test('capture can be turned on again after the page replaced window.open', async () => {
  await t.open('popup.html');
  await t.call('capturePopups', 'record');
  await t.page.evaluate(() => {
    const native = Object.getPrototypeOf(window).open || window.open;
    window.open = function replaced(url) { window.__replaced = (window.__replaced || 0) + 1; return null; };
  });
  await t.call('capturePopups', 'off');
  await t.call('capturePopups', 'record');
  await t.page.evaluate(() => { window.open('report.html?id=9'); });
  const log = await t.call('popups');
  assert.equal(log.length, 1);
  assert.match(log[0].url, /id=9$/);
  assert.equal(await t.page.evaluate(() => window.__replaced), 1);
});
