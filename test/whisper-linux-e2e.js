'use strict';

/*
 * Real-engine end-to-end test on Linux (docs/LINUX-PORT.md step 4).
 *
 * Uses the REAL whisper-server built by scripts/build-whisper-linux.sh
 * (bin/whisper/whisper-server), the app's own model downloader (pinned
 * SHA-256, tiny.en), and the app's own server.js + client.js, to transcribe
 * whisper.cpp's samples/jfk.wav. Also checks the WS-13 lockdown against the
 * real binary, which CI could not do before:
 *   - every route sits behind the per-launch --request-path secret
 *     (unprefixed /inference, /load, /health and / are 404)
 *   - <secret>/health answers, and status() never contains the secret
 *
 * Env:
 *   SA_REQUIRE_WHISPER=1   fail (instead of skip) when the binary or the sample
 *                          is missing; set in CI
 *   SA_E2E_DATA            persistent dir for the downloaded model (default: a
 *                          temp dir, deleted afterwards)
 *   WHISPER_CPP_SRC_DIR    whisper.cpp source tree holding samples/jfk.wav
 *                          (default: the build script's clone location)
 *
 * Exit code: 0 on success or skip, 1 on any failed assertion.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

const REPO = path.resolve(__dirname, '..');
const REQUIRE = process.env.SA_REQUIRE_WHISPER === '1';
const EXE = path.join(REPO, 'bin', 'whisper', 'whisper-server');
const SRC = process.env.WHISPER_CPP_SRC_DIR ||
  path.join(process.env.XDG_CACHE_HOME || path.join(os.homedir(), '.cache'), 'SayAnything', 'whisper-build', 'whisper.cpp');
const WAV = path.join(SRC, 'samples', 'jfk.wav');

let failures = 0;
function check(cond, msg) {
  if (cond) console.log('  ok  - ' + msg);
  else { failures++; console.error('  FAIL- ' + msg); }
}

function skipOrFail(why) {
  if (REQUIRE) { check(false, why); return; }
  console.log('whisper-linux-e2e: SKIP (' + why + ')');
}

async function statusOf(url, method) {
  try {
    const res = await fetch(url, { method: method || 'GET', signal: AbortSignal.timeout(5000) });
    await res.arrayBuffer();
    return res.status;
  } catch (e) { return -1; }
}

async function main() {
  if (process.platform !== 'linux') { console.log('whisper-linux-e2e: SKIP (Linux only)'); return; }
  if (!fs.existsSync(EXE)) { skipOrFail('no whisper-server at ' + EXE + '; run scripts/build-whisper-linux.sh'); return; }
  if (!fs.existsSync(WAV)) { skipOrFail('no sample at ' + WAV); return; }

  // Isolate the app's data dir BEFORE config.js is loaded.
  const keepData = !!process.env.SA_E2E_DATA;
  const data = process.env.SA_E2E_DATA || fs.mkdtempSync(path.join(os.tmpdir(), 'sa-whisper-e2e-'));
  fs.mkdirSync(data, { recursive: true });
  process.env.XDG_CONFIG_HOME = data;
  process.env.HOME = data;

  const models = require('../src/main/whisper/models');
  const server = require('../src/main/whisper/server');
  const client = require('../src/main/whisper/client');
  try {
    console.log('whisper-linux-e2e: real whisper-server, tiny.en, jfk.wav');
    if (!fs.existsSync(models.pathFor('tiny.en'))) {
      console.log('  downloading tiny.en (verified against the pinned SHA-256)...');
      await models.download('tiny.en');
    }
    check(fs.existsSync(models.pathFor('tiny.en')), 'tiny.en model present (pinned hash verified by the downloader)');

    const st = await server.start('tiny.en', 18900);
    check(st.running === true && typeof st.port === 'number', 'real whisper-server started (port ' + st.port + ')');
    check(JSON.stringify(server.status()).indexOf(String(server.endpoint('').split('/').pop())) === -1, 'status() does not contain the request-path secret');

    const out = await client.transcribe(fs.readFileSync(WAV), { language: 'en' });
    const text = String(out && out.text || '');
    console.log('  transcript (' + out.ms + ' ms): ' + text.trim());
    // whisper breaks its output into segments on separate lines, so compare
    // with whitespace collapsed.
    check(/ask not what your country can do for you/i.test(text.replace(/\s+/g, ' ')), 'transcript matches the JFK sample');

    const base = 'http://127.0.0.1:' + st.port;
    check(await statusOf(server.endpoint('/health')) === 200, '<secret>/health answers 200');
    check(await statusOf(base + '/inference', 'POST') === 404, 'real binary: unprefixed POST /inference is 404');
    check(await statusOf(base + '/load', 'POST') === 404, 'real binary: unprefixed POST /load is 404');
    check(await statusOf(base + '/health') === 404, 'real binary: unprefixed GET /health is 404');
    check(await statusOf(base + '/') === 404, 'real binary: unprefixed GET / is 404');
  } finally {
    try { await server.stop(); } catch (e) { /* ignore */ }
    if (!keepData) { try { fs.rmSync(data, { recursive: true, force: true }); } catch (e) { /* ignore */ } }
  }
}

main().catch(function (e) {
  failures++;
  console.error('  FAIL- unexpected error: ' + (e && e.stack || e));
}).then(function () {
  console.log('whisper-linux-e2e: ' + (failures ? failures + ' failure(s)' : 'done'));
  process.exit(failures ? 1 : 0);
});
