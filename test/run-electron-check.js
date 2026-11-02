'use strict';

/**
 * Run an Electron-based check and judge it by the verdict it writes, not by
 * Electron's process exit code.
 *
 *   node test/run-electron-check.js test/history-electron-check.js [electron flags...]
 *
 * Why: on Windows CI, Electron intermittently exits with code 1 during
 * teardown even after the check has finished and passed (observed on
 * windows-latest with every assertion PASS and "ok" printed). The check's
 * assertions are what is under test, so the check writes {"ok":true|false} to
 * the file named by SAYANYTHING_CHECK_RESULT before quitting. No file, an
 * unreadable file, or ok:false fails the run, so a crash or hang before the
 * verdict still fails. A timeout fails too.
 */

const cp = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const script = process.argv[2];
if (!script) { console.error('usage: node test/run-electron-check.js <check.js>'); process.exit(2); }

const electronBin = require('electron'); // the binary path when required from node
const resultFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'sayanything-check-')), 'result.json');
const TIMEOUT_MS = 120000;

const child = cp.spawn(electronBin, [script].concat(process.argv.slice(3)), {
  stdio: 'inherit',
  env: Object.assign({}, process.env, { SAYANYTHING_CHECK_RESULT: resultFile }),
});
const timer = setTimeout(function () {
  console.error('run-electron-check: timed out after ' + TIMEOUT_MS + ' ms');
  try { child.kill(); } catch (e) { /* ignore */ }
}, TIMEOUT_MS);

child.on('close', function (code, signal) {
  clearTimeout(timer);
  let verdict;
  try { verdict = JSON.parse(fs.readFileSync(resultFile, 'utf8')); } catch (e) { verdict = null; }
  try { fs.rmSync(path.dirname(resultFile), { recursive: true, force: true }); } catch (e) { /* ignore */ }
  const ok = !!(verdict && verdict.ok === true);
  console.log('run-electron-check: verdict=' + (verdict ? JSON.stringify(verdict) : 'none') +
    ' electron exit=' + code + (signal ? ' signal=' + signal : ''));
  process.exit(ok ? 0 : 1);
});
