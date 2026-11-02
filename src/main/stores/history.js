'use strict';

/**
 * History store.
 *
 * Persists the last N transcriptions to <USER_DATA>/history.json, most-recent
 * first. `add` is a no-op when history is disabled in settings (the default) and
 * always caps the list at settings.history.max. Writes are atomic (tmp + rename);
 * a corrupt or undecryptable file is backed up and the list resets to empty
 * rather than throwing.
 *
 * Encryption at rest (WS-10): when the OS keystore is available (Electron
 * safeStorage: DPAPI on Windows, Keychain on macOS), the file holds an envelope
 * { v: 2, encrypted: true, data: <base64 ciphertext> } instead of plain JSON, so
 * another user account, a backup tool or a synced folder sees no transcript
 * text. A legacy plain-JSON array is read once and re-written encrypted on the
 * next change. Where no real keystore exists (e.g. Linux without a keyring,
 * where Electron falls back to a fixed key) the file stays plain JSON and a
 * warning is logged; it is never "encrypted" with a key that protects nothing.
 *
 * Loading is lazy (first list/add/remove/clear), because safeStorage is only
 * usable after Electron's `ready` event.
 *
 * Entry shape: { id, text, ms, app, at } where `ms` is the transcription time in
 * milliseconds, `app` is the foreground exe captured at finalize, and `at` is the
 * wall-clock timestamp the entry was stored.
 *
 * API: add({text, ms, app}) -> entry|null, list() -> entries, remove(id),
 * clear(), isEncrypted(). createHistoryStore(deps) builds an instance with
 * injected file path, settings, codec and clock (used by test/history-test.js).
 */

const fs = require('fs');
const path = require('path');

function noop() {}

/**
 * The real keystore codec, or null when no trustworthy keystore is available.
 * @returns {{encrypt:(s:string)=>Buffer, decrypt:(b:Buffer)=>string}|null}
 */
function electronCodec() {
  let safeStorage;
  try { safeStorage = require('electron').safeStorage; } catch (e) { return null; }
  if (!safeStorage || typeof safeStorage.isEncryptionAvailable !== 'function') return null;
  try {
    if (!safeStorage.isEncryptionAvailable()) return null;
    // Linux: 'basic_text' means a hard-coded key, i.e. no real protection.
    if (process.platform === 'linux' && typeof safeStorage.getSelectedStorageBackend === 'function' &&
        safeStorage.getSelectedStorageBackend() === 'basic_text') return null;
  } catch (e) { return null; }
  return {
    encrypt: function (s) { return safeStorage.encryptString(s); },
    decrypt: function (b) { return safeStorage.decryptString(b); },
  };
}

/**
 * @param {object} deps
 * @param {string} deps.file           path of history.json
 * @param {{get:()=>any}} deps.settings settings store
 * @param {() => ({encrypt:(s:string)=>Buffer, decrypt:(b:Buffer)=>string}|null)} [deps.getCodec]
 * @param {{debug:Function, info:Function, warn:Function, error:Function}} [deps.log]
 * @param {() => number} [deps.now]
 */
function createHistoryStore(deps) {
  const FILE = deps.file;
  const TMP = FILE + '.tmp';
  const DIR = path.dirname(FILE);
  const settings = deps.settings;
  const getCodec = deps.getCodec || function () { return null; };
  const log = deps.log || { debug: noop, info: noop, warn: noop, error: noop };
  const now = deps.now || Date.now;

  let entries = null;          // lazily loaded
  let idCounter = 0;
  let codec;                   // resolved once, lazily
  let warnedPlain = false;

  function getCodecOnce() {
    if (codec === undefined) {
      try { codec = getCodec() || null; } catch (e) { codec = null; }
    }
    return codec;
  }

  function ensureDir() {
    try { fs.mkdirSync(DIR, { recursive: true }); } catch (e) { /* best-effort */ }
  }

  function backupUnreadable(why) {
    try {
      const stamp = new Date(now()).toISOString().replace(/[:.]/g, '-');
      const dest = path.join(DIR, 'history.unreadable-' + stamp + '.json');
      fs.renameSync(FILE, dest);
      log.warn('history: ' + why + '; file moved aside to ' + dest);
    } catch (e) {
      log.warn('history: could not move unreadable file aside', e);
    }
  }

  function genId() {
    idCounter = (idCounter + 1) & 0xffffff;
    return now().toString(36) + '-' + idCounter.toString(36) + '-' +
      Math.floor(Math.random() * 0xffffff).toString(36);
  }

  function sanitizeEntry(e) {
    if (e === null || typeof e !== 'object') return null;
    return {
      id: typeof e.id === 'string' && e.id ? e.id : genId(),
      text: typeof e.text === 'string' ? e.text : '',
      ms: isFinite(Number(e.ms)) ? Number(e.ms) : 0,
      app: typeof e.app === 'string' ? e.app : '',
      at: isFinite(Number(e.at)) ? Number(e.at) : now(),
    };
  }

  function load() {
    let raw;
    try { raw = fs.readFileSync(FILE, 'utf8'); } catch (e) { return []; }
    let parsed;
    try { parsed = JSON.parse(raw); } catch (e) {
      backupUnreadable('history.json is not valid JSON');
      return [];
    }
    if (parsed && !Array.isArray(parsed) && parsed.encrypted === true && typeof parsed.data === 'string') {
      const c = getCodecOnce();
      if (!c) {
        // Encrypted by a keystore we cannot reach now (another user/machine,
        // or the keyring is locked). Keep the file; show an empty list.
        log.warn('history: history is encrypted but the OS keystore is unavailable; not loading it');
        return [];
      }
      try {
        parsed = JSON.parse(c.decrypt(Buffer.from(parsed.data, 'base64')));
      } catch (e) {
        backupUnreadable('history could not be decrypted');
        return [];
      }
    }
    if (!Array.isArray(parsed)) return [];
    const out = [];
    for (let i = 0; i < parsed.length; i++) {
      const s = sanitizeEntry(parsed[i]);
      if (s) out.push(s);
    }
    return out;
  }

  function all() {
    if (entries === null) entries = load();
    return entries;
  }

  function serialize(list) {
    const json = JSON.stringify(list);
    const c = getCodecOnce();
    if (c) {
      return JSON.stringify({ v: 2, encrypted: true, data: c.encrypt(json).toString('base64') });
    }
    if (!warnedPlain) {
      warnedPlain = true;
      log.warn('history: no OS keystore available; history is stored unencrypted at ' + FILE);
    }
    return JSON.stringify(list, null, 2);
  }

  function persist() {
    ensureDir();
    try {
      fs.writeFileSync(TMP, serialize(entries), { encoding: 'utf8', mode: 0o600 });
      fs.renameSync(TMP, FILE);
    } catch (e) {
      log.error('history: failed to persist', e);
      try { fs.unlinkSync(TMP); } catch (e2) { /* ignore */ }
    }
  }

  function cfg() {
    try {
      const h = settings.get().history;
      return { enabled: !!(h && h.enabled), max: (h && typeof h.max === 'number') ? h.max : 200 };
    } catch (e) {
      // Fail closed: if settings cannot be read, do not record transcripts.
      return { enabled: false, max: 0 };
    }
  }

  return {
    /**
     * Append a transcription. No-op (returns null) when history is disabled.
     * @param {{text:string, ms?:number, app?:string}} entry
     * @returns {(object|null)} the stored entry, or null when disabled
     */
    add(entry) {
      const c = cfg();
      if (!c.enabled) return null;
      if (entry === null || typeof entry !== 'object') return null;
      const stored = {
        id: genId(),
        text: typeof entry.text === 'string' ? entry.text : '',
        ms: isFinite(Number(entry.ms)) ? Number(entry.ms) : 0,
        app: typeof entry.app === 'string' ? entry.app : '',
        at: now(),
      };
      const list = all();
      list.unshift(stored);
      const max = c.max > 0 ? c.max : 0;
      if (list.length > max) list.length = max;
      persist();
      return stored;
    },

    /** @returns {Array<{id:string, text:string, ms:number, app:string, at:number}>} most-recent-first */
    list() {
      return all().slice();
    },

    /** @param {string} id */
    remove(id) {
      const before = all().length;
      entries = all().filter(function (e) { return e.id !== id; });
      if (entries.length !== before) persist();
    },

    /** Clear all history (also rewrites the file, so no old text remains in it). */
    clear() {
      if (all().length === 0) return;
      entries = [];
      persist();
    },

    /** True when history is (or will be) written encrypted with the OS keystore. */
    isEncrypted() {
      return !!getCodecOnce();
    },

    path: FILE,
  };
}

// ---------------------------------------------------------------------------
// module-level instance (the real wiring)
// ---------------------------------------------------------------------------

let instance = null;
function getInstance() {
  if (!instance) {
    const config = require('../config');
    let log;
    try { log = require('../log'); } catch (e) { log = undefined; }
    instance = createHistoryStore({
      file: path.join(config.USER_DATA, 'history.json'),
      settings: require('./settings'),
      getCodec: electronCodec,
      log: log,
    });
  }
  return instance;
}

module.exports = {
  add: function (entry) { return getInstance().add(entry); },
  list: function () { return getInstance().list(); },
  remove: function (id) { return getInstance().remove(id); },
  clear: function () { return getInstance().clear(); },
  isEncrypted: function () { return getInstance().isEncrypted(); },
  get path() { return getInstance().path; },
  createHistoryStore: createHistoryStore,
  _electronCodec: electronCodec, // exported for test/history-electron-check.js
};
