'use strict';

/**
 * Docs-drift guard (WS-8): docs/CONTRACTS.md must describe what the code does.
 *
 *  1. Every helper command either native helper handles appears as `"cmd":"<x>"`.
 *  2. Every event either helper emits appears as `"evt":"<x>"`.
 *  3. The settings-schema JSON block has exactly the keys of the settings
 *     store's DEFAULTS, and the privacy-relevant defaults match.
 *  4. Every channel exported by src/main/ipc.js is mentioned.
 *
 * Plain node, no network. Run: `node test/docs-drift-test.js`.
 */

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.join(__dirname, '..');
// Normalise CRLF: Windows checkouts convert line endings, and the regexes below expect \n.
const read = function (p) { return fs.readFileSync(path.join(ROOT, p), 'utf8').replace(/\r\n/g, '\n'); };
const contracts = read('docs/CONTRACTS.md');
const cs = read('native/SayAnythingHelper.cs');
const swift = read('native/SayAnythingHelper.swift');

let passed = 0;
let failed = 0;
function ok(cond, label) {
  try { assert.ok(cond); passed++; } catch (e) { failed++; console.error('FAIL: ' + label); }
}
function all(re, s, group) {
  const out = new Set();
  let m;
  const g = new RegExp(re.source, re.flags.indexOf('g') === -1 ? re.flags + 'g' : re.flags);
  while ((m = g.exec(s)) !== null) out.add(m[group || 1]);
  return out;
}

// 1. commands
const swiftSwitch = (swift.match(/switch cmd \{([\s\S]*?)\n {4}\}/) || [])[1] || '';
ok(swiftSwitch.length > 0, 'found the Swift command switch');
const cmds = new Set([...all(/cmd == "([A-Za-z-]+)"/, cs), ...all(/case "([A-Za-z-]+)":/, swiftSwitch)]);
ok(cmds.size >= 10, 'found the helper commands (' + cmds.size + ')');
for (const c of cmds) ok(contracts.indexOf('"cmd":"' + c + '"') !== -1, 'CONTRACTS.md documents command "' + c + '"');

// 2. events
const evts = new Set([
  ...all(/EmitSimple\("([a-z-]+)"\)/, cs), ...all(/EmitResult\("([a-z-]+)"/, cs), ...all(/\\"evt\\":\\"([a-z-]+)/, cs),
  ...all(/emitSimple\("([a-z-]+)"\)/, swift), ...all(/emitResult\("([a-z-]+)"/, swift), ...all(/\\"evt\\":\\"([a-z-]+)/, swift),
]);
ok(evts.size >= 10, 'found the helper events (' + evts.size + ')');
for (const e of evts) ok(contracts.indexOf('"evt":"' + e + '"') !== -1, 'CONTRACTS.md documents event "' + e + '"');

// 3. settings schema
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sayanything-drift-'));
process.env.APPDATA = tmp; process.env.HOME = tmp; process.env.USERPROFILE = tmp;
const DEFAULTS = require('../src/main/stores/settings').DEFAULTS;
const block = (contracts.match(/## Settings schema[\s\S]*?```json\n([\s\S]*?)\n```/) || [])[1];
ok(!!block, 'found the settings-schema JSON block');
let doc = null;
try { doc = JSON.parse(block); } catch (e) { ok(false, 'settings-schema block is valid JSON: ' + e.message); }
function keyPaths(o, prefix) {
  const out = [];
  for (const k of Object.keys(o)) {
    const p = prefix ? prefix + '.' + k : k;
    if (o[k] && typeof o[k] === 'object' && !Array.isArray(o[k])) out.push(...keyPaths(o[k], p));
    else out.push(p);
  }
  return out;
}
if (doc) {
  const want = keyPaths(DEFAULTS);
  const have = keyPaths(doc);
  for (const p of want) ok(have.indexOf(p) !== -1, 'settings schema documents "' + p + '"');
  for (const p of have) ok(want.indexOf(p) !== -1, 'settings schema has no stale key "' + p + '"');
  for (const p of ['history.enabled', 'rewrite.enabled', 'pad.excludeFromClipboardHistory', 'rewrite.endpoint']) {
    const get = function (o) { return p.split('.').reduce(function (a, k) { return a && a[k]; }, o); };
    ok(get(doc) === get(DEFAULTS), 'documented default matches code: ' + p + ' (doc ' + JSON.stringify(get(doc)) + ', code ' + JSON.stringify(get(DEFAULTS)) + ')');
  }
}
try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (e) { /* best effort */ }

// 4. IPC channels
const ipc = require('../src/main/ipc');
for (const k of Object.keys(ipc)) {
  const v = ipc[k];
  if (typeof v === 'string' && /^[a-z]+:[A-Za-z-]+$/.test(v)) {
    ok(contracts.indexOf(v) !== -1, 'CONTRACTS.md mentions IPC channel ' + v);
  }
}

// 5. installer contents: internal docs and README media never ship; notices do.
const buildFiles = require('../package.json').build.files;
ok(!buildFiles.some(function (f) { return /^docs\b/.test(f); }), 'installer does not package docs/');
ok(buildFiles.indexOf('THIRD_PARTY_NOTICES.md') !== -1 && fs.existsSync(path.join(ROOT, 'THIRD_PARTY_NOTICES.md')), 'installer ships THIRD_PARTY_NOTICES.md');
ok(buildFiles.indexOf('LICENSE') !== -1, 'installer ships LICENSE');
ok(buildFiles.indexOf('!assets/demo.gif') !== -1, 'installer excludes README media');

console.log('docs-drift-test: ' + passed + ' passed, ' + failed + ' failed');
process.exit(failed > 0 ? 1 : 0);
