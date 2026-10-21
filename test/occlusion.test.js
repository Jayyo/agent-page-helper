'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { setup, refOf } = require('./setup.js');

let t;
test.before(async () => { t = await setup(); });
test.after(async () => { await t.close(); });

test('a button under a fixed banner is reported as covered, with the banner ref', async () => {
  const text = await t.open('occluded.html');
  assert.match(text, /^\[([a-z]{4}\d+)\] button "Save changes" covered-by=\[[a-z]{4}\d+\] div#consent$/m);
  const s = await t.snapshot();
  const save = s.elements.find((e) => e.name === 'Save changes');
  assert.equal(save.hit, 'covered');
  const banner = await t.call('inspect', save.coveredByRef);
  assert.equal(banner.attributes.id, 'consent');
});

test('click refuses a covered element unless forced', async () => {
  await t.open('occluded.html');
  const s = await t.snapshot();
  const save = refOf(s, 'button', 'Save changes');
  const r = await t.call('click', save);
  assert.equal(r.ok, false);
  assert.equal(r.error.code, 'OCCLUDED');
  assert.equal(r.error.coveredBy, 'div#consent');
  assert.equal(await t.page.evaluate(() => window.__result), undefined);
  // Dismiss the banner, then the same ref works.
  assert.equal((await t.call('click', refOf(s, 'button', 'Accept all'))).ok, true);
  assert.equal((await t.call('click', save)).ok, true);
  assert.deepEqual(await t.page.evaluate(() => window.__result), { saved: true, trusted: false });
});

test('force: true clicks through the overlay as an untrusted DOM click', async () => {
  await t.open('occluded.html');
  const save = refOf(await t.snapshot(), 'button', 'Save changes');
  assert.equal((await t.call('click', save, { force: true })).ok, true);
  assert.equal((await t.page.evaluate(() => window.__result)).trusted, false);
});

test('elements inside open shadow roots are not covered by their own host', async () => {
  await t.open('shadow.html');
  const s = await t.snapshot();
  assert.equal(s.elements.find((e) => e.name === 'Subscribe').hit, 'clear');
  assert.equal(s.elements.find((e) => e.name === 'Work email').hit, 'clear');
});

test('an element inside an iframe is covered when the parent page draws over the iframe', async () => {
  await t.page.setContent(`
    <iframe id="f" style="width:400px;height:200px;border:0" srcdoc="<button>Inner</button><button style='margin-left:300px'>Right</button>"></iframe>
    <div id="cover" style="position:absolute;left:0;top:0;width:150px;height:150px;background:#eee"></div>`);
  await t.page.waitForFunction(() => document.getElementById('f').contentDocument.querySelector('button'));
  const s = await t.snapshot();
  const inner = s.elements.find((e) => e.name === 'Inner');
  assert.equal(inner.hit, 'covered');
  assert.equal(inner.coveredBy, 'div#cover');
  assert.equal(s.elements.find((e) => e.name === 'Right').hit, 'clear');
});

test('offscreen elements are marked offscreen, not covered', async () => {
  await t.open('long-noisy.html');
  const s = await t.snapshot({ maxElements: Infinity });
  assert.equal(s.elements.find((e) => e.name === 'Careers').hit, 'offscreen');
});
