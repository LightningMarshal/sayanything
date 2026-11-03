'use strict';

/*
 * Linux boot check: launches the REAL app (`electron . --smoke`) on Linux with
 * a fake xdg-desktop-portal on a private dbus-daemon and a throwaway config dir,
 * and checks that the Linux path through main.js works end to end:
 *   - settings load from $XDG_CONFIG_HOME/SayAnything
 *   - the 'helper' check passes: the app connected to the bus, created a
 *     GlobalShortcuts session, bound 'dictate' + 'pad', and answers ping
 *   - the app closes its portal session on exit
 *   - the whisper 'binaries' check fails with the step-4 guidance (no Linux
 *     whisper-server is packaged yet; docs/LINUX-PORT.md)
 *
 * Run with plain node (it spawns Electron itself) under a display, e.g.
 *   xvfb-run -a node test/linux-boot-check.js
 * Linux only; exits 0 with a SKIP elsewhere. Exit 1 on any failed check.
 */

const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { startPrivateBus, hasDbusDaemon } = require('./fixtures/private-bus');
const { startFakePortal } = require('./fixtures/fake-portal');

const REPO = path.resolve(__dirname, '..');

let failures = 0;
function check(cond, msg) {
  if (cond) console.log('  ok  - ' + msg);
  else { failures++; console.error('  FAIL- ' + msg); }
}

async function main() {
  if (process.platform !== 'linux' || !hasDbusDaemon()) {
    console.log('linux-boot-check: SKIP (Linux with dbus-daemon only)');
    return;
  }
  const electron = /** @type {string} */ (/** @type {unknown} */ (require('electron')));
  const bus = await startPrivateBus();
  const fake = await startFakePortal(bus.address);
  const cfg = fs.mkdtempSync(path.join(os.tmpdir(), 'sa-linux-boot-'));
  try {
    const env = Object.assign({}, process.env, {
      DBUS_SESSION_BUS_ADDRESS: bus.address,
      XDG_CONFIG_HOME: cfg,
      ELECTRON_DISABLE_SECURITY_WARNINGS: '1',
    });
    // --no-sandbox: the CI runner's AppArmor policy blocks Chromium's sandbox.
    const out = await new Promise(function (resolve) {
      const child = spawn(electron, ['--no-sandbox', REPO, '--smoke'], { env: env, cwd: REPO });
      let buf = '';
      child.stdout.on('data', function (d) { buf += d; });
      child.stderr.on('data', function (d) { buf += d; });
      const t = setTimeout(function () { child.kill(); }, 90000);
      child.on('exit', function () { clearTimeout(t); resolve(buf); });
    });
    const lines = String(out).split('\n').filter(function (l) { return l.charAt(0) === '{'; }).map(function (l) {
      try { return JSON.parse(l); } catch (e) { return null; }
    }).filter(Boolean);
    const by = {};
    lines.forEach(function (l) { if (l.check) by[l.check] = l; });
    if (!lines.length) console.error(String(out).slice(-2000));

    check(by.settings && by.settings.ok && by.settings.detail.userData === path.join(cfg, 'SayAnything'),
      'settings load from $XDG_CONFIG_HOME/SayAnything');
    check(by.helper && by.helper.ok && by.helper.detail && by.helper.detail.ping === true,
      'helper check passes through the portal adapter');
    check(fake.bound.length === 2 && fake.bound[0].id === 'dictate' && fake.bound[1].id === 'pad',
      'the app bound dictate + pad through GlobalShortcuts');
    check(fake.calls.indexOf('Session.Close') !== -1, 'the app closed its portal session on exit');
    check(by.binaries && !by.binaries.ok && /LINUX-PORT\.md, step 4/.test(String(by.binaries.detail)),
      'missing Linux whisper-server reported with the step-4 guidance');
  } finally {
    fake.stop();
    bus.stop();
    try { fs.rmSync(cfg, { recursive: true, force: true }); } catch (e) { /* ignore */ }
  }
}

main().catch(function (e) {
  failures++;
  console.error('  FAIL- unexpected error: ' + (e && e.stack || e));
}).then(function () {
  console.log('linux-boot-check: ' + (failures ? failures + ' failure(s)' : 'all checks passed'));
  process.exit(failures ? 1 : 0);
});
