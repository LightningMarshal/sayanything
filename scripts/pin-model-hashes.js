'use strict';

/**
 * Compute and pin SHA-256 digests for every catalog model (WS-4).
 *
 *   node scripts/pin-model-hashes.js            # report only
 *   node scripts/pin-model-hashes.js --write    # also rewrite src/main/whisper/hashes.js
 *   node scripts/pin-model-hashes.js --only tiny.en,base.en
 *
 * NETWORK: downloads every selected model from huggingface.co (75 MB to 1.6 GB
 * each, about 6 GB for the full catalog) into a temp dir that is deleted after
 * hashing. Run it on a machine or CI runner with the bandwidth and disk for that.
 *
 * Two independent checks must agree before a digest is pinned:
 *   1. the SHA-256 of the bytes actually downloaded (computed here), and
 *   2. the sha256 Hugging Face publishes for the file in its Git LFS metadata
 *      (api/models/<repo>/tree/main -> lfs.oid), plus the LFS size.
 * A mismatch is reported and nothing is written for that model.
 * Already-pinned models are re-verified against their existing pin.
 */

const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { MODEL_BASE_URL } = require('../src/main/config');
const models = require('../src/main/whisper/models');
const PINS = require('../src/main/whisper/hashes');

const HASHES_FILE = path.join(__dirname, '..', 'src', 'main', 'whisper', 'hashes.js');
const HF_TREE_URL = 'https://huggingface.co/api/models/ggerganov/whisper.cpp/tree/main';

function arg(name) {
  const i = process.argv.indexOf(name);
  return i === -1 ? null : (process.argv[i + 1] || '');
}

async function hfLfsIndex() {
  console.log('fetching Hugging Face LFS metadata: ' + HF_TREE_URL);
  const res = await fetch(HF_TREE_URL, { redirect: 'follow' });
  if (!res.ok) throw new Error('HF metadata HTTP ' + res.status);
  const list = await res.json();
  const idx = {};
  for (const f of list) {
    if (f && f.path && f.lfs && f.lfs.oid) idx[f.path] = { sha256: f.lfs.oid, size: f.lfs.size };
  }
  return idx;
}

async function downloadAndHash(url, tmpFile) {
  const res = await fetch(url, { redirect: 'follow' });
  if (!res.ok) throw new Error('HTTP ' + res.status + ' for ' + url);
  const h = crypto.createHash('sha256');
  const out = fs.createWriteStream(tmpFile);
  let bytes = 0;
  for await (const chunk of /** @type {any} */ (res.body)) {
    h.update(chunk);
    bytes += chunk.length;
    if (!out.write(chunk)) await new Promise(function (r) { out.once('drain', r); });
  }
  await new Promise(function (r) { out.end(function () { r(undefined); }); });
  return { sha256: h.digest('hex'), size: bytes };
}

// Rewrite the PINS object and PENDING list in hashes.js source text. PURE (string
// in, string out) so test/hashes-test.js can check it against the real file.
function rewriteHashesSource(src, pins, pending) {
  const keys = Object.keys(pins);
  const winZip = keys.filter(function (k) { return /\.zip$/.test(k); });
  const modelKeys = keys.filter(function (k) { return !/\.zip$/.test(k); });
  const lines = ['const PINS = {'];
  for (const k of winZip) {
    lines.push('  // whisper.cpp Windows x64 binaries zip (config.WHISPER_ZIP_CACHE).');
    lines.push('  ' + JSON.stringify(k).replace(/"/g, "'") + ": '" + pins[k] + "',");
  }
  lines.push('  // ggml models keyed by catalog name (file is ggml-<name>.bin).');
  for (const k of modelKeys) lines.push('  ' + JSON.stringify(k).replace(/"/g, "'") + ": '" + pins[k] + "',");
  lines.push('};');
  src = src.replace(/const PINS = \{[\s\S]*?\n\};/, lines.join('\n'));
  src = src.replace(/const PENDING = \[[^\]]*\];/,
    'const PENDING = [' + pending.map(function (n) { return "'" + n + "'"; }).join(', ') + '];');
  return src;
}

async function main() {
  const only = arg('--only');
  const write = process.argv.indexOf('--write') !== -1;
  let names = models.catalog().map(function (m) { return m.name; });
  if (only) names = names.filter(function (n) { return only.split(',').indexOf(n) !== -1; });

  const lfs = await hfLfsIndex();
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sayanything-pin-'));
  const pins = Object.assign({}, PINS);
  let failures = 0;

  try {
    for (const name of names) {
      const file = 'ggml-' + name + '.bin';
      const meta = lfs[file];
      if (!meta) { console.error('FAIL ' + name + ': no LFS metadata for ' + file); failures++; continue; }
      console.log('downloading ' + file + ' (' + Math.round(meta.size / 1048576) + ' MB)...');
      const tmpFile = path.join(tmp, file);
      const got = await downloadAndHash(MODEL_BASE_URL + file, tmpFile);
      try { fs.unlinkSync(tmpFile); } catch (e) { /* best effort */ }
      const problems = [];
      if (got.sha256 !== meta.sha256) problems.push('downloaded ' + got.sha256 + ' != HF LFS ' + meta.sha256);
      if (got.size !== meta.size) problems.push('size ' + got.size + ' != HF LFS ' + meta.size);
      if (PINS[name] && PINS[name] !== got.sha256) problems.push('existing pin ' + PINS[name] + ' != downloaded');
      if (problems.length) { console.error('FAIL ' + name + ': ' + problems.join('; ')); failures++; continue; }
      console.log('ok   ' + name + ' ' + got.sha256 + ' (' + got.size + ' bytes)');
      pins[name] = got.sha256;
    }
  } finally {
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (e) { /* best effort */ }
  }

  const pending = models.catalog().map(function (m) { return m.name; })
    .filter(function (n) { return !Object.prototype.hasOwnProperty.call(pins, n); });
  if (write) {
    fs.writeFileSync(HASHES_FILE, rewriteHashesSource(fs.readFileSync(HASHES_FILE, 'utf8'), pins, pending));
    console.log('wrote ' + path.relative(process.cwd(), HASHES_FILE) + ' (pending: ' + (pending.join(', ') || 'none') + ')');
  }
  console.log('\nsummary: ' + (names.length - failures) + ' verified, ' + failures + ' failed');
  process.exit(failures ? 1 : 0);
}

if (require.main === module) {
  main().catch(function (e) {
    console.error('pin-model-hashes: ' + (e && e.stack || e));
    process.exit(1);
  });
}

module.exports = { rewriteHashesSource: rewriteHashesSource };
