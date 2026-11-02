'use strict';

/**
 * Renderer permission policy (src/main/media-permissions.js): microphone only.
 * Plain node. Includes install() against a fake Electron session.
 */

const assert = require('assert');
const { audioOnlyAllowed, install } = require('../src/main/media-permissions');

let passed = 0;
let failed = 0;
function eq(a, b, label) {
  try { assert.strictEqual(a, b); passed++; }
  catch (e) { failed++; console.error('FAIL: ' + label + ' (expected ' + b + ', got ' + a + ')'); }
}

eq(audioOnlyAllowed('media', { mediaTypes: ['audio'] }), true, 'mic request allowed');
eq(audioOnlyAllowed('media', { mediaTypes: ['video'] }), false, 'camera request denied');
eq(audioOnlyAllowed('media', { mediaTypes: ['audio', 'video'] }), false, 'mic+camera request denied');
eq(audioOnlyAllowed('media', { mediaType: 'video' }), false, 'camera check denied');
eq(audioOnlyAllowed('media', { mediaType: 'audio' }), true, 'mic check allowed');
eq(audioOnlyAllowed('microphone'), true, 'microphone permission allowed');
for (const p of ['notifications', 'geolocation', 'clipboard-read', 'clipboard-sanitized-write', 'display-capture',
  'midi', 'midiSysex', 'pointerLock', 'fullscreen', 'openExternal', 'hid', 'serial', 'usb', 'unknown']) {
  eq(audioOnlyAllowed(p, {}), false, p + ' denied');
}

// install(): the session's request and check handlers apply the same policy.
const ses = {};
ses.setPermissionRequestHandler = function (fn) { ses.req = fn; };
ses.setPermissionCheckHandler = function (fn) { ses.chk = fn; };
install(ses);
let answer = null;
ses.req(null, 'media', function (v) { answer = v; }, { mediaTypes: ['video'] });
eq(answer, false, 'installed request handler denies camera');
ses.req(null, 'media', function (v) { answer = v; }, { mediaTypes: ['audio'] });
eq(answer, true, 'installed request handler allows mic');
eq(ses.chk(null, 'geolocation', 'file://', {}), false, 'installed check handler denies geolocation');
install(null); // no session: no throw

console.log('media-permissions-test: ' + passed + ' passed, ' + failed + ' failed');
process.exit(failed > 0 ? 1 : 0);
