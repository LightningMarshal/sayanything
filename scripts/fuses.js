'use strict';

/**
 * Electron fuses for packaged builds (WS-12/WS-13 hardening).
 *
 * Fuses are switches compiled into the Electron binary. They are flipped once,
 * at package time (scripts/after-pack.js), and cannot be changed by the app or
 * by anyone running it. Each disabled fuse removes a way to make the shipped
 * executable run code it was not built to run:
 *
 *  - RunAsNode off: ELECTRON_RUN_AS_NODE=1 cannot turn Say Anything into a
 *    general-purpose Node.js interpreter (a common living-off-the-land trick,
 *    and on macOS this binary holds Input Monitoring / Accessibility grants).
 *  - EnableNodeOptionsEnvironmentVariable off: NODE_OPTIONS (e.g. --require)
 *    cannot inject code into the main process.
 *  - EnableNodeCliInspectArguments off: --inspect / --inspect-brk cannot attach
 *    a debugger to the main process.
 *  - EnableCookieEncryption on: cookies at rest are encrypted with the OS
 *    keystore (the app stores none today; defence in depth).
 *  - OnlyLoadAppFromAsar on: the app code is only loaded from app.asar, not
 *    from a loose app/ folder dropped next to it.
 *  - GrantFileProtocolExtraPrivileges off: file:// pages (our windows) get no
 *    special privileges beyond a normal web origin. All renderer checks pass
 *    with this off.
 *
 * Not enabled yet: EnableEmbeddedAsarIntegrityValidation needs asar integrity
 * hashes in the packaged app; to do with the electron-builder upgrade.
 *
 * @electron/fuses is an ES module, so it is loaded with import().
 */

/** Fuse name -> desired value (names are FuseV1Options keys). */
const FUSES = {
  RunAsNode: false,
  EnableCookieEncryption: true,
  EnableNodeOptionsEnvironmentVariable: false,
  EnableNodeCliInspectArguments: false,
  OnlyLoadAppFromAsar: true,
  GrantFileProtocolExtraPrivileges: false,
};

/**
 * Flip the fuses on a packaged Electron executable.
 * @param {string} electronBinary path to "Say Anything.exe", the .app bundle, or the Linux binary
 * @param {{ resetAdHocDarwinSignature?: boolean, overrides?: Object<string, boolean> }} [opts]
 *   overrides: fuse name -> value, for tests (e.g. running loose scripts needs OnlyLoadAppFromAsar off)
 */
async function applyFuses(electronBinary, opts) {
  const o = opts || {};
  const { flipFuses, FuseVersion, FuseV1Options } = await import('@electron/fuses');
  const wanted = Object.assign({}, FUSES, o.overrides || {});
  /** @type {any} */
  const config = { version: FuseVersion.V1 };
  for (const name of Object.keys(wanted)) {
    if (FuseV1Options[name] === undefined) throw new Error('unknown Electron fuse: ' + name);
    config[FuseV1Options[name]] = wanted[name];
  }
  if (o.resetAdHocDarwinSignature) config.resetAdHocDarwinSignature = true;
  await flipFuses(electronBinary, config);
}

module.exports = { FUSES: FUSES, applyFuses: applyFuses };
