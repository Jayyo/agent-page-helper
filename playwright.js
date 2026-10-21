'use strict';
// Playwright-side helpers. Nothing here imports Playwright itself: pass in your
// own BrowserContext, Page or Frame objects.
const core = require('./index.js');

// Registers the helper for every new document of `target` (a BrowserContext or a
// Page) and injects it into documents that are already open, frame by frame.
// The page-side script is idempotent: a frame that already has window.__aph__
// keeps it. Frames that go away during injection are reported, not thrown.
async function install(target, opts = {}) {
  await target.addInitScript({ path: core.helperPath });
  const report = { version: core.version, injected: 0, present: 0, mismatched: [], failed: [] };
  if (opts.existing === false) return report;
  const pages = typeof target.pages === 'function' ? target.pages() : [target];
  for (const page of pages) {
    for (const frame of page.frames()) {
      try {
        const before = await frame.evaluate(() => (window.__aph__ ? window.__aph__.version : null));
        if (before) {
          report.present++;
          if (before !== core.version) report.mismatched.push({ url: frame.url(), version: before });
          continue;
        }
        await frame.evaluate(core.helperSource);
        report.injected++;
      } catch (e) {
        report.failed.push({ url: frame.url(), error: String(e.message || e).split('\n')[0] });
      }
    }
  }
  return report;
}

class UploadError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'UploadError';
    this.code = code;
  }
}

// Labels used by upload buttons in the wild, Korean public-sector sites included.
const DEFAULT_TRIGGER = /파일\s?찾기|파일\s?선택|첨부|업로드|찾아보기|browse|choose files?|select files?|upload|attach/i;

function triggerLocator(scope, trigger) {
  if (trigger && typeof trigger.click === 'function' && typeof trigger.count === 'function') return trigger;
  if (typeof trigger !== 'string' && !(trigger instanceof RegExp)) throw new TypeError('trigger must be a Locator, a string or a RegExp');
  return scope.getByRole('button', { name: trigger })
    .or(scope.getByRole('link', { name: trigger }))
    .or(scope.locator('label').filter({ hasText: trigger, visible: true }));
}

async function fileNames(handle) {
  return handle.evaluate((el) => Array.from(el.files || [], (f) => f.name));
}

async function newInputs(scope, existing) {
  const all = await scope.locator('input[type=file]').elementHandles();
  const fresh = [];
  for (const h of all) {
    if (await h.evaluate((el, old) => old.includes(el), existing)) await h.dispose();
    else fresh.push(h);
  }
  return fresh;
}

// Only answer file choosers opened from the frame we clicked in.
async function chooserIn(choosers, frame) {
  for (const fc of choosers) {
    if ((await fc.element().ownerFrame()) === frame) return fc;
  }
  return null;
}

// An input that was already on the page is only reused when it sits next to the
// trigger (in one of its three nearest ancestors below <body>), not when it
// belongs to some other part of the page.
function nearTrigger(trigger, input) {
  return trigger.evaluate((t, el) => {
    let a = t.parentElement;
    for (let i = 0; i < 3 && a && a !== a.ownerDocument.body && a !== a.ownerDocument.documentElement; i++, a = a.parentElement) {
      if (a.contains(el)) return true;
    }
    return false;
  }, input);
}

// Uploads on one page run one at a time, so two calls never race for the same
// file chooser or the same new input.
const queues = new WeakMap();

// Puts `files` into a file input, whichever way the page builds it:
//  - an input that is already there ({ input } or the page's only file input),
//  - an input the trigger creates in the DOM, with or without opening a file dialog,
//  - a detached input that only shows up as a file chooser,
//  - a widget that reuses the input it created on an earlier click.
// Exactly one of setInputFiles / FileChooser.setFiles is used, and the
// filechooser listener is always removed again.
function uploadFile(page, files, opts = {}) {
  const previous = queues.get(page) || Promise.resolve();
  const run = previous.then(() => upload(page, files, opts));
  queues.set(page, run.catch(() => {}));
  return run;
}

async function upload(page, files, opts) {
  const timeout = opts.timeout ?? 5000;
  const scope = opts.frame || page;

  if (opts.input) {
    const input = typeof opts.input === 'string' ? scope.locator(opts.input) : opts.input;
    if ((await input.count()) > 1) throw new UploadError('AMBIGUOUS_TARGET', 'input matches more than one element');
    await input.setInputFiles(files, { timeout });
    return verify(await input.elementHandle({ timeout }), 'input');
  }

  let trigger = opts.trigger;
  if (!trigger) {
    const inputs = scope.locator('input[type=file]');
    const n = await inputs.count();
    if (n === 1) {
      await inputs.setInputFiles(files, { timeout });
      return verify(await inputs.elementHandle(), 'input');
    }
    if (n > 1) throw new UploadError('AMBIGUOUS_TARGET', `${n} file inputs on the page; pass { input } or { trigger }`);
    trigger = DEFAULT_TRIGGER;
  }
  const button = triggerLocator(scope, trigger);
  const matches = await button.count();
  if (matches === 0) throw new UploadError('NO_TARGET', `no upload trigger matching ${trigger}`);
  if (matches > 1) {
    const names = (await button.allInnerTexts()).map((t) => t.trim()).slice(0, 5);
    throw new UploadError('AMBIGUOUS_TARGET', `trigger matches ${matches} elements (${names.join(', ')}); pass a more specific trigger`);
  }

  // Work in the trigger's own frame: a Locator from frameLocator() lives in a child frame.
  const triggerHandle = await button.elementHandle({ timeout });
  const frame = await triggerHandle.ownerFrame();
  const existing = await frame.locator('input[type=file]').elementHandles();
  const reusable = existing.length === 1 && (await nearTrigger(triggerHandle, existing[0])) ? existing[0] : null;
  const choosers = [];
  const onChooser = (fc) => choosers.push(fc);
  let fresh = [];
  page.on('filechooser', onChooser);
  try {
    await button.click({ timeout });
    const start = Date.now();
    let chooser = null;
    while (Date.now() - start < timeout) {
      chooser = await chooserIn(choosers, frame);
      if (chooser) break;
      fresh = await newInputs(frame, existing);
      if (fresh.length) {
        // A dialog, or a second input, can arrive a moment after the first input.
        await page.waitForTimeout(150);
        chooser = await chooserIn(choosers, frame);
        await Promise.all(fresh.map((h) => h.dispose().catch(() => {})));
        fresh = await newInputs(frame, existing);
        break;
      }
      // Nothing new after a short wait: the widget may have reused its old input.
      if (reusable && Date.now() - start > 500) break;
      await page.waitForTimeout(50);
    }
    if (chooser) {
      await chooser.setFiles(files, { timeout });
      return verify(chooser.element(), 'filechooser');
    }
    if (fresh.length > 1) throw new UploadError('AMBIGUOUS_TARGET', `the trigger added ${fresh.length} file inputs`);
    const input = fresh[0] || reusable;
    if (input) {
      await input.setInputFiles(files, { timeout });
      return verify(input, 'input');
    }
    throw new UploadError('TIMEOUT', `clicking the trigger neither opened a file chooser nor added a file input within ${timeout} ms`);
  } finally {
    page.off('filechooser', onChooser);
    const handles = [triggerHandle, ...existing, ...fresh, ...choosers.map((fc) => fc.element())];
    await Promise.all(handles.map((h) => h.dispose().catch(() => {})));
  }
}

async function verify(handle, via) {
  try {
    const files = await fileNames(handle);
    if (!files.length) throw new UploadError('NOT_APPLIED', 'the input reports no files after setting them');
    return { ok: true, via, files };
  } finally {
    await handle.dispose().catch(() => {});
  }
}

module.exports = { install, uploadFile, UploadError, DEFAULT_TRIGGER };
