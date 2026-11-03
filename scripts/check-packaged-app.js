'use strict';

/**
 * Verify a packaged Say Anything build (used by the Windows and Linux
 * packaging CI jobs).
 *
 *   node scripts/check-packaged-app.js "dist/win-unpacked/Say Anything.exe"
 *   node scripts/check-packaged-app.js dist/linux-unpacked/sayanything --electron-arg=--no-sandbox
 *
 * Options after the executable:
 *   --electron-arg=X   pass X to the app first on every launch (repeatable),
 *                      e.g. --no-sandbox where AppArmor blocks Chromium's sandbox
 *   --model-optional   accept a skipped server boot (no model staged)
 *
 * 1. Fuses: every fuse in scripts/fuses.js is set as declared in the binary.
 * 2. RunAsNode is really off: launching with ELECTRON_RUN_AS_NODE=1 and a
 *    `-e` script must NOT run that script as Node (it starts the app instead,
 *    here in --smoke mode so it exits on its own).
 * 3. Packaged smoke test: `--smoke` reports settings, helper, whisper binaries
 *    and (with the bundled model) a real whisper-server boot, all ok. Judged
 *    by the JSON summary line, not the process exit code (Electron's teardown
 *    exit code is unreliable on Windows, see test/run-electron-check.js).
 */

const cp = require('child_process');
const { FUSES } = require('./fuses');

const exe = process.argv[2];
if (!exe) { console.error('usage: node scripts/check-packaged-app.js <packaged executable or .app> [--electron-arg=X ...] [--model-optional]'); process.exit(2); }
const EXTRA = [];
let modelOptional = false;
for (const a of process.argv.slice(3)) {
  if (a.indexOf('--electron-arg=') === 0) EXTRA.push(a.slice('--electron-arg='.length));
  else if (a === '--model-optional') modelOptional = true;
  else { console.error('check-packaged-app: unknown option ' + a); process.exit(2); }
}

let failed = 0;
function check(ok, label, extra) {
  console.log((ok ? 'PASS  ' : 'FAIL  ') + label + (extra ? '  (' + extra + ')' : ''));
  if (!ok) failed++;
}

function run(args, env, timeoutMs) {
  return new Promise(function (resolve) {
    let out = '';
    const child = cp.spawn(exe, EXTRA.concat(args), { env: Object.assign({}, process.env, env || {}), windowsHide: true });
    child.stdout.on('data', function (d) { out += d; });
    child.stderr.on('data', function (d) { out += d; });
    const t = setTimeout(function () { try { child.kill(); } catch (e) { /* ignore */ } }, timeoutMs);
    child.on('close', function (code) { clearTimeout(t); resolve({ out: out, code: code }); });
    child.on('error', function (e) { clearTimeout(t); resolve({ out: out + String(e), code: -1 }); });
  });
}

function summaryOf(out) {
  const lines = out.split(/\r?\n/).filter(function (l) { return /^\{.*\}$/.test(l.trim()); });
  const parsed = lines.map(function (l) { try { return JSON.parse(l); } catch (e) { return null; } }).filter(Boolean);
  return { checks: parsed.filter(function (o) { return o.check; }), summary: parsed.find(function (o) { return o.summary; }) };
}

(async function main() {
  // 1. fuse wire
  const fuses = await import('@electron/fuses');
  const wire = await fuses.getCurrentFuseWire(exe);
  for (const name of Object.keys(FUSES)) {
    const idx = fuses.FuseV1Options[name];
    const want = FUSES[name] ? fuses.FuseState.ENABLE : fuses.FuseState.DISABLE;
    check(wire[idx] === want, 'fuse ' + name + ' is ' + (FUSES[name] ? 'enabled' : 'disabled'), 'state=' + fuses.FuseState[wire[idx]]);
  }

  // 2. RunAsNode probe
  // '--' keeps --smoke from being parsed as a Node option in Node mode (which
  // would abort before running the script); in app mode it just starts --smoke.
  const probe = await run(['-e', 'console.log("RUN_AS_NODE_ACTIVE")', '--', '--smoke'], { ELECTRON_RUN_AS_NODE: '1' }, 120000);
  check(probe.out.indexOf('RUN_AS_NODE_ACTIVE') === -1, 'ELECTRON_RUN_AS_NODE=1 does not run code as Node');

  // 3. packaged smoke
  const smoke = await run(['--smoke'], {}, 180000);
  process.stdout.write(smoke.out.split(/\r?\n/).filter(function (l) { return /^\{/.test(l.trim()); }).join('\n') + '\n');
  const s = summaryOf(smoke.out);
  check(!!s.summary && s.summary.ok === true, 'packaged --smoke summary ok');
  const server = s.checks.find(function (c) { return c.check === 'server'; });
  if (modelOptional && server && server.skipped) {
    console.log('SKIP  whisper-server boot (no model staged; --model-optional)');
  } else {
    check(!!server && server.ok === true && !server.skipped, 'whisper-server boots from the packaged app with the bundled model');
  }

  console.log(failed ? '\ncheck-packaged-app: FAILED (' + failed + ')' : '\ncheck-packaged-app: ok');
  process.exit(failed ? 1 : 0);
})().catch(function (e) { console.error('check-packaged-app: ' + (e && e.stack || e)); process.exit(1); });
