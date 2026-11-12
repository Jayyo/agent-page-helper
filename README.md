# agent-page-helper

Page-side snapshots and DOM actions for LLM browser agents.

`agent-page-helper.user.js` is one dependency-free script you inject into a page. It gives an agent a short list of the page's controls with refs, and actions that take those refs. This is real output for a test page where a cookie banner sits on top of the Save button:

```text
page "Profile settings" http://127.0.0.1:38637/occluded.html
h1 "Profile settings"
[yqkm1] textbox "Display name" value="Mina"
[yqkm2] button "Save changes" covered-by=[yqkm3] div#consent
[yqkm4] button "Accept all"
text: "Profile settings Display name Save changes We use cookies to keep you signed in. Accept all"
```

The same file works as a userscript (Tampermonkey, Violentmonkey) and as a plain script for Playwright's `addInitScript`, a raw CDP session, or anything else that can run JavaScript in the page. The package also has two Node helpers that came out of the same work: `uploadFile()` for upload widgets that only create their file input when you click them, and `cdp-probe`, which reports page targets that no longer answer CDP.

Status: 0.1. It started as a userscript that runs on every page in my browser; the API may still change.

In June 2026 I went back through 56 of my browser-automation sessions; 16 had quietly looped, using 3.4 times the calls on average and 12 times at worst. That evening I started this helper for stale refs, React inputs that reset after a fill, and government sites built on WebSquare and Nexacro. `cdp-probe` came later, after a print-preview tab left open for 13 hours froze every attach until I closed it.

## When to use it

If you drive the browser with Playwright 1.64 or later, start with `page.ariaSnapshot({ mode: 'ai' })` and `page.getByRef()`: an accessibility snapshot with refs that includes the contents of iframes, cross-origin ones too. Use this helper when:

- you want a bounded observation per step: at most 100 controls (closest to the viewport first), the headings, and 400 characters of main text. On the ten public pages below that came to a median of 1,413 tokens, against 13,443 for the AI snapshot.
- you can only run JavaScript in the page (CDP `Runtime.evaluate`, an extension, a userscript, Selenium's `execute_script`). There, assigning `input.value` does not reach React state, and `querySelector` does not enter frames or shadow roots.
- you want what the accessibility tree does not say: whether a control is covered and by what, which validation messages are showing, what a form holds right now (passwords masked), which popups the page tried to open.

## Quick start

Not on npm yet; install from GitHub:

```bash
npm install github:Jayyo/agent-page-helper
```

With Playwright (ESM shown; `require` works too):

```js
import { chromium } from 'playwright';
import { install } from 'agent-page-helper/playwright';

const browser = await chromium.launch();
const context = await browser.newContext();
await install(context);   // every page and frame in this context gets window.__aph__
const page = await context.newPage();
await page.goto('https://news.ycombinator.com/');

const observation = await page.evaluate(() => __aph__.snapshot({ format: 'text' }));
// ...send it to the model, which answers with something like { action: 'click', ref: 'dxtr3' }
const result = await page.evaluate((ref) => __aph__.click(ref), 'dxtr3');
if (!result.ok) console.log(result.error.code, result.error.message); // STALE_REF, OCCLUDED, ...
```

`install()` also injects the script into pages that were already open, so it works after `chromium.connectOverCDP()` to a browser you started yourself; see `examples/attach-over-cdp.js`.

Over a raw CDP session (this is what `test/install.test.js` does, without Playwright's evaluate):

```js
const { helperSource } = require('agent-page-helper');
await cdp.send('Page.addScriptToEvaluateOnNewDocument', { source: helperSource });
// after navigation:
const { result } = await cdp.send('Runtime.evaluate', {
  expression: '__aph__.snapshot({ format: "text" })',
  returnByValue: true,
});
```

As a userscript, install `agent-page-helper.user.js` in Tampermonkey or Violentmonkey. It runs at document-start with `@grant none`, so `window.__aph__` is visible to whatever automation evaluates code in the page. Puppeteer and Selenium should work the same way (inject the source, call the global), but they are not covered by the tests.

## Measurements

Numbers below come from `npm run bench:live` on 2026-10-22 with Chromium 156.0.8078.4 (Playwright 1.64.1), a 1280×800 viewport and locale en-US, each page in a fresh tab. Tokens are counted with js-tiktoken's `o200k_base` encoding (spot-checked against Python tiktoken, same counts). The public pages change all the time, so a rerun will give different numbers; the raw output is in [`bench/results/`](bench/results/).

### Snapshot size on ten public pages

`aria` is `page.ariaSnapshot()`, `ai` is `page.ariaSnapshot({ mode: 'ai' })`, `helper` is `__aph__.snapshot({ format: 'text' })` with defaults, and `helper, no cap` lifts the 100-control limit.

| page | aria | ai | helper | helper, no cap | helper / ai | controls listed / found |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| Wikipedia article | 19,913 | 35,693 | 1,196 | 5,584 | 0.03 | 100 / 512 |
| Hacker News | 10,029 | 12,296 | 1,230 | 2,557 | 0.10 | 100 / 228 |
| MDN `<input>` reference | 72,342 | 149,800 | 2,868 | 19,167 | 0.02 | 100 / 1,675 |
| GitHub repository page | 13,512 | 18,126 | 1,801 | 3,966 | 0.10 | 100 / 281 |
| Python docs (json) | 16,096 | 23,034 | 1,354 | 2,091 | 0.06 | 100 / 173 |
| GOV.UK home | 3,214 | 5,151 | 1,471 | 1,471 | 0.29 | 88 / 88 |
| W3C APG combobox example | 8,550 | 10,788 | 989 | 989 | 0.09 | 59 / 59 |
| BBC News | 8,044 | 11,076 | 2,419 | 2,555 | 0.22 | 100 / 114 |
| React docs (Quick Start) | 6,677 | 10,255 | 1,289 | 1,289 | 0.13 | 98 / 98 |
| Naver (Korean portal) | 6,788 | 14,590 | 1,995 | 3,353 | 0.14 | 100 / 166 |

Median over the ten pages, with the interquartile range and the extremes:

| | median | p25 to p75 | min to max |
| --- | ---: | ---: | ---: |
| aria | 9,290 | 7,102 to 15,450 | 3,214 to 72,342 |
| ai | 13,443 | 10,860 to 21,807 | 5,151 to 149,800 |
| helper | 1,413 | 1,245 to 1,947 | 989 to 2,868 |
| helper, no cap | 2,556 | 1,626 to 3,813 | 989 to 19,167 |
| helper / ai | 0.10 | 0.07 to 0.13 | 0.02 to 0.29 |

A call took a median of 6 ms for the helper (including the `page.evaluate` round trip), 31 ms for `aria` and 50 ms for `ai`.

The helper is small because it leaves things out on purpose: body text past 400 characters, link URLs, structure other than headings, and every control beyond the 100 it keeps (ranked by distance from the viewport). The `no cap` column separates the two effects. The AI snapshot keeps far more text and structure, so if the agent has to read a long article, this is the wrong tool; narrow down with `find()` or `snapshot({ root })`, or fall back to the full snapshot.

### Do they list the same controls?

The public pages have no ground truth, so I took the interactive nodes of the AI snapshot (button, link, textbox, checkbox, combobox, tab and the like) as role and name pairs and looked for the same pair in the uncapped helper list, comparing the first 40 non-space characters of the name. It is a one-way, string-level check: a match does not prove both lines point at the same element, and controls that only the helper lists do not count. A median of 99% of the AI snapshot's pairs had a match (89% to 100% per page). The misses I looked at were live examples in a cross-origin iframe (MDN), heading anchor links that only show up on hover (React docs), and images whose alt text is part of the link name in one tool but not the other (BBC).

On the fixture pages there is a hand-written list of the controls an agent needs:

| fixture | controls | aria | ai | helper | helper, no cap |
| --- | ---: | ---: | ---: | ---: | ---: |
| React form | 4 | 4 | 4 | 4 | 4 |
| two nested same-origin iframes | 5 | 0 | 5 | 5 | 5 |
| frameset | 5 | 0 | 5 | 5 | 5 |
| open and closed shadow roots | 4 | 2 | 2 | 2 | 2 |
| cross-origin iframe | 2 | 0 | 2 | 0 | 0 |
| button under a cookie banner | 3 | 3 | 3 | 3 | 3 |
| upload widget | 2 | 2 | 2 | 2 | 2 |
| account form | 16 | 16 | 16 | 16 | 16 |
| long news page (8 sampled controls) | 8 | 7 | 8 | 5 | 8 |

The default helper snapshot misses three controls on the long page because they are far below the fold; its output says so (`listed 100 of 198 interactive elements`).

### Fixture tasks

Every task ran three times on a fresh page, with the same result each time.

| task | plain DOM calls | helper | helper per frame | Playwright refs |
| --- | --- | --- | --- | --- |
| fill a React 18 controlled input, submit | fail: React keeps the old value | pass | pass | pass |
| field two same-origin iframes deep | fail: not in `document` | pass | pass | pass |
| checkbox and button in a frameset | fail: not in `document` | pass | pass | pass |
| field in an open shadow root | fail: not in `document` | pass | pass | pass |
| field in a closed shadow root | fail | fail | fail | fail |
| field in a cross-origin iframe | fail | fail | pass | pass |
| Save under a cookie banner: dismiss it, then save (2 s action timeout) | fail: Save fired through the banner | pass in 10 ms | | pass in 2,074 ms |

- *plain DOM calls* is the common first attempt from page JavaScript (`querySelector`, `el.value = ...`, `el.click()`). It is here to show the failures the helper exists for, not as a fair competitor; a careful hand-written script can do everything the helper does.
- *helper per frame* calls the helper instance that `install()` puts in every frame, which is how you reach cross-origin frames.
- *Playwright refs* is `ariaSnapshot({ mode: 'ai' })` plus `getByRef()`. It handles everything but the closed shadow root.
- In the banner task both scripted policies press the first button inside whatever covers Save, then retry. The times compare those two policies, not click speed: Playwright first waits out the 2 s actionability timeout set in this benchmark before its error names the element in the way, while the helper reports the cover in the snapshot and refuses the click right away.

Upload widgets in three shapes, comparing the usual Playwright recipes with `uploadFile()`:

| widget | `setInputFiles` right away | click, then `setInputFiles` | `waitForEvent('filechooser')` + click | `uploadFile()` |
| --- | --- | --- | --- | --- |
| button adds an input and opens the file dialog | fail | pass | pass | pass in 214 ms |
| button adds a hidden input, no dialog | fail | pass | fail | pass in 214 ms |
| dialog from an input never attached to the DOM | fail | fail | pass | pass in 132 ms |

The click-then-set recipe and the filechooser recipe each cover two of the three shapes. `uploadFile()` covers all three because it listens for a file chooser and watches for a new input at the same time. It polls for them, so it is slower than the recipe that happens to fit (130 to 215 ms here, more when a widget is slow to create its input).

## Page API

All methods live on `window.__aph__`. `inspect()` and the actions return `{ ok: true, ... }` or `{ ok: false, error: { code, message } }`. The listing methods return data and throw on bad arguments, except that `formState()` returns the same failure object when given a ref that no longer resolves.

| method | what it does |
| --- | --- |
| `snapshot(opts)` | Controls, headings, live regions, frames and a text excerpt. `format: 'text'` returns the line format above, otherwise JSON. Options: `maxElements` (100), `root` (ref or CSS selector), `textChars` (400), `frames`, `occlusion`, `hrefs`. |
| `find(text, opts)` | Visible elements whose name or own text contains `text`, controls first; a matching `<label>` is reported as its control. Options: `exact`, `role`, `limit`, `interactiveOnly`. |
| `query(selector, opts)` | `querySelectorAll` across same-origin frames and open shadow roots. |
| `inspect(ref)` | Role, name, state, hit-test result, box, selected attributes, `<select>` options, validation message. |
| `click(ref, { force })` | `el.click()`. Refuses disabled elements (`DISABLED`, always), and hidden or covered ones (`NOT_VISIBLE`, `OCCLUDED` with `coveredBy` and `coveredByRef`) unless `force`. |
| `fill(ref, text, { blur })` | Sets the value through the native setter of the element's own realm, fires `input` and `change`, then blurs (pass `blur: false` to stay focused). Contenteditable goes through `insertText`. `VALUE_REJECTED` if the input refused the value (e.g. letters in a number field). |
| `select(ref, values)` | Native `<select>` by option value or label. `OPTION_NOT_FOUND` lists the options. |
| `setChecked(ref, checked)` | Checkbox, radio or switch via a click, then checks that the page kept the state (`NO_EFFECT` otherwise). Returns a promise. |
| `focus(ref)`, `scrollIntoView(ref)` | |
| `errors()` | Constraint-validation failures (with `userInvalid`), `aria-invalid` fields with their messages, and visible error elements. |
| `formState(target, { includeHidden })` | Field values per form, or for one form or container given as a ref or selector (a bad ref returns a failure). Password, one-time-code and card fields are masked; hidden inputs are skipped by default. |
| `frames()` | Every frame with its index, parent, URL and whether it could be entered. |
| `capturePopups(mode)`, `popups()` | `'record'` logs `window.open` and `target=_blank` clicks, `'same-tab'` opens them in the current tab, `'block'` drops them, `'off'` (the default) restores `window.open` unless the page has replaced it since. |
| `waitStable({ quiet, timeout })` | Resolves after `quiet` ms without DOM mutations. |
| `dispose()` | Turns popup capture off and removes the global. |

Refs look like `dxtr12`: four random letters drawn on every page load, then a counter. A ref kept from an earlier page returns `WRONG_DOCUMENT` instead of acting on some element of the new page (two loads share a prefix with odds of about 1 in 457,000); a removed element returns `STALE_REF`. Refs stay the same for the life of the element, across snapshots and re-renders that keep the node. TypeScript declarations for the page API and the Node modules are in `index.d.ts`, `playwright.d.ts` and `cdp.d.ts`.

## uploadFile()

```js
const { uploadFile } = require('agent-page-helper/playwright');
await uploadFile(page, '/path/to/report.pdf', { trigger: 'Browse files' }); // or { input: '#file' }
// -> { ok: true, via: 'filechooser' | 'input', files: ['report.pdf'] }
```

`trigger` takes a Playwright locator, a string or a RegExp (matched against button, link and label names). Without `input` or `trigger` it uses the page's only file input, or the only button that looks like an upload trigger (English and Korean labels such as "Upload", "Browse", "파일찾기", "첨부"), and throws `AMBIGUOUS_TARGET` if there is more than one. It works in the trigger's frame (a `frameLocator()` locator is fine). After the click it takes a file chooser opened from that frame, or the one new file input; if nothing new shows up within half a second and one of the trigger's three nearest ancestors already holds the frame's only file input, it uses that one (widgets that reuse their input). Exactly one of `setInputFiles` and `FileChooser.setFiles` runs, uploads on the same page run one at a time, and the `filechooser` listener is removed afterwards even when the upload fails. Its own errors are `UploadError`s with a `code` (`NO_TARGET`, `AMBIGUOUS_TARGET`, `TIMEOUT`, `NOT_APPLIED`); errors from Playwright itself pass through unchanged. Pure drop zones without any file input are not handled.

## cdp-probe

```text
$ npx cdp-probe --endpoint http://127.0.0.1:9333
timeout       3001ms  0C80D020136A59E9B646AD7D678A64F2  Report                          http://localhost:37603/report.html
responsive       7ms  E5BE43013328D70FE55C63B93708B7F6  Reports                         http://127.0.0.1:37603/popup.html

1 target(s) did not answer. Close one with: cdp-probe --endpoint http://127.0.0.1:9333 --close <id>
```

(The first tab was put in an endless loop for the demo.)

It sends a trivial `Runtime.evaluate` to every page target. When `connectOverCDP` or every Playwright command hangs against a long-running browser, the cause can be one target whose renderer no longer answers: a print preview, a stuck PDF viewer, a page spinning in JavaScript. A timeout can also mean a debugger pause or a busy page, so the probe only reports, and closing stays an explicit `--close <id>`. Exit status is 0 when every target answered, 1 when some did not, 2 when the endpoint is unreachable. The same functions are available as `require('agent-page-helper/cdp')`. Needs Node 22 or later.

## Limitations

- Cross-origin iframes are listed but not entered by the top frame's helper. `install()` puts an instance in every frame, so you can call that frame's own `__aph__` through `frame.evaluate()`; its refs belong to that instance.
- Closed shadow roots are out of reach (Playwright cannot see into the one in the fixture either).
- `click()`, `fill()`, `select()` and `setChecked()` dispatch DOM events, so `event.isTrusted` is false. Sites that check it, and widgets that listen for key events, need real input (Playwright's `click()`/`type()` or CDP `Input` events). `fill()` sets a value; it does not type.
- Occlusion is a hit test at the element's center. A partly covered element can pass, an element that gets covered after the snapshot is not caught, and offscreen elements are reported as `offscreen`, not tested. CSS transforms on iframes are not taken into account.
- Names follow the accessible-name rules loosely: no CSS generated content, simplified fallbacks. They usually match Playwright's, but not always.
- Refs follow DOM nodes. A virtualized list that reuses nodes keeps the ref while the content changes.
- Masking covers password, one-time-code and card fields only. Everything else on the page, including text in the snapshot, passes through as is. Snapshot text is controlled by the page, so treat it as untrusted input to your model.
- Popup capture wraps `window.open` of the top window only, and logs `target=_blank` clicks that the page may still cancel.

## Development

```bash
npm ci
npx playwright install chromium
npm test             # node --test, Playwright's Chromium, no network
npm run bench        # fixtures only
npm run bench:live   # also the public pages in bench/pages.json
```

## License

MIT
