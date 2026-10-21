'use strict';
// Fixture tasks for the capability matrix. Every strategy gets a fresh page and
// returns normally on success or throws; the runner then checks the page state.
//
// Strategies:
//   dom        plain DOM calls from page JS: querySelector / label lookup,
//              el.value = ..., el.click(). The common first attempt when an agent
//              only has an evaluate() channel.
//   helper     the helper from the top frame: snapshot -> ref -> fill/click.
//   helper/frames  the helper called in every frame (frame.evaluate per frame).
//   playwright page.ariaSnapshot({ mode: 'ai' }) -> page.getByRef(ref) -> fill/click.
//   Upload rows compare Playwright recipes with uploadFile().

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { uploadFile } = require('../playwright.js');

const ACTION_TIMEOUT = 2000;

function escapeRe(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

async function aiRef(page, role, name) {
  const snap = await page.ariaSnapshot({ mode: 'ai' });
  const m = snap.match(new RegExp(`${role} "${escapeRe(name)}"[^\\n]*?\\[ref=([a-z0-9]+)\\]`));
  if (!m) throw new Error(`${role} "${name}" is not in the AI snapshot`);
  return m[1];
}

async function helperRef(page, role, name) {
  const s = await page.evaluate(() => window.__aph__.snapshot());
  const el = s.elements.find((e) => e.role === role && e.name === name);
  if (!el) throw new Error(`${role} "${name}" is not in the helper snapshot`);
  return el.ref;
}

async function helperCall(page, method, ...args) {
  const r = await page.evaluate(([m, a]) => window.__aph__[m](...a), [method, args]);
  if (r && r.ok === false) throw new Error(`${method}: ${r.error.code} ${r.error.message}`);
  return r;
}

// Plain DOM: find a control by its label text in the top document only.
const domFill = (page, label, value) => page.evaluate(([l, v]) => {
  const lab = [...document.querySelectorAll('label')].find((x) => x.textContent.trim().startsWith(l));
  const el = lab && (lab.control || lab.querySelector('input,textarea,select'));
  if (!el) throw new Error(`no field labelled "${l}" in document`);
  el.value = v;
  el.dispatchEvent(new Event('input', { bubbles: true }));
  el.dispatchEvent(new Event('change', { bubbles: true }));
}, [label, value]);
const domClick = (page, text) => page.evaluate((t) => {
  const b = [...document.querySelectorAll('button')].find((x) => x.textContent.trim() === t);
  if (!b) throw new Error(`no button "${t}" in document`);
  b.click();
}, text);
const domCheck = (page, label) => page.evaluate((l) => {
  const lab = [...document.querySelectorAll('label')].find((x) => x.textContent.trim().startsWith(l));
  const el = lab && (lab.control || lab.querySelector('input'));
  if (!el) throw new Error(`no checkbox labelled "${l}" in document`);
  el.checked = true;
  el.dispatchEvent(new Event('change', { bubbles: true }));
}, label);

// Waits up to a second for the page to reach the expected state (some fixtures
// report through postMessage). Returns true, or a short reason.
async function expect(page, fn, arg, reason = 'the action ran, but the page did not get the value') {
  try {
    await page.waitForFunction(fn, arg, { timeout: 1000 });
    return true;
  } catch (e) {
    return reason;
  }
}

// Each form task: fill one field and press one button (optionally tick a box first).
function formTask(id, title, file, steps, check) {
  const strategies = {
    dom: async (page) => {
      for (const s of steps) {
        if (s.fill) await domFill(page, s.fill[1], s.fill[2]);
        if (s.check) await domCheck(page, s.check[1]);
        if (s.click) await domClick(page, s.click[1]);
      }
    },
    helper: async (page) => {
      for (const s of steps) {
        if (s.fill) await helperCall(page, 'fill', await helperRef(page, s.fill[0], s.fill[1]), s.fill[2]);
        if (s.check) await helperCall(page, 'setChecked', await helperRef(page, s.check[0], s.check[1]), true);
        if (s.click) await helperCall(page, 'click', await helperRef(page, s.click[0], s.click[1]));
      }
    },
    'helper/frames': async (page) => {
      // Same as helper, but ask every frame's own instance (needed for cross-origin frames).
      for (const s of steps) {
        const [kind, args] = s.fill ? ['fill', s.fill] : s.check ? ['setChecked', s.check] : ['click', s.click];
        let done = false;
        for (const frame of page.frames()) {
          const r = await frame.evaluate(([role, name]) => {
            const el = window.__aph__ && window.__aph__.snapshot().elements.find((e) => e.role === role && e.name === name);
            return el ? el.ref : null;
          }, args);
          if (!r) continue;
          const extra = kind === 'fill' ? [args[2]] : kind === 'setChecked' ? [true] : [];
          const res = await frame.evaluate(([m, a]) => window.__aph__[m](...a), [kind, [r, ...extra]]);
          if (res.ok === false) throw new Error(`${kind}: ${res.error.code}`);
          done = true;
          break;
        }
        if (!done) throw new Error(`${args[0]} "${args[1]}" not found in any frame`);
      }
    },
    playwright: async (page) => {
      for (const s of steps) {
        if (s.fill) await page.getByRef(await aiRef(page, s.fill[0], s.fill[1])).fill(s.fill[2], { timeout: ACTION_TIMEOUT });
        if (s.check) await page.getByRef(await aiRef(page, s.check[0], s.check[1])).check({ timeout: ACTION_TIMEOUT });
        if (s.click) await page.getByRef(await aiRef(page, s.click[0], s.click[1])).click({ timeout: ACTION_TIMEOUT });
      }
    },
  };
  return { id, title, file, strategies, check };
}

const tasks = [
  formTask('react', 'React 18 controlled input: fill email, submit', 'react-controlled.html',
    [{ fill: ['textbox', 'Email', 'agent@example.com'] }, { click: ['button', 'Sign up'] }],
    (page) => expect(page, () => window.__result && window.__result.email === 'agent@example.com', null, 'submitted, but React state still has the old value')),
  formTask('frames', 'Coupon field two same-origin iframes deep', 'nested-frames.html',
    [{ fill: ['textbox', 'Coupon code', 'SPRING24'] }, { click: ['button', 'Apply'] }],
    (page) => expect(page, () => window.__result && window.__result.coupon === 'SPRING24')),
  formTask('frameset', 'Checkbox and button inside a <frameset> page', 'frameset.html',
    [{ check: ['checkbox', 'I have read this lesson'] }, { click: ['button', 'Next lesson'] }],
    (page) => expect(page, () => window.__result && window.__result.completed === 1)),
  formTask('shadow-open', 'Field inside an open shadow root', 'shadow.html',
    [{ fill: ['textbox', 'Work email', 'me@example.com'] }, { click: ['button', 'Subscribe'] }],
    (page) => expect(page, () => window.__result && window.__result.open === 'me@example.com')),
  formTask('shadow-closed', 'Field inside a closed shadow root', 'shadow.html',
    [{ fill: ['textbox', 'Personal email', 'me@example.com'] }, { click: ['button', 'Subscribe'] }],
    (page) => expect(page, () => window.__result && window.__result.closed === 'me@example.com')),
  formTask('cross-origin', 'Coupon field in a cross-origin iframe', 'cross-origin.html',
    [{ fill: ['textbox', 'Coupon code', 'SPRING24'] }, { click: ['button', 'Apply'] }],
    (page) => expect(page, () => window.__result && window.__result.coupon === 'SPRING24')),
];

// Save under a cookie banner. Success means Save fired after the banner was
// dismissed, not through it.
const saved = async (page) => {
  const s = await page.evaluate(() => ({ saved: !!(window.__result && window.__result.saved), banner: !!document.getElementById('consent') }));
  if (s.saved && s.banner) return 'Save fired through the banner';
  return s.saved || 'not saved';
};
tasks.push({
  id: 'occluded',
  title: 'Save button under a cookie banner (dismiss first, then save)',
  file: 'occluded.html',
  check: saved,
  strategies: {
    dom: (page) => domClick(page, 'Save changes'),
    helper: async (page) => {
      const save = await helperRef(page, 'button', 'Save changes');
      const r = await page.evaluate((ref) => window.__aph__.click(ref), save);
      if (r.ok) return;
      if (r.error.code !== 'OCCLUDED') throw new Error(r.error.code);
      // Policy: press the first button inside whatever covers the target, then retry.
      const cover = await page.evaluate((ref) => window.__aph__.snapshot({ root: ref }), r.error.coveredByRef);
      const button = cover.elements.find((e) => e.role === 'button');
      if (!button) throw new Error('nothing to press in the covering element');
      await helperCall(page, 'click', button.ref);
      await helperCall(page, 'click', save);
    },
    playwright: async (page) => {
      const save = page.getByRef(await aiRef(page, 'button', 'Save changes'));
      try {
        await save.click({ timeout: ACTION_TIMEOUT });
      } catch (e) {
        // Same policy, driven by Playwright's actionability error, which names the
        // interceptor: "<button id=accept> from <div id=consent> subtree intercepts pointer events".
        const line = e.message.split('\n').find((l) => l.includes('intercepts pointer events'));
        if (!line) throw e;
        const owner = line.includes(' from <') ? line.slice(line.indexOf(' from <') + 6) : line;
        const id = /\bid="([^"]+)"/.exec(owner);
        if (!id) throw e;
        await page.locator(`#${id[1]}`).getByRole('button').first().click({ timeout: ACTION_TIMEOUT });
        await save.click({ timeout: ACTION_TIMEOUT });
      }
    },
  },
});

// Upload rows: the same widget in three shapes.
const FILE = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'aph-bench-')), 'report.pdf');
fs.writeFileSync(FILE, '%PDF-1.4\n% benchmark file\n');
const uploaded = async (page) => {
  const s = await page.evaluate(() => ({ files: window.__result ? window.__result.files.join() : '', changes: window.__changes }));
  if (s.files !== 'report.pdf') return 'no file on the input';
  return s.changes === 1 || `change fired ${s.changes} times`;
};
for (const mode of ['chooser', 'lazy', 'detached']) {
  tasks.push({
    id: `upload-${mode}`,
    title: {
      chooser: 'Upload: button adds an input and opens the file dialog',
      lazy: 'Upload: button adds a hidden input, no dialog',
      detached: 'Upload: dialog from an input never attached to the DOM',
    }[mode],
    file: `upload.html?mode=${mode}`,
    check: uploaded,
    strategies: {
      'setInputFiles': (page) => page.locator('input[type=file]').setInputFiles(FILE, { timeout: ACTION_TIMEOUT }),
      'click + setInputFiles': async (page) => {
        await page.getByRole('button', { name: 'Browse files' }).click();
        await page.locator('input[type=file]').setInputFiles(FILE, { timeout: ACTION_TIMEOUT });
      },
      'waitForEvent(filechooser)': async (page) => {
        const [chooser] = await Promise.all([
          page.waitForEvent('filechooser', { timeout: ACTION_TIMEOUT }),
          page.getByRole('button', { name: 'Browse files' }).click(),
        ]);
        await chooser.setFiles(FILE);
      },
      uploadFile: (page) => uploadFile(page, FILE, { trigger: 'Browse files', timeout: ACTION_TIMEOUT }),
    },
  });
}

module.exports = { tasks, FILE };
