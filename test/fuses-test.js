'use strict';

/**
 * The packaged-build fuse settings (scripts/fuses.js) stay hardened, and every
 * name is a real Electron fuse. Plain node. The fuses are flipped and read back
 * on a real packaged build by the Windows packaging CI job
 * (scripts/check-packaged-app.js).
 */

const assert = require('assert');
const { FUSES, applyFuses } = require('../scripts/fuses');

let passed = 0;
let failed = 0;
function eq(a, b, label) {
  try { assert.deepStrictEqual(a, b); passed++; }
  catch (e) { failed++; console.error('FAIL: ' + label + ' (expected ' + JSON.stringify(b) + ', got ' + JSON.stringify(a) + ')'); }
}

eq(FUSES.RunAsNode, false, 'RunAsNode disabled');
eq(FUSES.EnableNodeOptionsEnvironmentVariable, false, 'NODE_OPTIONS disabled');
eq(FUSES.EnableNodeCliInspectArguments, false, '--inspect disabled');
eq(FUSES.EnableCookieEncryption, true, 'cookie encryption enabled');
eq(FUSES.OnlyLoadAppFromAsar, true, 'only load app from asar');
eq(FUSES.GrantFileProtocolExtraPrivileges, false, 'no extra file:// privileges');

(async function () {
  const { FuseV1Options } = await import('@electron/fuses');
  for (const name of Object.keys(FUSES)) eq(typeof FuseV1Options[name], 'number', 'real fuse name: ' + name);
  let threw = false;
  try { await applyFuses('/nonexistent', { overrides: { NotAFuse: true } }); } catch (e) { threw = /unknown Electron fuse/.test(e.message); }
  eq(threw, true, 'unknown fuse names are rejected before touching any binary');
  console.log('fuses-test: ' + passed + ' passed, ' + failed + ' failed');
  process.exit(failed > 0 ? 1 : 0);
})().catch(function (e) { console.error(e); process.exit(1); });
