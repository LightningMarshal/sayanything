'use strict';

/**
 * Run via `node test/run-electron-check.js test/history-electron-check.js`
 * (which judges the verdict file, see that script), or directly under Electron.
 * Verifies that, with the REAL OS keystore (Electron safeStorage: DPAPI on
 * Windows, Keychain on macOS), the history store writes no transcript text in
 * the clear and reads it back. Exits non-zero on failure. Used by Windows CI.
 */

const { app } = require('electron');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createHistoryStore, _electronCodec } = require('../src/main/stores/history');

// No GPU process: this check never draws, and skipping GPU start-up keeps
// Electron's teardown short and quiet.
app.disableHardwareAcceleration();

app.whenReady().then(function () {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sayanything-history-electron-'));
  const file = path.join(dir, 'history.json');
  const settings = { get: function () { return { history: { enabled: true, max: 10 } }; } };
  const results = [];
  function check(name, ok, extra) { results.push(ok); console.log((ok ? 'PASS  ' : 'FAIL  ') + name + (extra ? '  (' + extra + ')' : '')); }

  const codec = _electronCodec();
  const expectKeystore = (process.platform === 'win32' || process.platform === 'darwin');
  check('OS keystore available', !!codec || !expectKeystore, 'platform=' + process.platform);

  const s = createHistoryStore({ file: file, settings: settings, getCodec: _electronCodec });
  s.add({ text: 'electron-check transcript', ms: 1, app: 'check.exe' });
  const raw = fs.readFileSync(file, 'utf8');
  if (codec) {
    check('history encrypted on disk', raw.indexOf('electron-check transcript') === -1 && JSON.parse(raw).encrypted === true);
  }
  const again = createHistoryStore({ file: file, settings: settings, getCodec: _electronCodec });
  check('history readable after restart', again.list()[0] && again.list()[0].text === 'electron-check transcript');

  try { fs.rmSync(dir, { recursive: true, force: true }); } catch (e) { /* best effort */ }
  const ok = results.every(Boolean);
  console.log('history-electron-check: ' + (ok ? 'ok' : 'FAILED'));
  if (process.env.SAYANYTHING_CHECK_RESULT) {
    try { fs.writeFileSync(process.env.SAYANYTHING_CHECK_RESULT, JSON.stringify({ ok: ok })); }
    catch (e) { console.error('could not write verdict: ' + e.message); }
  }
  app.exit(ok ? 0 : 1);
});
