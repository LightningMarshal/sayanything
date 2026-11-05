'use strict';

/*
 * Tests for packaging/appimage/launcher.sh, the AppImage launcher that adds
 * --no-sandbox ONLY on systems that block Chromium's sandbox inside an
 * AppImage. Runs the real script with a fake /proc (SAYANYTHING_PROC) and a
 * stub sayanything-bin that prints its arguments and environment.
 *
 * POSIX only (needs /bin/sh); skipped on Windows. Exit 1 on any failure.
 */

const { spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

let failures = 0;
let passes = 0;
function check(cond, msg) {
  if (cond) passes++;
  else { failures++; console.error('  FAIL- ' + msg); }
}

if (process.platform === 'win32') {
  console.log('appimage-launcher-test: SKIP (POSIX shell only)');
  process.exit(0);
}

const LAUNCHER = path.join(__dirname, '..', 'packaging', 'appimage', 'launcher.sh');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sa-launcher-'));
const app = path.join(tmp, 'app');
fs.mkdirSync(app);
fs.copyFileSync(LAUNCHER, path.join(app, 'sayanything'));
fs.chmodSync(path.join(app, 'sayanything'), 0o755);
// Stub Electron binary: one line per argument, then the marker env var.
fs.writeFileSync(path.join(app, 'sayanything-bin'),
  '#!/bin/sh\nfor a in "$@"; do echo "ARG $a"; done\necho "DISABLED=${SAYANYTHING_SANDBOX_DISABLED:-}"\n');
fs.chmodSync(path.join(app, 'sayanything-bin'), 0o755);

function fakeProc(values) {
  const root = fs.mkdtempSync(path.join(tmp, 'proc-'));
  for (const rel of Object.keys(values)) {
    const p = path.join(root, rel);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, values[rel] + '\n');
  }
  return root;
}

function launch(proc, extraEnv, args) {
  const env = Object.assign({}, process.env, { SAYANYTHING_PROC: proc }, extraEnv || {});
  delete env.SAYANYTHING_NO_SANDBOX;
  Object.assign(env, extraEnv || {});
  const r = spawnSync(path.join(app, 'sayanything'), args || ['--smoke', 'two words'], { env: env, encoding: 'utf8' });
  const argLines = r.stdout.split('\n').filter(function (l) { return l.indexOf('ARG ') === 0; }).map(function (l) { return l.slice(4); });
  return {
    status: r.status,
    args: argLines,
    disabledEnv: /DISABLED=1/.test(r.stdout),
    notice: /starting without it/.test(r.stderr),
  };
}

const AA = 'sys/kernel/apparmor_restrict_unprivileged_userns';
const CLONE = 'sys/kernel/unprivileged_userns_clone';
const MAXNS = 'sys/user/max_user_namespaces';

// Sandbox available: nothing added.
let r = launch(fakeProc({ [AA]: '0', [MAXNS]: '64000' }));
check(r.status === 0 && r.args.join('|') === '--smoke|two words', 'sandbox available: arguments passed through unchanged (' + r.args.join('|') + ')');
check(!r.notice && !r.disabledEnv, 'sandbox available: no notice, no marker');
r = launch(fakeProc({}));
check(r.args.indexOf('--no-sandbox') === -1, 'no userns sysctls at all (e.g. SteamOS, Arch): sandbox kept');

// Each blocking condition adds --no-sandbox, with the notice and the marker.
for (const [name, vals] of [
  ['Ubuntu AppArmor userns restriction', { [AA]: '1', [MAXNS]: '64000' }],
  ['unprivileged_userns_clone=0', { [CLONE]: '0' }],
  ['max_user_namespaces=0', { [MAXNS]: '0' }],
]) {
  r = launch(fakeProc(vals));
  check(r.args[0] === '--no-sandbox' && r.args.slice(1).join('|') === '--smoke|two words', name + ': --no-sandbox added first, other arguments kept');
  check(r.notice && r.disabledEnv, name + ': notice printed and SAYANYTHING_SANDBOX_DISABLED=1 exported');
}

// Overrides.
r = launch(fakeProc({ [AA]: '1' }), { SAYANYTHING_NO_SANDBOX: '0' });
check(r.args.indexOf('--no-sandbox') === -1, 'SAYANYTHING_NO_SANDBOX=0 never adds it, even when blocked');
r = launch(fakeProc({ [AA]: '0' }), { SAYANYTHING_NO_SANDBOX: '1' });
check(r.args[0] === '--no-sandbox' && r.notice, 'SAYANYTHING_NO_SANDBOX=1 forces it');

// Works through a symlink (AppImage tools sometimes link the executable).
const link = path.join(tmp, 'linked');
fs.symlinkSync(path.join(app, 'sayanything'), link);
const lr = spawnSync(link, ['x'], { env: Object.assign({}, process.env, { SAYANYTHING_PROC: fakeProc({}) }), encoding: 'utf8' });
check(lr.status === 0 && /ARG x/.test(lr.stdout), 'finds sayanything-bin next to the real script when started through a symlink');

fs.rmSync(tmp, { recursive: true, force: true });
console.log('appimage-launcher-test: ' + passes + ' passed, ' + failures + ' failed');
process.exit(failures ? 1 : 0);
