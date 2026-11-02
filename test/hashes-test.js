'use strict';

/**
 * Integrity-pin bookkeeping (WS-4). Plain node, no network.
 *
 * - every pin is a lowercase 64-hex SHA-256;
 * - every catalog model is either pinned or explicitly PENDING (so a new model
 *   cannot be added without a decision), and nothing is both;
 * - the default model is pinned (it is the one setup downloads);
 * - the pinning script's rewrite of hashes.js round-trips against the real file.
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const PINS = require('../src/main/whisper/hashes');
const models = require('../src/main/whisper/models');
const { rewriteHashesSource } = require('../scripts/pin-model-hashes');

let passed = 0;
let failed = 0;
function ok(cond, label, extra) {
  try { assert.ok(cond); passed++; }
  catch (e) { failed++; console.error('FAIL: ' + label + (extra ? ' (' + extra + ')' : '')); }
}

const names = models.catalog().map(function (m) { return m.name; });
const pending = PINS.PENDING;

ok(Array.isArray(pending), 'PENDING is exported');
for (const k of Object.keys(PINS)) {
  ok(/^[0-9a-f]{64}$/.test(PINS[k]), 'pin is 64 lowercase hex: ' + k);
}
for (const n of names) {
  const pinned = Object.prototype.hasOwnProperty.call(PINS, n);
  const isPending = pending.indexOf(n) !== -1;
  ok(pinned !== isPending, 'catalog model is pinned XOR pending: ' + n, 'pinned=' + pinned + ' pending=' + isPending);
}
for (const n of pending) ok(names.indexOf(n) !== -1, 'PENDING names a real catalog model: ' + n);
ok(Object.prototype.hasOwnProperty.call(PINS, 'small.en'), 'default model small.en is pinned');
ok(Object.keys(PINS).indexOf('PENDING') === -1, 'PENDING is not enumerated as a digest');

// catalog().verified is true exactly for the pinned models.
for (const m of models.catalog()) {
  ok(m.verified === Object.prototype.hasOwnProperty.call(PINS, m.name), 'catalog().verified reflects the pin: ' + m.name);
}

// Round-trip: rewriting with the same pins/pending reproduces the same data.
const file = path.join(__dirname, '..', 'src', 'main', 'whisper', 'hashes.js');
const src = fs.readFileSync(file, 'utf8');
// (independent of which models are currently pinned: uses a made-up name)
const fake = 'a'.repeat(64);
const load = function (text) { const mod = { exports: {} }; new Function('module', 'exports', text)(mod, mod.exports); return mod.exports; };
const grown = load(rewriteHashesSource(src, PINS, pending.concat(['example-model'])));
ok(grown.PENDING.indexOf('example-model') !== -1, 'rewrite: pending list written');
const next = load(rewriteHashesSource(src, Object.assign({}, PINS, { 'example-model': fake }), pending));
ok(next['example-model'] === fake, 'rewrite: new pin written');
ok(next['small.en'] === PINS['small.en'], 'rewrite: existing pin kept');
ok(next.PENDING.indexOf('example-model') === -1 && next.PENDING.length === pending.length, 'rewrite: pending shrinks');
ok(Object.keys(next).length === Object.keys(PINS).length + 1, 'rewrite: no pin lost');

console.log('hashes-test: ' + passed + ' passed, ' + failed + ' failed (' + pending.length + ' models still pending a pin)');
process.exit(failed > 0 ? 1 : 0);
