'use strict';
// File upload for pages that do not ship a plain <input type=file>.
// Covers: native file dialogs (pre-armed filechooser), hidden or lazily created
// inputs (click a trigger first), and framework-controlled inputs (setInputFiles
// bypasses overridden .files setters). Pure drop zones are not handled.

const DEFAULT_TRIGGER = /파일찾기|파일 ?선택|첨부|업로드|찾아보기|browse|choose file|select file|upload|attach/i;

async function uploadFile(page, file, trigger = DEFAULT_TRIGGER) {
  // If the trigger opens a native file dialog, answer it without blocking.
  page.once('filechooser', (fc) => fc.setFiles(file).catch(() => {}));
  let input = page.locator('input[type=file]');
  if ((await input.count()) === 0) {
    // No input yet: click a likely trigger to open a dialog or materialize a hidden input.
    const trg = page.getByRole('button', { name: trigger })
      .or(page.locator('label, a, [class*=upload i], [class*=attach i]').filter({ hasText: trigger }));
    await trg.first().click({ timeout: 4000 }).catch(() => {});
    await page.waitForTimeout(800);
    input = page.locator('input[type=file]');
  }
  const count = await input.count();
  if (count === 0) return { ok: false, reason: 'no input[type=file] found (pure drop zone?)' };
  let setError = null;
  try { await input.first().setInputFiles(file); } catch (e) { setError = String(e).split('\n')[0]; }
  await page.waitForTimeout(300);
  const files = await input.first().evaluate((el) => [...el.files].map((f) => f.name)).catch(() => []);
  return { ok: files.length > 0, files, inputs: count, setError };
}

module.exports = { uploadFile, DEFAULT_TRIGGER };
