'use strict';

/**
 * Boot module loading (WS-11): a broken REQUIRED module must be reported as
 * fatal (main.js shows a dialog and exits) instead of the app idling in the
 * tray; optional modules degrade. Plain node, fake require.
 */

const assert = require('assert');
const boot = require('../src/main/boot-modules');

let passed = 0;
let failed = 0;
function eq(a, b, label) {
  try { assert.deepStrictEqual(a, b); passed++; }
  catch (e) { failed++; console.error('FAIL: ' + label + '\n  expected ' + JSON.stringify(b) + '\n  actual   ' + JSON.stringify(a)); }
}

function fakeRequire(broken) {
  return function (id) {
    if (broken.indexOf(id) !== -1) throw new Error('Cannot find module \'' + id + '\'\nRequire stack: ...');
    return { id: id };
  };
}

// All good.
let r = boot.loadModules(fakeRequire([]));
eq(r.failures.length, 0, 'healthy: no failures');
eq(r.mods.state, { id: './state' }, 'healthy: modules exposed by key');
eq(boot.fatalFailures(r.failures).length, 0, 'healthy: nothing fatal');

// Optional module broken: degrades, not fatal.
r = boot.loadModules(fakeRequire(['./tray', './whisper/rewrite']));
eq(r.mods.tray, null, 'optional broken: null module');
eq(r.failures.length, 2, 'optional broken: both recorded');
eq(boot.fatalFailures(r.failures).length, 0, 'optional broken: not fatal');

// Required module broken: fatal, with a readable message.
r = boot.loadModules(fakeRequire(['./state', './tray']));
const fatal = boot.fatalFailures(r.failures);
eq(fatal.map(function (f) { return f.id; }), ['./state'], 'required broken: only the required one is fatal');
const msg = boot.fatalMessage(fatal, '/logs/SayAnything.log');
eq(/dictation state machine \(\.\/state\): Cannot find module '\.\/state'$/m.test(msg), true, 'message names the part and the error (first line only)');
eq(msg.indexOf('Require stack') === -1, true, 'message omits the stack');
eq(msg.indexOf('/logs/SayAnything.log') !== -1, true, 'message points at the log');

// The real spec: the parts dictation cannot work without are required.
const required = boot.SPEC.filter(function (m) { return m.required; }).map(function (m) { return m.key; });
for (const k of ['state', 'helper', 'settingsStore', 'windows', 'audioSession', 'server', 'ipc', 'config']) {
  eq(required.indexOf(k) !== -1, true, 'spec: ' + k + ' is required');
}
for (const k of ['tray', 'rewriter', 'models', 'historyStore', 'permissions', 'log']) {
  eq(required.indexOf(k) === -1, true, 'spec: ' + k + ' is optional');
}

console.log('boot-modules-test: ' + passed + ' passed, ' + failed + ' failed');
process.exit(failed > 0 ? 1 : 0);
