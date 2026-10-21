'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { setup, refOf } = require('./setup.js');

let t;
test.before(async () => { t = await setup(); });
test.after(async () => { await t.close(); });

async function submitReact() {
  await t.page.click('button[type=submit]');
  return t.page.evaluate(() => window.__result);
}

test('fixture check: plain value assignment does not reach React state', async () => {
  await t.open('react-controlled.html', { wait: '#email' });
  await t.page.evaluate(() => {
    const el = document.getElementById('email');
    el.value = 'naive@example.com';
    el.dispatchEvent(new Event('input', { bubbles: true }));
  });
  assert.equal((await submitReact()).email, '');
});

test('fill, select and setChecked update React state', async () => {
  await t.open('react-controlled.html', { wait: '#email' });
  const s = await t.snapshot();
  const fill = await t.call('fill', refOf(s, 'textbox', 'Email'), 'agent@example.com');
  assert.deepEqual(fill, { ok: true, ref: refOf(s, 'textbox', 'Email'), value: 'agent@example.com' });
  assert.equal((await t.call('select', refOf(s, 'combobox', 'Plan'), 'Team')).ok, true);
  const check = await t.call('setChecked', refOf(s, 'checkbox', 'Send me product updates'), true);
  assert.equal(check.changed, true);
  assert.deepEqual(await submitReact(), { email: 'agent@example.com', plan: 'team', updates: true });
});

test('fill blurs by default so blur-time validation runs', async () => {
  await t.open('react-controlled.html', { wait: '#email' });
  const email = refOf(await t.snapshot(), 'textbox', 'Email');
  await t.call('fill', email, 'not-an-email', { blur: false });
  assert.equal(await t.page.textContent('#email-err'), '');
  await t.call('fill', email, 'still-not-an-email');
  assert.equal(await t.page.textContent('#email-err'), 'Enter a valid email address');
  const errors = await t.call('errors');
  assert.ok(errors.some((e) => e.kind === 'aria-invalid' && e.message === 'Enter a valid email address'), JSON.stringify(errors));
});

test('fill works on textarea and select inside a same-origin iframe', async () => {
  await t.open('nested-frames.html');
  const s = await t.snapshot();
  const notes = refOf(s, 'textbox', 'Notes');
  const r = await t.call('fill', notes, 'Leave at the door');
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal((await t.call('select', refOf(s, 'combobox', 'Delivery'), 'Express')).ok, true);
  const outer = t.page.frames().find((f) => f.url().endsWith('/frames/outer.html'));
  assert.equal(await outer.inputValue('textarea'), 'Leave at the door');
  assert.equal(await outer.inputValue('select'), 'Express');
});

test('coupon in a doubly nested frame can be filled and applied by ref', async () => {
  await t.open('nested-frames.html');
  const s = await t.snapshot();
  assert.equal((await t.call('fill', refOf(s, 'textbox', 'Coupon code'), 'SPRING24')).ok, true);
  assert.equal((await t.call('click', refOf(s, 'button', 'Apply'))).ok, true);
  assert.deepEqual(await t.page.evaluate(() => window.__result), { coupon: 'SPRING24' });
});

test('actions refuse unsupported, read-only and disabled controls', async () => {
  await t.open('forms.html');
  const s = await t.snapshot();
  const news = s.elements.find((e) => e.role === 'checkbox' && e.name === 'News').ref;
  assert.equal((await t.call('fill', news, 'x')).error.code, 'UNSUPPORTED_CONTROL');
  assert.equal((await t.call('fill', refOf(s, 'textbox', 'Bio'), 'x')).error.code, 'READONLY');
  assert.equal((await t.call('click', refOf(s, 'button', 'Delete account'))).error.code, 'DISABLED');
  const age = await t.call('fill', refOf(s, 'spinbutton', 'Age'), 'forty');
  assert.equal(age.error.code, 'VALUE_REJECTED');
  const free = s.elements.find((e) => e.role === 'radio' && e.name === 'Free').ref;
  assert.equal((await t.call('setChecked', free, false)).error.code, 'UNSUPPORTED_CONTROL');
  assert.equal((await t.call('select', refOf(s, 'textbox', 'Username'), 'x')).error.code, 'UNSUPPORTED_CONTROL');
});

test('select reports the available options when one is missing', async () => {
  await t.open('react-controlled.html', { wait: '#email' });
  const r = await t.call('select', refOf(await t.snapshot(), 'combobox', 'Plan'), 'Platinum');
  assert.equal(r.error.code, 'OPTION_NOT_FOUND');
  assert.deepEqual(r.error.options, ['Free', 'Team', 'Enterprise']);
});

test('setChecked works through a styled label over a hidden checkbox', async () => {
  await t.open('forms.html');
  const terms = refOf(await t.snapshot(), 'checkbox', 'Accept the terms');
  const r = await t.call('setChecked', terms, true);
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(await t.page.isChecked('#terms'), true);
});

test('setChecked inside a frameset frame', async () => {
  await t.open('frameset.html');
  const s = await t.snapshot();
  assert.equal((await t.call('setChecked', refOf(s, 'checkbox', 'I have read this lesson'), true)).ok, true);
  assert.equal((await t.call('click', refOf(s, 'button', 'Next lesson'))).ok, true);
  assert.deepEqual(await t.page.evaluate(() => window.__result), { completed: 1 });
});

test('fill on a contenteditable region goes through the editing pipeline', async () => {
  await t.open('forms.html');
  const editor = refOf(await t.snapshot(), 'textbox', 'Notes editor');
  const r = await t.call('fill', editor, 'Call back on Monday');
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(await t.page.innerText('#editor'), 'Call back on Monday');
  assert.ok(await t.page.evaluate(() => window.__editorInputs) > 0);
});

test('inspect returns details, options and validation state', async () => {
  await t.open('forms.html');
  const s = await t.snapshot();
  const info = await t.call('inspect', refOf(s, 'textbox', 'Username'));
  assert.equal(info.ok, true);
  assert.equal(info.tag, 'input');
  assert.equal(info.required, true);
  assert.equal(info.hit, 'clear');
  assert.equal(info.attributes.name, 'name');
  assert.equal(info.validationMessage.length > 0, true);
});

test('focus reports success for an input inside a shadow root', async () => {
  await t.open('shadow.html');
  const r = await t.call('focus', refOf(await t.snapshot(), 'textbox', 'Work email'));
  assert.deepEqual(r.ok && r.focused, true);
});
