'use strict';

/**
 * History store (WS-10): opt-in, fail-closed, encrypted at rest when a keystore
 * exists, legacy plain files migrated, unreadable files moved aside.
 * Plain node; the keystore is a fake reversible codec.
 */

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createHistoryStore } = require('../src/main/stores/history');

let passed = 0;
let failed = 0;
function eq(a, b, label) {
  try { assert.deepStrictEqual(a, b); passed++; }
  catch (e) { failed++; console.error('FAIL: ' + label + '\n  expected ' + JSON.stringify(b) + '\n  actual   ' + JSON.stringify(a)); }
}

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sayanything-history-test-'));
let n = 0;
function fresh() { const d = path.join(root, String(++n)); fs.mkdirSync(d); return path.join(d, 'history.json'); }

// A fake keystore: reversible, and visibly not plaintext.
const fakeCodec = {
  encrypt: function (s) { return Buffer.from(Buffer.from(s, 'utf8').map(function (b) { return b ^ 0x5a; })); },
  decrypt: function (b) { return Buffer.from(b.map(function (x) { return x ^ 0x5a; })).toString('utf8'); },
};
function settingsWith(h) { return { get: function () { return { history: h }; } }; }
const quiet = { debug: function () {}, info: function () {}, warn: function () {}, error: function () {} };

// 1. Disabled (the default): nothing stored, no file written.
let file = fresh();
let s = createHistoryStore({ file: file, settings: settingsWith({ enabled: false, max: 200 }), log: quiet });
eq(s.add({ text: 'secret', ms: 1, app: 'x.exe' }), null, 'disabled: add is a no-op');
eq(fs.existsSync(file), false, 'disabled: no file written');

// 2. Settings unreadable: fail closed.
file = fresh();
s = createHistoryStore({ file: file, settings: { get: function () { throw new Error('boom'); } }, log: quiet });
eq(s.add({ text: 'secret' }), null, 'settings error: fails closed (nothing stored)');

// 3. Enabled with a keystore: encrypted on disk, readable through the store.
file = fresh();
s = createHistoryStore({ file: file, settings: settingsWith({ enabled: true, max: 200 }), getCodec: function () { return fakeCodec; }, log: quiet });
s.add({ text: 'meet Dana at noon', ms: 5, app: 'notepad.exe' });
const onDisk = fs.readFileSync(file, 'utf8');
eq(onDisk.indexOf('Dana'), -1, 'encrypted: transcript text not on disk in clear');
eq(onDisk.indexOf('notepad'), -1, 'encrypted: app name not on disk in clear');
eq(JSON.parse(onDisk).encrypted, true, 'encrypted: envelope marked encrypted');
eq(s.isEncrypted(), true, 'encrypted: isEncrypted() true');
const s2 = createHistoryStore({ file: file, settings: settingsWith({ enabled: true, max: 200 }), getCodec: function () { return fakeCodec; }, log: quiet });
eq(s2.list().map(function (e) { return e.text; }), ['meet Dana at noon'], 'encrypted: a new instance decrypts it');
if (process.platform !== 'win32') eq((fs.statSync(file).mode & 0o777), 0o600, 'file is owner-only (0600)');

// 4. Legacy plaintext file is migrated to encrypted on the next write.
file = fresh();
fs.writeFileSync(file, JSON.stringify([{ id: 'a', text: 'old entry', ms: 1, app: 'a.exe', at: 1 }]));
s = createHistoryStore({ file: file, settings: settingsWith({ enabled: true, max: 200 }), getCodec: function () { return fakeCodec; }, log: quiet });
eq(s.list().map(function (e) { return e.text; }), ['old entry'], 'legacy: plaintext still readable');
s.add({ text: 'new entry' });
eq(fs.readFileSync(file, 'utf8').indexOf('old entry'), -1, 'legacy: re-written encrypted after a change');
eq(s.list().map(function (e) { return e.text; }), ['new entry', 'old entry'], 'legacy: both entries kept, newest first');

// 5. No keystore: stays plaintext (no pretend encryption) and says so.
file = fresh();
const warnings = [];
s = createHistoryStore({ file: file, settings: settingsWith({ enabled: true, max: 200 }), getCodec: function () { return null; },
  log: { debug: function () {}, info: function () {}, error: function () {}, warn: function (m) { warnings.push(m); } } });
s.add({ text: 'plain' });
eq(Array.isArray(JSON.parse(fs.readFileSync(file, 'utf8'))), true, 'no keystore: plain JSON array');
eq(s.isEncrypted(), false, 'no keystore: isEncrypted() false');
eq(warnings.some(function (w) { return /unencrypted/.test(w); }), true, 'no keystore: warning logged');

// 6. Encrypted file but keystore now unavailable: not loaded, file kept intact.
file = fresh();
s = createHistoryStore({ file: file, settings: settingsWith({ enabled: true, max: 200 }), getCodec: function () { return fakeCodec; }, log: quiet });
s.add({ text: 'x' });
const before = fs.readFileSync(file, 'utf8');
s = createHistoryStore({ file: file, settings: settingsWith({ enabled: true, max: 200 }), getCodec: function () { return null; }, log: quiet });
eq(s.list(), [], 'locked keystore: empty list');
eq(fs.readFileSync(file, 'utf8'), before, 'locked keystore: encrypted file left untouched');

// 7. Undecryptable file is moved aside, never crashes.
file = fresh();
fs.writeFileSync(file, JSON.stringify({ v: 2, encrypted: true, data: 'not-really-base64-ciphertext' }));
const badCodec = { encrypt: fakeCodec.encrypt, decrypt: function () { throw new Error('bad key'); } };
s = createHistoryStore({ file: file, settings: settingsWith({ enabled: true, max: 200 }), getCodec: function () { return badCodec; }, log: quiet });
eq(s.list(), [], 'bad ciphertext: empty list');
eq(fs.existsSync(file), false, 'bad ciphertext: file moved aside');
eq(fs.readdirSync(path.dirname(file)).some(function (f) { return /^history\.unreadable-/.test(f); }), true, 'bad ciphertext: backup kept');

// 8. Cap and clear.
file = fresh();
s = createHistoryStore({ file: file, settings: settingsWith({ enabled: true, max: 2 }), getCodec: function () { return fakeCodec; }, log: quiet });
s.add({ text: '1' }); s.add({ text: '2' }); s.add({ text: '3' });
eq(s.list().map(function (e) { return e.text; }), ['3', '2'], 'cap: keeps the newest max entries');
s.clear();
eq(s.list(), [], 'clear: empty');
const s3 = createHistoryStore({ file: file, settings: settingsWith({ enabled: true, max: 2 }), getCodec: function () { return fakeCodec; }, log: quiet });
eq(s3.list(), [], 'clear: persisted');

try { fs.rmSync(root, { recursive: true, force: true }); } catch (e) { /* best effort */ }
console.log('history-test: ' + passed + ' passed, ' + failed + ' failed');
process.exit(failed > 0 ? 1 : 0);
