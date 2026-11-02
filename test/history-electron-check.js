'use strict';

/**
 * Run under Electron: `electron test/history-electron-check.js`.
 * Verifies that, with the REAL OS keystore (Electron safeStorage: DPAPI on
 * Windows, Keychain on macOS), the history store writes no transcript text in
 * the clear and reads it back. Exits non-zero on failure. Used by Windows CI.
 */

const { app } = require('electron');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createHistoryStore, _electronCodec } = require('../src/main/stores/history');

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
  app.exit(ok ? 0 : 1);
});
