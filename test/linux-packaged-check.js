'use strict';

/*
 * Linux packaged-app check: runs scripts/check-packaged-app.js (fuses,
 * RunAsNode off, --smoke) against dist/linux-unpacked/sayanything with a fake
 * xdg-desktop-portal on a private dbus-daemon and a throwaway config dir, so the
 * packaged app's helper check goes through the portal adapter.
 *
 * Optional: SA_TEST_MODEL=<ggml .bin> is staged as tiny.en (and selected in
 * settings) so the smoke test also boots the packaged whisper-server; without
 * it the server boot is allowed to skip.
 *
 * Run under a display: xvfb-run -a node test/linux-packaged-check.js [exe]
 * Linux only. Exit code = check-packaged-app's.
 */

const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { startPrivateBus, hasDbusDaemon } = require('./fixtures/private-bus');
const { startFakePortal } = require('./fixtures/fake-portal');

const REPO = path.resolve(__dirname, '..');
const EXE = process.argv[2] || path.join(REPO, 'dist', 'linux-unpacked', 'sayanything');

async function main() {
  if (process.platform !== 'linux' || !hasDbusDaemon()) { console.log('linux-packaged-check: SKIP (Linux with dbus-daemon only)'); return 0; }
  if (!fs.existsSync(EXE)) { console.error('linux-packaged-check: no packaged app at ' + EXE); return 1; }
  const bus = await startPrivateBus();
  const fake = await startFakePortal(bus.address);
  const cfg = fs.mkdtempSync(path.join(os.tmpdir(), 'sa-linux-packaged-'));
  const args = [path.join(REPO, 'scripts', 'check-packaged-app.js'), EXE, '--electron-arg=--no-sandbox'];
  if (process.env.SA_TEST_MODEL) {
    const dataDir = path.join(cfg, 'SayAnything');
    fs.mkdirSync(path.join(dataDir, 'models'), { recursive: true });
    fs.copyFileSync(process.env.SA_TEST_MODEL, path.join(dataDir, 'models', 'ggml-tiny.en.bin'));
    fs.writeFileSync(path.join(dataDir, 'settings.json'), JSON.stringify({ model: 'tiny.en', welcomed: true }));
  } else {
    args.push('--model-optional');
  }
  try {
    return await new Promise(function (resolve) {
      const child = spawn(process.execPath, args, {
        stdio: 'inherit',
        env: Object.assign({}, process.env, { DBUS_SESSION_BUS_ADDRESS: bus.address, XDG_CONFIG_HOME: cfg }),
      });
      child.on('exit', function (code) { resolve(code == null ? 1 : code); });
    }).then(function (code) {
      const ids = fake.bound.map(function (b) { return b.id; }).join();
      const ok = ids === 'dictate,pad,cancel';
      console.log((ok ? 'PASS  ' : 'FAIL  ') + 'packaged app bound dictate, pad and cancel through the portal (' + ids + ')');
      return ok ? code : 1;
    });
  } finally {
    fake.stop();
    bus.stop();
    try { fs.rmSync(cfg, { recursive: true, force: true }); } catch (e) { /* ignore */ }
  }
}

main().then(function (code) { process.exit(code); }, function (e) { console.error(e); process.exit(1); });
