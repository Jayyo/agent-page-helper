'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { setup } = require('./setup.js');

let t;
test.before(async () => { t = await setup(); });
test.after(async () => { await t.close(); });

test('formState masks secrets, skips hidden inputs and survives DOM clobbering', async () => {
  await t.open('forms.html');
  await t.page.fill('#user', 'mina');
  await t.page.fill('#pw', 'hunter22');
  await t.page.fill('#card', '4111 1111 1111 1111');
  const [form] = await t.call('formState');
  assert.equal(form.name, 'account');
  assert.match(form.action, /\/save$/);
  assert.deepEqual(form.fields, {
    name: 'mina',
    password: '[masked:8]',
    card: '[masked:19]',
    bio: 'Fixed text',
    zip: 'ABC',
    topic: ['news', 'jobs'],
    plan: 'free',
  });
  const withHidden = await t.call('formState', '#account', { includeHidden: true });
  assert.equal(withHidden[0].fields.action, 'update');
  assert.equal(withHidden[0].fields.csrf, 'tok-123');
});

test('formState accepts a ref and returns the editable region of pages without forms', async () => {
  await t.page.setContent('<div id="w"><label>City <input name="city" value="Sejong"></label></div>');
  const all = await t.call('formState');
  assert.deepEqual(all[0].fields, { city: 'Sejong' });
  const [hit] = await t.call('query', '#w');
  const scoped = await t.call('formState', hit.ref);
  assert.deepEqual(scoped[0].fields, { city: 'Sejong' });
});

test('errors() reports constraint, aria-invalid and rendered messages', async () => {
  await t.open('forms.html');
  let errors = await t.call('errors');
  const zip = errors.find((e) => e.field === 'zip');
  assert.equal(zip.kind, 'aria-invalid');
  assert.equal(zip.message, 'Postcode must be 5 digits');
  const user = errors.find((e) => e.field === 'name');
  assert.equal(user.kind, 'constraint');
  assert.equal(user.userInvalid, false);
  // After a submit attempt the browser marks the fields as user-invalid.
  await t.page.click('#save');
  errors = await t.call('errors');
  assert.equal(errors.find((e) => e.field === 'name').userInvalid, true);
  assert.ok(!errors.some((e) => e.kind === 'message' && e.message === 'Postcode must be 5 digits'), 'message already attached to the field should not repeat');
});

test('masking ignores autocomplete case and covers selects and hidden inputs', async () => {
  await t.page.setContent(`
    <form>
      <input name="cc" autocomplete="CC-NUMBER" value="4111111111111111">
      <select name="year" autocomplete="cc-exp-year"><option>2031</option></select>
      <input type="hidden" name="otp" autocomplete="one-time-code" value="123456">
    </form>`);
  const [form] = await t.call('formState', undefined, { includeHidden: true });
  assert.deepEqual(form.fields, { cc: '[masked:16]', year: '[masked:4]', otp: '[masked:6]' });
  // Field values are masked; visible page text (the select's label) is not.
  const snap = await t.snapshot();
  const elements = JSON.stringify(snap.elements);
  assert.ok(!elements.includes('4111111111111111') && !elements.includes('2031'), elements);
  const year = await t.call('inspect', snap.elements.find((e) => e.role === 'combobox').ref);
  assert.equal(year.value, '[masked:4]');
  assert.equal(year.options, undefined);
});

test('form controls named like form properties do not break the walk or formState', async () => {
  await t.page.setContent(`
    <form id="f" action="/go">
      <input name="hidden" value="h">
      <input name="elements" value="e">
      <input name="id" value="i">
      <input name="constructor" value="c">
      <input name="__proto__" value="p">
      <button>Go</button>
    </form>`);
  const s = await t.snapshot();
  assert.equal(s.elements.length, 6, JSON.stringify(s.elements));
  const [form] = await t.call('formState');
  assert.equal(form.name, 'f');
  assert.match(form.action, /\/go$/);
  assert.equal(form.fields.constructor, 'c');
  // Checked in the page: Playwright drops a "__proto__" key when it copies the result back.
  const keys = await t.page.evaluate(() => Object.keys(window.__aph__.formState()[0].fields).sort());
  assert.deepEqual(keys, ['__proto__', 'constructor', 'elements', 'hidden', 'id']);
});
