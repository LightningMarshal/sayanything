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
  // whisper.cpp v1.9.1 Windows x64 binaries zip (config.WHISPER_ZIP_CACHE).
  'whisper-bin-x64-v1.9.1.zip': '7d8be46ecd31828e1eb7a2ecdd0d6b314feafd82163038ab6092594b0a063539',
  // ggml models keyed by catalog name (file is ggml-<name>.bin). The default is
  // pinned; add others here as their digests are vetted.
  'small.en': 'c6138d6d58ecc8322097e0f987c32f1be8bb0a18532a3f88f734d1bbf9c41e5d',
};

// Catalog models not yet pinned (downloads are size-checked only). This list may
// only shrink: test/hashes-test.js rejects a new catalog model that is neither
// pinned nor listed here.
const PENDING = ['tiny.en', 'base.en', 'medium.en', 'large-v3-turbo', 'tiny', 'base', 'small', 'medium'];

module.exports = PINS;
// Non-enumerable so `HASHES[name]` lookups and key listings see only digests.
Object.defineProperty(module.exports, 'PENDING', { value: PENDING, enumerable: false });
