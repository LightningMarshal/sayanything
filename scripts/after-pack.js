'use strict';

/**
 * electron-builder `afterPack` hook (see package.json "build.afterPack").
 *
 * Runs for every platform's pack step. On every platform it flips the Electron
 * fuses (scripts/fuses.js); the rest only acts on darwin. electron-builder's
 * extraResources copy (bin/ -> Contents/Resources/bin, see package.json
 * "build.extraResources") can drop the executable bit on the staged native
 * binaries, so re-assert 0755 on the two mac binaries after packing, before
 * signing. (scripts/stage-bundle.js already chmods them in the source bin/
 * tree pre-pack; this is a belt-and-suspenders re-assert on the copies that
 * actually ship.)
 *
 * @param {import('electron-builder').AfterPackContext} context
 */
module.exports = async function afterPack(context) {
  const fs = require('fs');
  const path = require('path');

  const productFilename =
    (context.packager && context.packager.appInfo && context.packager.appInfo.productFilename) || 'Say Anything';

  // Every platform: flip the Electron fuses on the packaged executable (see
  // scripts/fuses.js). This runs before electron-builder signs the app, so the
  // signature covers the flipped binary. On macOS the ad-hoc signature is
  // refreshed so an unsigned arm64 build still launches.
  const { applyFuses } = require('./fuses');
  const platform = context.electronPlatformName;
  const exe = platform === 'darwin'
    ? path.join(context.appOutDir, productFilename + '.app')
    : platform === 'win32'
      ? path.join(context.appOutDir, productFilename + '.exe')
      : path.join(context.appOutDir, (context.packager && /** @type {any} */ (context.packager).executableName) || productFilename);
  await applyFuses(exe, { resetAdHocDarwinSignature: platform === 'darwin' });
  console.log('after-pack: Electron fuses applied to ' + exe);

  // Linux AppImage only: put packaging/appimage/launcher.sh in front of the
  // (already fused) Electron binary, which becomes sayanything-bin. The
  // launcher adds --no-sandbox only on systems that block Chromium's sandbox
  // inside an AppImage. Plain --dir builds (and so the Flatpak, which runs the
  // binary through zypak) are left alone.
  const targets = (context.targets || []).map(function (t) { return t && t.name; });
  if (platform === 'linux' && targets.indexOf('appImage') !== -1) {
    const bin = exe + '-bin';
    fs.renameSync(exe, bin);
    fs.copyFileSync(path.join(__dirname, '..', 'packaging', 'appimage', 'launcher.sh'), exe);
    fs.chmodSync(exe, 0o755);
    console.log('after-pack: AppImage launcher installed (' + path.basename(exe) + ' -> ' + path.basename(bin) + ')');
  }

  if (platform !== 'darwin') return;

  const resourcesDir = path.join(context.appOutDir, productFilename + '.app', 'Contents', 'Resources');

  const binaries = [
    path.join(resourcesDir, 'bin', 'helper', 'SayAnythingHelper'),
    path.join(resourcesDir, 'bin', 'whisper', 'whisper-server'),
  ];

  for (const bin of binaries) {
    if (fs.existsSync(bin)) {
      fs.chmodSync(bin, 0o755);
      console.log('after-pack: chmod 0755 ' + bin);
    } else {
      console.warn('after-pack: expected binary not found (skipping chmod): ' + bin);
    }
  }

  // electron-builder does not sign extraResources content, but every Mach-O in
  // the bundle needs a signature from the SAME identity as the app or TCC and
  // notarization both break (an ad-hoc helper under a signed app gets its own
  // unstable TCC row — the "duplicate Accessibility entries" trap). Signing
  // happens here, inside afterPack, so the outer app signature that
  // electron-builder applies NEXT seals over already-signed binaries
  // (inner-to-outer order). Set SS_MAC_SIGN_IDENTITY to the same identity the
  // build signs with; leave it unset for unsigned local builds.
  const identity = process.env.SS_MAC_SIGN_IDENTITY;
  if (identity) {
    const { execFileSync } = require('child_process');
    const entitlements = path.join(__dirname, '..', 'build-resources', 'entitlements.mac.inherit.plist');
    for (const bin of binaries) {
      if (!fs.existsSync(bin)) continue;
      execFileSync('codesign', [
        '--force', '--sign', identity,
        '--options', 'runtime',
        '--timestamp',
        '--entitlements', entitlements,
        bin,
      ], { stdio: 'inherit' });
      console.log('after-pack: signed ' + bin);
    }
  }
};
