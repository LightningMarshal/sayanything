'use strict';

/*
 * Linux AppImage check (CI and release).
 *
 *   1. Extract the AppImage and run test/linux-packaged-check.js on the app
 *      inside it: fuses, RunAsNode off, --smoke (with SA_TEST_MODEL, the real
 *      whisper-server boot), and the portal shortcuts.
 *   2. Launch the AppImage FILE itself (its runtime and AppRun) in --smoke
 *      mode against a fake desktop portal on a private bus, and check the
 *      smoke summary, that the app registered its id with the portal's
 *      host-app registry (AppImages are not sandboxed, so this is their only
 *      identity), and that it bound its three shortcuts.
 *   3. The embedded .desktop entry does not disable Chromium's sandbox
 *      (electron-builder's default AppImage args are --no-sandbox), and the
 *      sandbox-aware launcher sits in front of the Electron binary.
 *
 * In CI, FUSE may be unavailable, so step 2 uses APPIMAGE_EXTRACT_AND_RUN=1
 * (the runtime unpacks to a temp dir instead of mounting); the AppRun path is
 * the same. Step 2 goes through packaging/appimage/launcher.sh, which adds
 * --no-sandbox only where the system blocks the sandbox (the Ubuntu CI runner
 * does); the check confirms its decision matches this system. --no-sandbox
 * is passed explicitly only when running as root, which Chromium requires.
 *
 * Usage: xvfb-run -a node test/linux-appimage-check.js dist/SayAnything-*.AppImage
 * Linux only. Exit 1 on any failed check.
 */

const { spawn, spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { startPrivateBus, hasDbusDaemon } = require('./fixtures/private-bus');
const { startFakePortal } = require('./fixtures/fake-portal');

const APP_ID = 'io.github.lightningmarshal.SayAnything';

let failures = 0;
function check(cond, msg) {
  if (cond) console.log('PASS  ' + msg);
  else { failures++; console.log('FAIL  ' + msg); }
}

// Same test as packaging/appimage/launcher.sh.
function sandboxBlocked() {
  function rd(p) { try { return fs.readFileSync(p, 'utf8').trim(); } catch (e) { return null; } }
  return rd('/proc/sys/kernel/apparmor_restrict_unprivileged_userns') === '1' ||
    rd('/proc/sys/kernel/unprivileged_userns_clone') === '0' ||
    rd('/proc/sys/user/max_user_namespaces') === '0';
}

function run(cmd, args, opts) {
  return new Promise(function (resolve) {
    const child = spawn(cmd, args, opts);
    let out = '';
    if (child.stdout) child.stdout.on('data', function (d) { out += d; if (opts.echo) process.stdout.write(d); });
    if (child.stderr) child.stderr.on('data', function (d) { out += d; if (opts.echo) process.stderr.write(d); });
    const t = setTimeout(function () { try { child.kill(); } catch (e) { /* ignore */ } }, opts.timeoutMs || 180000);
    child.on('close', function (code) { clearTimeout(t); resolve({ code: code, out: out }); });
    child.on('error', function (e) { clearTimeout(t); resolve({ code: -1, out: out + String(e) }); });
  });
}

async function main() {
  const appImage = process.argv[2] ? path.resolve(process.argv[2]) : null;
  if (process.platform !== 'linux' || !hasDbusDaemon()) { console.log('linux-appimage-check: SKIP (Linux with dbus-daemon only)'); return; }
  if (!appImage || !fs.existsSync(appImage)) { check(false, 'AppImage exists (' + appImage + ')'); return; }
  fs.chmodSync(appImage, 0o755);

  // 1. extract and check the app inside
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'sa-appimage-'));
  try {
    const ex = spawnSync(appImage, ['--appimage-extract'], { cwd: work, stdio: 'ignore' });
    const root = path.join(work, 'squashfs-root');
    check(ex.status === 0 && fs.existsSync(path.join(root, 'AppRun')), 'AppImage extracts (AppRun present)');
    check(fs.existsSync(path.join(root, 'resources', 'bin', 'whisper', 'whisper-server')), 'whisper-server is inside the AppImage');
    const launcher = fs.readFileSync(path.join(root, 'sayanything'), 'utf8');
    check(/^#!\/bin\/sh/.test(launcher) && /sandbox_blocked/.test(launcher) && fs.existsSync(path.join(root, 'sayanything-bin')),
      'the sandbox-aware launcher sits in front of the Electron binary (sayanything-bin)');
    const desktop = fs.readdirSync(root).filter(function (f) { return /\.desktop$/.test(f); });
    const entry = desktop.length ? fs.readFileSync(path.join(root, desktop[0]), 'utf8') : '';
    check(/^Exec=.*--ozone-platform-hint=auto/m.test(entry) && !/--no-sandbox/.test(entry),
      'desktop entry launches natively on Wayland and keeps Chromium\'s sandbox');
    // The fuse wire lives in the real binary, so check that one directly.
    const inner = await run(process.execPath, [path.join(__dirname, 'linux-packaged-check.js'), path.join(root, 'sayanything-bin')],
      { env: process.env, echo: true, timeoutMs: 400000 });
    check(inner.code === 0, 'packaged-app check on the AppImage contents (fuses, RunAsNode, smoke, shortcuts)');

    // 2. launch the AppImage file itself
    const bus = await startPrivateBus();
    const fake = await startFakePortal(bus.address);
    const cfg = fs.mkdtempSync(path.join(os.tmpdir(), 'sa-appimage-cfg-'));
    try {
      const env = Object.assign({}, process.env, {
        DBUS_SESSION_BUS_ADDRESS: bus.address, XDG_CONFIG_HOME: cfg, APPIMAGE_EXTRACT_AND_RUN: '1',
        TMPDIR: work,
      });
      // Through the launcher: it adds --no-sandbox itself where the system
      // blocks the sandbox (e.g. the Ubuntu CI runner). Chromium also refuses
      // to run as root with a sandbox, so only then pass it explicitly.
      const blocked = sandboxBlocked();
      const asRoot = typeof process.getuid === 'function' && process.getuid() === 0;
      const r = await run(appImage, (asRoot ? ['--no-sandbox'] : []).concat(['--smoke']), { env: env, timeoutMs: 180000 });
      const notice = /starting without it/.test(r.out);
      check(notice === blocked, 'launcher ' + (blocked ? 'disabled' : 'kept') + ' the sandbox, matching this system (blocked=' + blocked + ')');
      const lines = r.out.split('\n').filter(function (l) { return /^\{.*\}$/.test(l.trim()); }).map(function (l) {
        try { return JSON.parse(l); } catch (e) { return null; }
      }).filter(Boolean);
      const summary = lines.find(function (l) { return l.summary; });
      const helper = lines.find(function (l) { return l.check === 'helper'; });
      if (!summary) console.log(r.out.slice(-1500));
      check(!!helper && helper.ok === true, 'the AppImage itself starts and its portal helper answers');
      check(!!summary && summary.failed === 0, 'the AppImage itself passes --smoke');
      check(fake.registered.some(function (x) { return x.appId === APP_ID; }), 'the AppImage registered as ' + APP_ID + ' with the portal');
      check(fake.lateRegister.length === 0, 'registration came before any other portal call');
      check(fake.bound.map(function (b) { return b.id; }).join() === 'dictate,pad,cancel', 'the AppImage bound dictate, pad and cancel');
    } finally {
      fake.stop();
      bus.stop();
      try { fs.rmSync(cfg, { recursive: true, force: true }); } catch (e) { /* ignore */ }
    }
  } finally {
    try { fs.rmSync(work, { recursive: true, force: true }); } catch (e) { /* ignore */ }
  }
}

main().catch(function (e) {
  failures++;
  console.error('FAIL  unexpected error: ' + (e && e.stack || e));
}).then(function () {
  console.log('\nlinux-appimage-check: ' + (failures ? 'FAILED (' + failures + ')' : 'ok'));
  process.exit(failures ? 1 : 0);
});
