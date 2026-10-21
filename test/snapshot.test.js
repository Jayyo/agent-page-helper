'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { setup, refOf } = require('./setup.js');

let t;
test.before(async () => { t = await setup(); });
test.after(async () => { await t.close(); });

test('text snapshot lists controls with names, values and state', async () => {
  const text = await t.open('react-controlled.html', { wait: '#email' });
  assert.match(text, /^page "Controlled inputs \(React 18\)" http:\/\/127\.0\.0\.1:\d+\/react-controlled\.html$/m);
  assert.match(text, /^h1 "Create account"$/m);
  assert.match(text, /^\[[a-z]{4}\d+\] textbox "Email" type=email placeholder="you@example\.com"$/m);
  assert.match(text, /^\[[a-z]{4}\d+\] combobox "Plan" value="Free"$/m);
  assert.match(text, /^\[[a-z]{4}\d+\] checkbox "Send me product updates" unchecked$/m);
  assert.match(text, /^\[[a-z]{4}\d+\] button "Sign up"$/m);
});

test('refs stay the same across snapshots and re-renders', async () => {
  await t.open('react-controlled.html', { wait: '#email' });
  const a = await t.snapshot();
  const email = refOf(a, 'textbox', 'Email');
  assert.equal((await t.call('fill', email, 'x@example.com')).ok, true);
  const b = await t.snapshot();
  assert.equal(refOf(b, 'textbox', 'Email'), email);
  assert.equal(refOf(b, 'button', 'Sign up'), refOf(a, 'button', 'Sign up'));
});

test('a ref from a previous page load is rejected, not reused', async () => {
  await t.open('react-controlled.html', { wait: '#email' });
  const old = refOf(await t.snapshot(), 'button', 'Sign up');
  await t.page.reload();
  await t.page.waitForSelector('#email');
  const r = await t.call('click', old);
  assert.equal(r.ok, false);
  assert.equal(r.error.code, 'WRONG_DOCUMENT');
  const bad = await t.call('click', 'e12');
  assert.equal(bad.error.code, 'BAD_REF');
});

test('a ref to a removed element reports STALE_REF', async () => {
  await t.open('occluded.html');
  const accept = refOf(await t.snapshot(), 'button', 'Accept all');
  await t.page.evaluate(() => document.getElementById('consent').remove());
  const r = await t.call('click', accept);
  assert.equal(r.error.code, 'STALE_REF');
});

test('names come from wrapping labels, for= labels inside shadow roots and aria-labelledby', async () => {
  const lesson = await t.open('frameset.html');
  assert.match(lesson, /checkbox "I have read this lesson" unchecked/);
  const shadow = await t.open('shadow.html');
  assert.match(shadow, /textbox "Work email" type=email/);
  await t.page.setContent(`
    <span id="a">Billing</span><span id="b">address</span>
    <input aria-labelledby="a b">
    <label>Country <select><option>Korea</option><option>Japan</option></select></label>`);
  const s = await t.snapshot();
  assert.equal(s.elements[0].name, 'Billing address');
  assert.equal(s.elements[1].name, 'Country');
  assert.equal(s.elements[1].value, 'Korea');
});

test('page text cannot forge snapshot lines', async () => {
  const text = await t.open('forms.html');
  const line = text.split('\n').find((l) => l.includes('Say'));
  assert.match(line, /button "Say \\"hi\\" \[zzz1\] button \\"Pay\\""/);
  assert.ok(!text.split('\n').some((l) => /^\s*\[zzz1\]/.test(l)));
});

test('password, one-time code and card values are masked', async () => {
  await t.open('forms.html');
  await t.page.fill('#pw', 'hunter22');
  await t.page.fill('#card', '4111111111111111');
  const s = await t.snapshot();
  assert.equal(s.elements.find((e) => e.name === 'Password').value, '[masked:8]');
  assert.equal(s.elements.find((e) => e.name === 'Card number').value, '[masked:16]');
  const json = JSON.stringify(s);
  assert.ok(!json.includes('hunter22') && !json.includes('4111111111111111'));
});

test('inherited cursor:pointer does not duplicate clickable cards', async () => {
  await t.open('long-noisy.html');
  const s = await t.snapshot({ maxElements: Infinity });
  const cards = s.elements.filter((e) => e.tag === 'div');
  assert.equal(cards.length, 40);
  assert.ok(!s.elements.some((e) => e.tag === 'span' || e.tag === 'small'));
  assert.ok(!s.elements.some((e) => e.role === 'iframe' || e.tag === 'iframe'));
});

test('the element cap keeps what is in the viewport and says what it dropped', async () => {
  await t.open('long-noisy.html');
  const s = await t.snapshot({ maxElements: 30 });
  assert.equal(s.elements.length, 30);
  assert.ok(s.stats.found > 150);
  const names = s.elements.map((e) => e.name);
  assert.ok(names.includes('Daily Ledger home') && names.includes('Search'));
  assert.ok(!names.includes('Careers') && !names.includes('Load more comments'), 'elements far below the fold should be dropped first');
  const text = await t.page.evaluate(() => window.__aph__.snapshot({ format: 'text', maxElements: 30 }));
  assert.match(text, new RegExp(`^listed 30 of ${s.stats.found} interactive elements`, 'm'));
});

test('snapshot can be scoped to a subtree', async () => {
  await t.open('long-noisy.html');
  const s = await t.snapshot({ root: '#comments' });
  assert.ok(s.elements.length > 0);
  assert.ok(s.elements.every((e) => ['Reply', 'Like comment', 'Report', 'Load more comments'].includes(e.name)), JSON.stringify(s.elements.slice(0, 3)));
  assert.equal(s.text, '');
});

test('frames are entered when same-origin and reported when not', async () => {
  const nested = await t.open('nested-frames.html');
  assert.match(nested, /^frame 1 "Checkout" \/frames\/outer\.html$/m);
  assert.match(nested, /^ {2}frame 2 "Promotions" \/frames\/inner\.html$/m);
  assert.match(nested, /^ {4}\[[a-z]{4}\d+\] textbox "Coupon code"$/m);
  const cross = await t.open('cross-origin.html');
  assert.match(cross, /^frame 1 "Promotions" http:\/\/localhost:\d+\/frames\/inner\.html \(cross-origin, not traversed\)$/m);
  const frames = await t.call('frames');
  assert.equal(frames[0].access, 'cross-origin');
});

test('find and query cross frames and shadow roots', async () => {
  await t.open('nested-frames.html');
  const found = await t.call('find', 'coupon');
  assert.equal(found[0].role, 'textbox');
  assert.equal(found[0].frame, 2);
  const q = await t.call('query', 'button');
  assert.deepEqual(q.map((e) => e.name), ['Apply']);
  await t.open('shadow.html');
  const sq = await t.call('query', 'input[type=email]');
  assert.equal(sq.length, 1);
  assert.equal(sq[0].name, 'Work email');
  await assert.rejects(t.call('query', 'button[['), /not a valid selector|SyntaxError/);
});

test('viewport-first ranking measures frame contents from the top window', async () => {
  // The iframe comes first in document order but sits far below the fold.
  await t.page.setContent(`
    <iframe style="position:absolute;top:3000px;width:400px;height:300px;border:0"
      srcdoc="${Array.from({ length: 8 }, (_, i) => `<button>Far ${i}</button>`).join('')}"></iframe>
    ${Array.from({ length: 5 }, (_, i) => `<button>Near ${i}</button>`).join('')}`);
  await t.page.waitForFunction(() => document.querySelector('iframe').contentDocument.querySelectorAll('button').length === 8);
  const s = await t.snapshot({ maxElements: 5 });
  assert.deepEqual(s.elements.map((e) => e.name), ['Near 0', 'Near 1', 'Near 2', 'Near 3', 'Near 4']);
});

test('controls scrolled out of view inside an iframe rank as offscreen', async () => {
  // The iframe is on screen, but its first buttons sit below its own 100px viewport.
  await t.page.setContent(`
    <iframe style="width:400px;height:100px;border:0"
      srcdoc="<div style='height:500px'></div>${Array.from({ length: 3 }, (_, i) => `<button>Clipped ${i}</button>`).join('')}"></iframe>
    <div style="height:1200px"></div><button>Below the fold</button>
    <button style="position:fixed;top:300px;left:0">Visible</button>`);
  await t.page.waitForFunction(() => document.querySelector('iframe').contentDocument.querySelectorAll('button').length === 3);
  const s = await t.snapshot({ maxElements: 1 });
  assert.deepEqual(s.elements.map((e) => e.name), ['Visible']);
});

test('SVG links report an absolute href resolved against the base URL', async () => {
  await t.page.goto(t.url('report.html'));
  await t.page.evaluate(() => {
    const base = document.createElement('base'); base.href = '/assets/'; document.head.appendChild(base);
    document.body.insertAdjacentHTML('beforeend', '<svg width="80" height="20"><a href="help"><text x="0" y="15">Help</text></a></svg>');
  });
  const link = (await t.snapshot()).elements.find((e) => e.role === 'link');
  assert.equal(new URL(link.href).pathname, '/assets/help');
});
