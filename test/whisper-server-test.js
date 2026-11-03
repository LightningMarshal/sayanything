'use strict';

/*
 * whisper-server lifecycle + request-path secret test (WS-13). Plain Node, runs
 * on every CI OS.
 *
 * whisper-server has no auth and sends `Access-Control-Allow-Origin: *`, so
 * server.js launches it with a random `--request-path` and client.js must use it.
 * No real whisper binary is needed: child_process.spawn is wrapped BEFORE
 * server.js is required (it destructures spawn at load time) so the "server exe"
 * is this file's sibling fake, test/fixtures/fake-whisper-server.js, run under
 * the current Node. The fake mimics whisper.cpp v1.9.1 routing: every route
 * lives under --request-path, anything else is 404, and it logs each request
 * path to stdout. Asserts:
 *   A) launch passes --request-path /<32 hex> and binds 127.0.0.1
 *   B) start() resolves only once <secret>/health answers
 *   C) status() (which reaches the renderer) never contains the secret
 *   D) client.transcribe() reaches <secret>/inference and parses the text
 *   E) the unprefixed /inference, /load and /health routes are 404
 *   F) restart() rotates the secret; stop() clears endpoint()
 *
 * Exit code: 0 on success, 1 on any failed assertion.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const childProcess = require('child_process');

const FAKE = path.join(__dirname, 'fixtures', 'fake-whisper-server.js');
const realSpawn = childProcess.spawn;
/** @type {string[][]} */
const launches = [];
/** @type {string[]} */
const seenPaths = [];
// @ts-ignore -- test-only monkeypatch of the cached module object
childProcess.spawn = function (exe, args, opts) {
  launches.push(args.slice());
  const child = realSpawn(process.execPath, [FAKE].concat(args), opts);
  child.stdout.on('data', function (d) {
    String(d).split('\n').forEach(function (l) { if (l.indexOf('PATH ') === 0) seenPaths.push(l.slice(5).trim()); });
  });
  return child;
};

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sa-whisper-test-'));
const fakeModel = path.join(tmp, 'ggml-fake.bin');
fs.writeFileSync(fakeModel, 'not a real model');

const models = require('../src/main/whisper/models');
const binaries = require('../src/main/whisper/binaries');
// @ts-ignore -- test-only monkeypatch
models.pathFor = function () { return fakeModel; };
// @ts-ignore -- test-only monkeypatch
binaries.serverExe = function () { return process.execPath; };

const server = require('../src/main/whisper/server');
const client = require('../src/main/whisper/client');

let failures = 0;
function check(cond, msg) {
  if (cond) { console.log('  ok  - ' + msg); }
  else { failures++; console.error('  FAIL- ' + msg); }
}

function argAfter(args, flag) {
  const i = args.indexOf(flag);
  return i === -1 ? null : args[i + 1];
}

async function status(url, method) {
  try {
    const res = await fetch(url, { method: method || 'GET', signal: AbortSignal.timeout(3000) });
    await res.arrayBuffer();
    return res.status;
  } catch (e) {
    return -1;
  }
}

// The fake logs request paths on stdout, which can arrive after the HTTP
// response; wait (bounded) until at least `n` new paths since `from` are in.
async function pathsSince(from, n) {
  const deadline = Date.now() + 2000;
  while (seenPaths.length - from < n && Date.now() < deadline) {
    await new Promise(function (r) { setTimeout(r, 20); });
  }
  return seenPaths.slice(from);
}

function wavOf(seconds) {
  const n = Math.round(16000 * seconds);
  const b = Buffer.alloc(44 + n * 2);
  b.write('RIFF', 0); b.writeUInt32LE(36 + n * 2, 4); b.write('WAVE', 8);
  b.write('fmt ', 12); b.writeUInt32LE(16, 16); b.writeUInt16LE(1, 20); b.writeUInt16LE(1, 22);
  b.writeUInt32LE(16000, 24); b.writeUInt32LE(32000, 28); b.writeUInt16LE(2, 32); b.writeUInt16LE(16, 34);
  b.write('data', 36); b.writeUInt32LE(n * 2, 40);
  return b;
}

async function main() {
  console.log('whisper-server request-path secret');

  const st = await server.start('fake', 18737);
  const args = launches[0] || [];
  const rp = argAfter(args, '--request-path');
  check(st.running === true && typeof st.port === 'number', 'A) start() resolves running with a port');
  check(typeof rp === 'string' && /^\/[0-9a-f]{32}$/.test(rp), 'A) launched with --request-path /<32 hex> (got ' + rp + ')');
  check(argAfter(args, '--host') === '127.0.0.1', 'A) bound to 127.0.0.1 only');
  check((await pathsSince(0, 1)).indexOf(rp + '/health') !== -1, 'B) readiness probed <secret>/health');

  const secret = rp ? rp.slice(1) : 'missing';
  check(JSON.stringify(server.status()).indexOf(secret) === -1, 'C) status() does not expose the secret');

  const before = seenPaths.length;
  const out = await client.transcribe(wavOf(0.5), { language: 'en' });
  check(out && out.text === 'fake transcript', 'D) transcribe() returns the server text');
  const hit = await pathsSince(before, 1);
  check(hit.length === 1 && hit[0] === rp + '/inference', 'D) transcribe() hit <secret>/inference only (got ' + hit.join(',') + ')');

  const part = await client.transcribePartial(wavOf(0.5), {});
  check(part && part.text === 'fake transcript', 'D) transcribePartial() also uses the secret endpoint');

  const base = 'http://127.0.0.1:' + st.port;
  check(await status(base + '/inference', 'POST') === 404, 'E) unprefixed POST /inference is 404');
  check(await status(base + '/load', 'POST') === 404, 'E) unprefixed POST /load is 404');
  check(await status(base + '/health') === 404, 'E) unprefixed GET /health is 404');
  check(await status(base + '/') === 404, 'E) unprefixed GET / is 404');

  await server.restart();
  const rp2 = argAfter(launches[1] || [], '--request-path');
  check(typeof rp2 === 'string' && rp2 !== rp && /^\/[0-9a-f]{32}$/.test(rp2), 'F) restart() rotates the secret');
  const ep = server.endpoint('/inference');
  check(typeof ep === 'string' && ep.indexOf(rp2 + '/inference') !== -1, 'F) endpoint() follows the new secret');

  await server.stop();
  check(server.endpoint('/inference') === null, 'F) endpoint() is null after stop()');
  let threw = false;
  try { await client.transcribe(wavOf(0.2)); } catch (e) { threw = /not running/.test(String(e && e.message)); }
  check(threw, 'F) transcribe() after stop() rejects with "not running"');
}

main().catch(function (e) {
  failures++;
  console.error('  FAIL- unexpected error: ' + (e && e.stack || e));
}).then(async function () {
  try { await server.stop(); } catch (e) { /* ignore */ }
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (e) { /* ignore */ }
  if (failures) { console.error(failures + ' failure(s)'); process.exit(1); }
  console.log('all whisper-server checks passed');
  process.exit(0);
});
