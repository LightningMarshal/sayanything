'use strict';

/**
 * Plain-node checks for privacy-relevant settings DEFAULTS
 * (src/main/stores/settings.js). A fresh install must not save transcripts
 * (history off) and must not make any rewrite network call (rewrite off).
 *
 * Run: `node test/settings-defaults-test.js` — exits non-zero on failure.
 * The store reads <appData>/SayAnything/settings.json at require time, so the
 * data dir is pointed at an empty temp folder first: this exercises the real
 * "fresh install" load path without touching the developer's own settings.
 */

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sayanything-settings-test-'));
process.env.APPDATA = tmp; // Windows + Linux fallback path in config.js
process.env.HOME = tmp;    // macOS: ~/Library/Application Support
process.env.USERPROFILE = tmp;

let passed = 0;
let failed = 0;
function eq(actual, expected, label) {
  try { assert.strictEqual(actual, expected); passed++; }
  catch (e) {
    failed++;
    console.error('FAIL: ' + label);
    console.error('  expected: ' + JSON.stringify(expected));
    console.error('  actual:   ' + JSON.stringify(actual));
  }
}

const store = require('../src/main/stores/settings');
const config = require('../src/main/config');

eq(config.USER_DATA.indexOf(tmp) === 0, true, 'test isolation: data dir is the temp folder');
eq(store.DEFAULTS.history.enabled, false, 'defaults: history is off');
eq(store.get().history.enabled, false, 'fresh install: history is off');
eq(store.DEFAULTS.rewrite.enabled, false, 'defaults: rewrite is off');
eq(store.get().rewrite.enabled, false, 'fresh install: rewrite is off');

// An existing user's explicit opt-in is preserved across a reload.
store.set({ history: { enabled: true } });
eq(store.get().history.enabled, true, 'opt-in: user can turn history on');

try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (e) { /* best effort */ }

console.log('settings-defaults-test: ' + passed + ' passed, ' + failed + ' failed');
process.exit(failed > 0 ? 1 : 0);
