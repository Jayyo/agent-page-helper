#!/usr/bin/env node
'use strict';
// Snapshot size and capability benchmark.
//
//   node bench/run.js            fixtures only (no network)
//   node bench/run.js --live     fixtures plus the public pages in bench/pages.json
//   options: --runs N (task repetitions, default 3), --only sizes|tasks, --out DIR
//
// Token counts use js-tiktoken with the o200k_base encoding.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { chromium } = require('playwright');
const { getEncoding } = require('js-tiktoken');
const { startServer } = require('../test/server.js');
const { install } = require('../playwright.js');
const { tasks, FILE } = require('./tasks.js');

const args = process.argv.slice(2);
const flag = (name) => args.includes(name);
const option = (name, def) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : def; };
const LIVE = flag('--live');
const RUNS = Number(option('--runs', 3));
const ONLY = option('--only', null);
const OUT = path.resolve(option('--out', path.join(__dirname, 'results')));
const VIEWPORT = { width: 1280, height: 800 };

const enc = getEncoding('o200k_base');
const tokens = (s) => enc.encode(s).length;

// What an agent must be able to address on each fixture, written by hand.
// Used to check every snapshot format against the same list.
const FIXTURES = {
  'react-controlled.html': [['textbox', 'Email'], ['combobox', 'Plan'], ['checkbox', 'Send me product updates'], ['button', 'Sign up']],
  'nested-frames.html': [['textbox', 'Card holder'], ['combobox', 'Delivery'], ['textbox', 'Notes'], ['textbox', 'Coupon code'], ['button', 'Apply']],
  'frameset.html': [['link', 'Lesson 1'], ['link', 'Lesson 2'], ['link', 'Lesson 3'], ['checkbox', 'I have read this lesson'], ['button', 'Next lesson']],
  'shadow.html': [['textbox', 'Work email'], ['textbox', 'Personal email'], ['button', 'Subscribe'], ['button', 'Subscribe']],
  'cross-origin.html': [['textbox', 'Coupon code'], ['button', 'Apply']],
  'occluded.html': [['textbox', 'Display name'], ['button', 'Save changes'], ['button', 'Accept all']],
  'upload.html': [['button', 'Browse files'], ['button', 'Attach later']],
  'forms.html': [['textbox', 'Username'], ['textbox', 'Email'], ['textbox', 'Password'], ['textbox', 'Card number'], ['spinbutton', 'Age'],
    ['textbox', 'Bio'], ['textbox', 'Postcode'], ['checkbox', 'News'], ['checkbox', 'Events'], ['checkbox', 'Jobs'], ['radio', 'Free'],
    ['radio', 'Pro'], ['checkbox', 'Accept the terms'], ['button', 'Save'], ['button', 'Delete account'], ['textbox', 'Notes editor']],
  'long-noisy.html': [['link', 'World'], ['searchbox', 'Search news'], ['button', 'Search'], ['button', 'Share'], ['link', 'Try Transit Plus free for 30 days'],
    ['button', 'Load more comments'], ['link', 'Careers'], ['link', 'Weather archive']],
};

function present(output, targets) {
  let n = 0;
  const used = new Map();
  for (const [role, name] of targets) {
    const needle = `${role} "${name}"`;
    let from = used.get(needle) || 0;
    const at = output.indexOf(needle, from);
    if (at >= 0) { n++; used.set(needle, at + needle.length); }
  }
  return n;
}

// Interactive elements as (role, name) pairs, from Playwright's YAML and from the
// helper's text format, to see how far the two lists agree on real pages.
const ROLES = new Set(['button', 'link', 'textbox', 'searchbox', 'checkbox', 'radio', 'combobox', 'listbox', 'menuitem',
  'menuitemcheckbox', 'menuitemradio', 'tab', 'switch', 'slider', 'spinbutton', 'treeitem']);
const norm = (name) => (name || '').replace(/\\"/g, '"').replace(/…$/, '').replace(/\s+/g, '').toLowerCase().slice(0, 40);
// Playwright leaves the name out of the YAML when the children carry the same text
// (`link:` with a `code: marshal` child), so read the JSON form and rebuild such
// names from the descendants' text.
function nodeText(n) {
  if (typeof n === 'string') return n;
  if (n.name) return n.name;
  return [n.text || '', ...(n.children || []).map(nodeText)].join(' ');
}
function ariaPairs(tree) {
  const out = [];
  (function walk(nodes) {
    for (const n of nodes || []) {
      if (typeof n === 'string') continue;
      if (ROLES.has(n.role)) out.push(`${n.role}|${norm(n.name || nodeText(n))}`);
      walk(n.children);
    }
  })(Array.isArray(tree) ? tree : [tree]);
  return out;
}
function helperPairs(text) {
  const out = [];
  for (const line of text.split('\n')) {
    const m = /^\s*\[[a-z]{4}\d+\] ([a-z]+)(?: "((?:[^"\\]|\\.)*)")?/.exec(line);
    if (m && ROLES.has(m[1])) out.push(`${m[1]}|${norm(m[2])}`);
  }
  return out;
}
function overlap(a, b) {
  const counts = new Map();
  for (const k of b) counts.set(k, (counts.get(k) || 0) + 1);
  let n = 0;
  for (const k of a) { const c = counts.get(k); if (c) { n++; counts.set(k, c - 1); } }
  return n;
}

function quantile(sorted, q) {
  if (!sorted.length) return NaN;
  const pos = (sorted.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo);
}
function stats(values) {
  const v = values.filter((x) => Number.isFinite(x)).sort((a, b) => a - b);
  return { n: v.length, median: quantile(v, 0.5), p25: quantile(v, 0.25), p75: quantile(v, 0.75), min: v[0], max: v[v.length - 1] };
}
const median = (xs) => stats(xs).median;

async function timed(fn) {
  const times = [];
  let value;
  for (let i = 0; i < 3; i++) {
    const t0 = performance.now();
    value = await fn();
    times.push(performance.now() - t0);
  }
  return { value, ms: Math.round(median(times)) };
}

async function measure(page) {
  const out = {};
  const run = async (key, fn) => {
    try {
      const { value, ms } = await timed(fn);
      out[key] = { tokens: tokens(value), chars: value.length, ms, value };
    } catch (e) {
      out[key] = { error: e.message.split('\n')[0] };
    }
  };
  await run('aria', () => page.ariaSnapshot({ timeout: 10000 }));
  await run('ai', () => page.ariaSnapshot({ mode: 'ai', timeout: 10000 }));
  await run('text', () => page.evaluate(() => window.__aph__.snapshot({ format: 'text' })));
  await run('json', async () => JSON.stringify(await page.evaluate(() => window.__aph__.snapshot())));
  await run('textAll', () => page.evaluate(() => window.__aph__.snapshot({ format: 'text', maxElements: 1e9 })));
  const s = await page.evaluate(() => window.__aph__.snapshot({ maxElements: 0, occlusion: false, textChars: 0 }));
  out.found = s.stats.found;
  out.listed = Math.min(s.stats.found, 100);
  out.aiRefs = out.ai.value ? (out.ai.value.match(/\[ref=/g) || []).length : null;
  if (out.ai.value && out.textAll.value) {
    const ai = ariaPairs(await page.ariaSnapshotJSON({ mode: 'ai', timeout: 10000 }));
    const helper = helperPairs(out.textAll.value);
    out.agreement = { aiInteractive: ai.length, helperInteractive: helper.length, both: overlap(ai, helper) };
  }
  return out;
}

async function sizes(context, origin) {
  const pages = Object.keys(FIXTURES).map((f) => ({ name: f.replace('.html', ''), url: `${origin}/${f}`, kind: 'fixture', targets: FIXTURES[f] }));
  if (LIVE) for (const p of JSON.parse(fs.readFileSync(path.join(__dirname, 'pages.json'), 'utf8'))) pages.push({ ...p, kind: 'live' });
  const rows = [];
  for (const p of pages) {
    const page = await context.newPage();
    try {
      await page.goto(p.url, { waitUntil: p.kind === 'live' ? 'domcontentloaded' : 'load', timeout: 45000 });
      await page.waitForLoadState('load', { timeout: 15000 }).catch(() => {});
      await page.evaluate(() => window.__aph__.waitStable({ quiet: 500, timeout: 8000 }));
      const m = await measure(page);
      const row = { name: p.name, kind: p.kind, url: p.url, finalUrl: page.url(), found: m.found, listed: m.listed, aiRefs: m.aiRefs, agreement: m.agreement };
      for (const k of ['aria', 'ai', 'text', 'json', 'textAll']) {
        row[k] = m[k].error ? { error: m[k].error } : { tokens: m[k].tokens, chars: m[k].chars, ms: m[k].ms };
      }
      if (p.targets) {
        row.targets = p.targets.length;
        row.present = {};
        for (const k of ['aria', 'ai', 'text', 'textAll']) if (m[k].value) row.present[k] = present(m[k].value, p.targets);
      }
      rows.push(row);
      process.stderr.write(`sizes ${p.name}: aria ${row.aria.tokens} ai ${row.ai.tokens} text ${row.text.tokens}\n`);
    } catch (e) {
      rows.push({ name: p.name, kind: p.kind, url: p.url, error: e.message.split('\n')[0] });
      process.stderr.write(`sizes ${p.name}: ERROR ${e.message.split('\n')[0]}\n`);
    } finally {
      await page.close();
    }
  }
  return rows;
}

async function matrix(browser, origin) {
  const rows = [];
  for (const task of tasks) {
    const row = { id: task.id, title: task.title, results: {} };
    for (const [name, strategy] of Object.entries(task.strategies)) {
      const runs = [];
      for (let i = 0; i < RUNS; i++) {
        const context = await browser.newContext({ viewport: VIEWPORT });
        await install(context);
        const page = await context.newPage();
        await page.goto(`${origin}/${task.file}`, { waitUntil: 'load' });
        await page.waitForTimeout(100);
        const t0 = performance.now();
        let error = null;
        try { await strategy(page); } catch (e) { error = e.message.split('\n')[0]; }
        const ms = performance.now() - t0;
        let ok = false;
        try {
          const verdict = await task.check(page);
          ok = verdict === true && !error;
          if (verdict !== true && !error) error = verdict;
        } catch (e) { error = error || e.message.split('\n')[0]; }
        runs.push({ ok, ms: Math.round(ms), error });
        await context.close();
      }
      const passed = runs.filter((r) => r.ok);
      row.results[name] = {
        passed: passed.length,
        runs: runs.length,
        ms: Math.round(median(runs.map((r) => r.ms))),
        error: runs.find((r) => r.error) ? runs.find((r) => r.error).error : undefined,
      };
      process.stderr.write(`task ${task.id} / ${name}: ${passed.length}/${runs.length}\n`);
    }
    rows.push(row);
  }
  return rows;
}

function fmt(n) { return Number.isFinite(n) ? String(Math.round(n)) : '–'; }
function ratio(a, b) { return a && b ? (a / b).toFixed(2) : '–'; }

function markdown(result) {
  const lines = [];
  const env = result.env;
  lines.push(`# Benchmark results (${env.date})`, '');
  lines.push(`Chromium ${env.chromium}, Playwright ${env.playwright}, Node ${env.node}, ${env.os}. Viewport ${env.viewport}, locale ${env.locale}. Tokens: ${env.tokenizer}. Helper ${env.helper}, commit ${env.commit}.`, '');
  if (result.sizes) {
    for (const kind of ['fixture', 'live']) {
      const rows = result.sizes.filter((r) => r.kind === kind);
      if (!rows.length) continue;
      lines.push(`## Snapshot size, ${kind === 'fixture' ? 'fixture pages' : 'public pages'}`, '');
      lines.push('Tokens per snapshot. `aria` = `page.ariaSnapshot()`, `ai` = `page.ariaSnapshot({ mode: "ai" })`, `text`/`json` = helper defaults (100 elements, 400 chars of main text), `text-all` = helper text without the element cap.', '');
      const head = '| page | aria | ai | helper text | helper json | helper text-all | text / ai | listed / found | ai refs |';
      lines.push(head, '|' + head.split('|').slice(1, -1).map((c, i) => (i ? ' ---: ' : ' --- ')).join('|') + '|');
      for (const r of rows) {
        if (r.error) { lines.push(`| ${r.name} | error: ${r.error} |||||||||`); continue; }
        lines.push(`| ${r.name} | ${fmt(r.aria.tokens)} | ${fmt(r.ai.tokens)} | ${fmt(r.text.tokens)} | ${fmt(r.json.tokens)} | ${fmt(r.textAll.tokens)} | ${ratio(r.text.tokens, r.ai.tokens)} | ${r.listed} / ${r.found} | ${r.aiRefs ?? '–'} |`);
      }
      lines.push('');
      const ok = rows.filter((r) => !r.error);
      if (ok.length > 1) {
        lines.push(`Across ${ok.length} pages: median [p25–p75] (min–max)`, '');
        lines.push('| | tokens |', '| --- | --- |');
        for (const [k, label] of [['aria', 'aria'], ['ai', 'ai'], ['text', 'helper text'], ['json', 'helper json'], ['textAll', 'helper text-all']]) {
          const s = stats(ok.map((r) => r[k].tokens));
          lines.push(`| ${label} | ${fmt(s.median)} [${fmt(s.p25)}–${fmt(s.p75)}] (${fmt(s.min)}–${fmt(s.max)}) |`);
        }
        const rs = stats(ok.map((r) => r.text.tokens / r.ai.tokens));
        lines.push(`| helper text / ai | ${rs.median.toFixed(2)} [${rs.p25.toFixed(2)}–${rs.p75.toFixed(2)}] (${rs.min.toFixed(2)}–${rs.max.toFixed(2)}) |`, '');
        const ms = (k) => stats(ok.map((r) => r[k].ms));
        lines.push(`Median time per call: aria ${fmt(ms('aria').median)} ms, ai ${fmt(ms('ai').median)} ms, helper text ${fmt(ms('text').median)} ms (round trip through page.evaluate).`, '');
      }
      const agree = rows.filter((r) => r.agreement && r.agreement.aiInteractive);
      if (kind === 'live' && agree.length) {
        lines.push('Agreement on interactive elements (button, link, textbox, checkbox, combobox, tab, ... matched by role and the first 40 non-space characters of the name) between the AI snapshot and the uncapped helper list:', '');
        lines.push('| page | in ai | in helper | in both | share of ai found by helper |', '| --- | ---: | ---: | ---: | ---: |');
        for (const r of agree) {
          const a = r.agreement;
          lines.push(`| ${r.name} | ${a.aiInteractive} | ${a.helperInteractive} | ${a.both} | ${(100 * a.both / a.aiInteractive).toFixed(0)}% |`);
        }
        const share = stats(agree.map((r) => r.agreement.both / r.agreement.aiInteractive));
        lines.push('', `Median share ${(100 * share.median).toFixed(0)}% (min ${(100 * share.min).toFixed(0)}%, max ${(100 * share.max).toFixed(0)}%).`, '');
      }
      if (kind === 'fixture') {
        lines.push('Hand-listed targets present in each output (role and name match):', '');
        lines.push('| page | targets | aria | ai | helper text | helper text-all |', '| --- | ---: | ---: | ---: | ---: | ---: |');
        for (const r of rows) if (r.present) lines.push(`| ${r.name} | ${r.targets} | ${r.present.aria ?? '–'} | ${r.present.ai ?? '–'} | ${r.present.text ?? '–'} | ${r.present.textAll ?? '–'} |`);
        lines.push('');
      }
    }
  }
  if (result.tasks) {
    lines.push(`## Fixture tasks (${result.env.runs} runs each, fresh page per run)`, '');
    const strategies = [...new Set(result.tasks.flatMap((r) => Object.keys(r.results)))];
    for (const group of [strategies.filter((s) => !/input|chooser|upload/i.test(s)), strategies.filter((s) => /input|chooser|upload/i.test(s))]) {
      const rows = result.tasks.filter((r) => Object.keys(r.results).some((k) => group.includes(k)));
      if (!rows.length) continue;
      lines.push(`| task | ${group.join(' | ')} |`, `| --- |${group.map(() => ' --- ').join('|')}|`);
      for (const r of rows) {
        const cells = group.map((s) => {
          const x = r.results[s];
          if (!x) return '–';
          return x.passed === x.runs ? `pass ${x.passed}/${x.runs}, ${x.ms} ms` : `**fail** ${x.runs - x.passed}/${x.runs}: ${String(x.error).replace(/\|/g, '/').slice(0, 70)}`;
        });
        lines.push(`| ${r.title} | ${cells.join(' | ')} |`);
      }
      lines.push('');
    }
  }
  return lines.join('\n');
}

(async () => {
  const server = await startServer();
  const browser = await chromium.launch();
  let commit = 'unknown';
  try { commit = execFileSync('git', ['rev-parse', '--short', 'HEAD'], { cwd: path.join(__dirname, '..'), encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim(); } catch (e) { /* not a git checkout */ }
  const result = {
    env: {
      date: new Date().toLocaleDateString('sv'),
      chromium: browser.version(),
      playwright: require('playwright/package.json').version,
      node: process.versions.node,
      os: `${os.type()} ${os.release()}`,
      viewport: `${VIEWPORT.width}x${VIEWPORT.height}`,
      locale: 'en-US',
      tokenizer: 'js-tiktoken o200k_base',
      helper: require('../package.json').version,
      commit,
      runs: RUNS,
    },
  };
  try {
    if (ONLY !== 'tasks') {
      const context = await browser.newContext({ viewport: VIEWPORT, locale: 'en-US' });
      await install(context);
      result.sizes = await sizes(context, server.origin);
      await context.close();
    }
    if (ONLY !== 'sizes') result.tasks = await matrix(browser, server.origin);
  } finally {
    await browser.close();
    await server.close();
    fs.rmSync(path.dirname(FILE), { recursive: true, force: true });
  }
  fs.mkdirSync(OUT, { recursive: true });
  const base = path.join(OUT, `${result.env.date}${LIVE ? '-live' : ''}`);
  fs.writeFileSync(`${base}.json`, JSON.stringify(result, null, 2) + '\n');
  const md = markdown(result);
  fs.writeFileSync(`${base}.md`, md + '\n');
  console.log(md);
  console.error(`\nwrote ${base}.json and ${base}.md`);
})().catch((e) => { console.error(e); process.exit(1); });
