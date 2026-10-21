#!/usr/bin/env node
'use strict';
const { probeTargets, closeTarget } = require('../cdp.js');

const USAGE = `usage: cdp-probe [--endpoint URL] [--timeout MS] [--json] [--close TARGET_ID]

Sends a trivial Runtime.evaluate to every page target of a Chromium DevTools
endpoint and reports which ones answer. One target that does not answer (print
preview, a stuck PDF viewer, a page spinning in JS) can make connectOverCDP
hang for every command. A timeout can also be a debugger pause or a busy page,
so this only reports; closing a target is up to you (--close).

  --endpoint URL   DevTools HTTP endpoint (default: $CDP_ENDPOINT or http://127.0.0.1:9222)
  --timeout MS     per-target timeout in ms (default 3000)
  --json           print JSON instead of a table
  --close ID       close the target with this id, then exit

exit status: 0 all targets answered, 1 some did not, 2 endpoint unreachable or bad arguments`;

function parse(argv) {
  const opts = { endpoint: undefined, timeout: 3000, json: false, close: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const value = () => {
      const v = argv[++i];
      if (v === undefined) throw new Error(`${a} needs a value`);
      return v;
    };
    if (a === '--endpoint') opts.endpoint = value();
    else if (a === '--timeout') opts.timeout = Number(value());
    else if (a === '--json') opts.json = true;
    else if (a === '--close') opts.close = value();
    else if (a === '-h' || a === '--help') opts.help = true;
    else throw new Error(`unknown argument: ${a}`);
  }
  if (!Number.isInteger(opts.timeout) || opts.timeout < 1 || opts.timeout > 2147483647) throw new Error('--timeout must be a whole number of milliseconds');
  return opts;
}

// Page titles and URLs come from the pages; keep terminal control sequences out.
const printable = (s) => String(s || '').replace(/[\u0000-\u001f\u007f-\u009f]/g, '');

async function main() {
  let opts;
  try {
    opts = parse(process.argv.slice(2));
  } catch (e) {
    console.error(`${e.message}\n\n${USAGE}`);
    return 2;
  }
  if (opts.help) { console.log(USAGE); return 0; }
  if (opts.close) {
    const ok = await closeTarget(opts.endpoint, opts.close, { timeout: opts.timeout });
    console.log(ok ? `closed ${opts.close}` : `could not close ${opts.close} (unknown id, or still listed after ${opts.timeout} ms)`);
    return ok ? 0 : 1;
  }
  const results = await probeTargets(opts.endpoint, { timeout: opts.timeout });
  const bad = results.filter((r) => r.status !== 'responsive');
  if (opts.json) {
    console.log(JSON.stringify(results, null, 2));
  } else {
    for (const r of results) {
      const note = r.printPreview ? ' [print preview]' : '';
      console.log(`${r.status.padEnd(12)} ${String(r.ms).padStart(5)}ms  ${printable(r.id)}  ${printable(r.title).slice(0, 30).padEnd(30)}  ${printable(r.url).slice(0, 80)}${note}`);
    }
    if (!results.length) console.log('no page targets');
    else if (bad.length) console.log(`\n${bad.length} target(s) did not answer. Close one with: cdp-probe${opts.endpoint ? ` --endpoint ${printable(opts.endpoint)}` : ''} --close <id>`);
    else console.log('\nall page targets answered');
  }
  return bad.length ? 1 : 0;
}

main().then((code) => { process.exitCode = code; }, (e) => {
  console.error(`cdp-probe: ${e.cause ? e.cause.message || e.message : e.message}`);
  process.exitCode = 2;
});
