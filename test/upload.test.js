'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { setup } = require('./setup.js');
const { uploadFile, UploadError } = require('../playwright.js');

let t;
let dir;
let file;
test.before(async () => {
  t = await setup();
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aph-upload-'));
  file = path.join(dir, 'report.pdf');
  fs.writeFileSync(file, '%PDF-1.4\n% test file\n');
});
test.after(async () => {
  await t.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

const state = () => t.page.evaluate(() => ({ result: window.__result, changes: window.__changes }));

for (const [mode, via] of [['chooser', 'filechooser'], ['lazy', 'input'], ['detached', 'filechooser']]) {
  test(`trigger by name, mode=${mode}`, async () => {
    await t.page.goto(t.url(`upload.html?mode=${mode}`));
    const r = await uploadFile(t.page, file, { trigger: 'Browse files' });
    assert.deepEqual(r, { ok: true, via, files: ['report.pdf'] });
    assert.deepEqual(await state(), { result: { files: ['report.pdf'] }, changes: 1 });
    assert.equal(t.page.listenerCount('filechooser'), 0);
  });
}

test('without options it finds the only upload-looking trigger', async () => {
  await t.page.goto(t.url('upload.html?mode=lazy'));
  await t.page.evaluate(() => document.getElementById('broken').remove());
  const r = await uploadFile(t.page, file);
  assert.equal(r.ok, true);
  assert.deepEqual((await state()).result, { files: ['report.pdf'] });
});

test('an explicit input locator skips the trigger', async () => {
  await t.page.setContent('<input type="file" id="a"><input type="file" id="b">');
  const r = await uploadFile(t.page, file, { input: '#b' });
  assert.equal(r.via, 'input');
  assert.deepEqual(await t.page.evaluate(() => [document.getElementById('a').files.length, document.getElementById('b').files.length]), [0, 1]);
});

test('ambiguous or missing targets fail instead of guessing', async () => {
  await t.page.setContent('<input type="file"><input type="file">');
  await assert.rejects(uploadFile(t.page, file), (e) => e instanceof UploadError && e.code === 'AMBIGUOUS_TARGET');
  await t.page.setContent('<button>Upload photo</button><button>Upload video</button>');
  await assert.rejects(uploadFile(t.page, file), (e) => e.code === 'AMBIGUOUS_TARGET' && /Upload photo/.test(e.message));
  await t.page.setContent('<p>No uploads here</p>');
  await assert.rejects(uploadFile(t.page, file), (e) => e.code === 'NO_TARGET');
});

test('a trigger that does nothing times out and leaves no listener behind', async () => {
  await t.page.goto(t.url('upload.html?mode=chooser'));
  await assert.rejects(uploadFile(t.page, file, { trigger: 'Attach later', timeout: 600 }), (e) => e.code === 'TIMEOUT');
  assert.equal(t.page.listenerCount('filechooser'), 0);
  // A dialog opened later is not answered with our file.
  const [chooser] = await Promise.all([t.page.waitForEvent('filechooser'), t.page.click('#browse')]);
  assert.equal(await chooser.element().evaluate((el) => el.files.length), 0);
});

test('a widget that reuses its input works on the second upload too', async () => {
  await t.page.goto(t.url('upload.html?mode=lazy'));
  await uploadFile(t.page, file, { trigger: 'Browse files' });
  const second = path.join(dir, 'second.pdf');
  fs.writeFileSync(second, '%PDF-1.4\n% second\n');
  const r = await uploadFile(t.page, second, { trigger: 'Browse files', timeout: 2000 });
  assert.deepEqual(r, { ok: true, via: 'input', files: ['second.pdf'] });
});

test('concurrent uploads on one page run one after the other', async () => {
  await t.page.setContent(`
    <button id="a">Upload A</button><button id="b">Upload B</button>
    <script>
      for (const id of ['a', 'b']) {
        document.getElementById(id).addEventListener('click', () => {
          const input = document.createElement('input');
          input.type = 'file'; input.id = 'in-' + id;
          document.body.appendChild(input);
        });
      }
    </script>`);
  const other = path.join(dir, 'other.pdf');
  fs.writeFileSync(other, '%PDF-1.4\n% other\n');
  const [ra, rb] = await Promise.all([
    uploadFile(t.page, file, { trigger: 'Upload A' }),
    uploadFile(t.page, other, { trigger: 'Upload B' }),
  ]);
  assert.deepEqual([ra.files, rb.files], [['report.pdf'], ['other.pdf']]);
  assert.deepEqual(await t.page.evaluate(() => [document.getElementById('in-a').files[0].name, document.getElementById('in-b').files[0].name]), ['report.pdf', 'other.pdf']);
});

test('a trigger that adds two file inputs is ambiguous', async () => {
  await t.page.setContent(`
    <button id="t">Attach files</button>
    <script>
      document.getElementById('t').addEventListener('click', () => {
        for (let i = 0; i < 2; i++) { const x = document.createElement('input'); x.type = 'file'; document.body.appendChild(x); }
      });
    </script>`);
  await assert.rejects(uploadFile(t.page, file, { trigger: 'Attach files' }), (e) => e.code === 'AMBIGUOUS_TARGET');
});

test('an unrelated file input elsewhere on the page is not reused', async () => {
  await t.page.setContent(`
    <form id="profile"><input type="file" id="avatar"></form>
    <div id="widget"><button id="t">Attach report</button></div>
    <script>
      document.getElementById('t').addEventListener('click', () => {
        setTimeout(() => {
          const x = document.createElement('input'); x.type = 'file'; x.id = 'late';
          document.getElementById('widget').appendChild(x);
        }, 800);
      });
    </script>`);
  const r = await uploadFile(t.page, file, { trigger: 'Attach report', timeout: 3000 });
  assert.equal(r.via, 'input');
  assert.deepEqual(await t.page.evaluate(() => [document.getElementById('avatar').files.length, document.getElementById('late').files.length]), [0, 1]);
});

test('a second input added a moment after the first makes the trigger ambiguous', async () => {
  await t.page.setContent(`
    <button id="t">Attach files</button>
    <script>
      document.getElementById('t').addEventListener('click', () => {
        const add = () => { const x = document.createElement('input'); x.type = 'file'; document.body.appendChild(x); };
        add(); setTimeout(add, 100);
      });
    </script>`);
  await assert.rejects(uploadFile(t.page, file, { trigger: 'Attach files' }), (e) => e.code === 'AMBIGUOUS_TARGET');
});

test('a trigger locator inside an iframe works with a detached file dialog', async () => {
  await t.page.goto(t.url('report.html'));
  await t.page.setContent(`<iframe id="f" src="${t.url('upload.html?mode=detached')}"></iframe>`);
  const frame = t.page.frameLocator('#f');
  await frame.getByRole('button', { name: 'Browse files' }).waitFor();
  const r = await uploadFile(t.page, file, { trigger: frame.getByRole('button', { name: 'Browse files' }) });
  assert.deepEqual(r, { ok: true, via: 'filechooser', files: ['report.pdf'] });
});
