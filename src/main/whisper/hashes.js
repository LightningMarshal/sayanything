'use strict';

/**
 * Pinned SHA-256 digests for downloadable payloads.
 *
 * Supply-chain integrity: HTTPS authenticates the transport, but not that Hugging
 * Face / GitHub are serving the SAME bytes we vetted. A completed download whose
 * key is listed here MUST match its digest before it is renamed into place;
 * anything not listed is downloaded with a size check only and is shown as "not
 * hash-verified" in Settings → Model. These are the exact bytes fetched from the
 * pinned URLs and verified end-to-end (transcription works), so they are a
 * trust-on-first-use baseline — update deliberately if the pinned upstream
 * version ever changes.
 *
 * To pin the rest: run `node scripts/pin-model-hashes.js --write` on a machine
 * that can reach huggingface.co (or the "Pin model hashes" GitHub workflow). It
 * downloads each model, hashes it, cross-checks Hugging Face's own LFS sha256,
 * and rewrites PINS below. test/hashes-test.js fails if a catalog model is
 * neither pinned nor listed in PENDING.
 */

const PINS = {
  // whisper.cpp Windows x64 binaries zip (config.WHISPER_ZIP_CACHE).
  'whisper-bin-x64-v1.9.1.zip': '7d8be46ecd31828e1eb7a2ecdd0d6b314feafd82163038ab6092594b0a063539',
  // ggml models keyed by catalog name (file is ggml-<name>.bin).
  'small.en': 'c6138d6d58ecc8322097e0f987c32f1be8bb0a18532a3f88f734d1bbf9c41e5d',
  'tiny.en': '921e4cf8686fdd993dcd081a5da5b6c365bfde1162e72b08d75ac75289920b1f',
  'base.en': 'a03779c86df3323075f5e796cb2ce5029f00ec8869eee3fdfb897afe36c6d002',
  'medium.en': 'cc37e93478338ec7700281a7ac30a10128929eb8f427dda2e865faa8f6da4356',
  'large-v3-turbo': '1fc70f774d38eb169993ac391eea357ef47c88757ef72ee5943879b7e8e2bc69',
  'tiny': 'be07e048e1e599ad46341c8d2a135645097a538221678b7acdd1b1919c6e1b21',
  'base': '60ed5bc3dd14eea856493d334349b405782ddcaf0028d4b5df4088345fba2efe',
  'small': '1be3a9b2063867b937e64e2ec7483364a79917e157fa98c5d94b5c1fffea987b',
  'medium': '6c14d5adee5f86394037b4e4e8b59f1673b6cee10e3cf0b11bbdbee79c156208',
};

// Catalog models not yet pinned (downloads are size-checked only). This list may
// only shrink: test/hashes-test.js rejects a new catalog model that is neither
// pinned nor listed here.
const PENDING = [];

module.exports = PINS;
// Non-enumerable so `HASHES[name]` lookups and key listings see only digests.
Object.defineProperty(module.exports, 'PENDING', { value: PENDING, enumerable: false });
