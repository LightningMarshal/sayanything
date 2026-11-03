'use strict';

/**
 * Linux stand-in for the native helper (docs/LINUX-PORT.md, phase 1 step 2).
 *
 * Same interface as src/main/helper.js, so main.js / state.js / ipc-handlers.js
 * use it unchanged, but built on xdg-desktop-portal instead of a child process:
 *
 *  - Hotkey: GlobalShortcuts. Three shortcuts are bound once: 'dictate'
 *    (main), 'pad' and 'cancel'. The desktop owns the key binding; we only hear "pressed" /
 *    "released" and emit 'shortcut' {id:'main'|'pad', down}. No keystroke is
 *    ever seen by the app. A third shortcut, 'cancel' (Ctrl+Super+Esc by
 *    default), replaces Esc-to-cancel: a global plain Esc would steal Esc from
 *    every app. The WS-5 'chord' bit does not exist here.
 *  - Paste: the text goes on the clipboard (Electron), then Ctrl+V is sent
 *    through a keyboard-only RemoteDesktop session, created on the first paste.
 *    Its restore token is saved (0600) so later launches don't ask again. If
 *    the user refuses, or the portal is missing, the text stays on the
 *    clipboard and paste() resolves {ok:true, clipboardOnly:true}; state.js
 *    then shows "press Ctrl+V". A refusal is remembered for this run so the
 *    user is not asked on every dictation.
 *  - Not possible on Wayland: rebind capture (the shortcut is changed in the
 *    desktop's settings), drop-pad "place at point", foreground app name.
 *
 * Events: 'ready', 'shortcut' {id:'main'|'pad'|'cancel', down}, 'bound' [{id, description,
 * triggerDescription}], 'log' msg, 'crash' {code, signal}, 'unavailable'
 * {restarts}.
 */

const { EventEmitter } = require('events');
const fs = require('fs');
const path = require('path');

const RESTORE_TOKEN_FILE = 'linux-portal.json';
const MAX_RESTARTS = 3;

// Defaults when the configured hotkey cannot be expressed as a portal trigger
// (bare modifiers like Right Ctrl, which compositors generally don't accept as
// a global shortcut; L4 in docs/LINUX-PORT.md). Not Super+Space: GNOME uses
// that to switch keyboard layouts.
const DEFAULT_TRIGGER = { main: 'CTRL+LOGO+space', pad: 'CTRL+LOGO+SHIFT+space', cancel: 'CTRL+LOGO+Escape' };

const MOD_NAMES = { 16: 'SHIFT', 17: 'CTRL', 18: 'ALT', 91: 'LOGO' };

/**
 * Windows-VK binding -> XDG shortcut trigger string (e.g. CTRL+ALT+d), or null
 * when it cannot be expressed (bare modifier, unknown key).
 * @param {{vk:number, mods?:number[]}} b
 * @returns {string|null}
 */
function triggerFor(b) {
  if (!b || typeof b.vk !== 'number') return null;
  const vk = b.vk;
  let key = null;
  if (vk >= 65 && vk <= 90) key = String.fromCharCode(vk + 32);          // a-z
  else if (vk >= 48 && vk <= 57) key = String.fromCharCode(vk);          // 0-9
  else if (vk >= 112 && vk <= 135) key = 'F' + (vk - 111);               // F1-F24
  else if (vk === 32) key = 'space';
  else if (vk === 13) key = 'Return';
  else if (vk === 9) key = 'Tab';
  else if (vk === 45) key = 'Insert';
  else if (vk === 36) key = 'Home';
  else if (vk === 35) key = 'End';
  else if (vk === 33) key = 'Prior';
  else if (vk === 34) key = 'Next';
  else if (vk === 19) key = 'Pause';
  else if (vk === 145) key = 'Scroll_Lock';
  if (!key) return null;
  const mods = Array.isArray(b.mods) ? b.mods : [];
  const parts = [];
  for (const m of [17, 18, 16, 91]) if (mods.indexOf(m) !== -1) parts.push(MOD_NAMES[m]);
  for (const m of mods) if (!MOD_NAMES[m]) return null; // physical-side modifier: not expressible
  parts.push(key);
  return parts.join('+');
}

function delay(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }

class LinuxHelper extends EventEmitter {
  /**
   * @param {{dbus?:any, portal?:any, clipboard?:any, settings?:()=>any,
   *          userData?:string, address?:string, log?:any}} [deps]
   */
  constructor(deps) {
    super();
    deps = deps || {};
    this._dbus = deps.dbus || require('./dbus');
    this._portal = deps.portal || require('./portal');
    this._clipboardDep = deps.clipboard || null;
    this._settings = deps.settings || function () { return {}; };
    this._userData = deps.userData || null;
    this._address = deps.address || undefined;
    this._log = deps.log || { info: function () {}, warn: function () {}, error: function () {} };

    this.ready = false;
    this.watched = [];
    this.bound = [];
    this._conn = null;
    this._gs = null;
    this._rd = null;
    this._rdRefused = false;
    this._rdStarting = null;
    this._starting = null;
    this._stopping = false;
    this._restarts = 0;
    this._queue = Promise.resolve(); // pastes run one at a time
  }

  _clipboard() {
    if (!this._clipboardDep) this._clipboardDep = require('electron').clipboard;
    return this._clipboardDep;
  }

  _tokenPath() {
    if (this._userData) return path.join(this._userData, RESTORE_TOKEN_FILE);
    return path.join(require('../config').USER_DATA, RESTORE_TOKEN_FILE);
  }

  _readToken() {
    try {
      const j = JSON.parse(fs.readFileSync(this._tokenPath(), 'utf8'));
      return typeof j.remoteDesktopRestoreToken === 'string' ? j.remoteDesktopRestoreToken : null;
    } catch (e) { return null; }
  }

  _writeToken(token) {
    const p = this._tokenPath();
    try {
      fs.mkdirSync(path.dirname(p), { recursive: true });
      const tmp = p + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify({ remoteDesktopRestoreToken: token || null }), { mode: 0o600 });
      fs.renameSync(tmp, p);
    } catch (e) {
      this._log.warn('linux: could not save the RemoteDesktop restore token: ' + (e && e.message));
    }
  }

  // ---- lifecycle ------------------------------------------------------

  start() {
    if (this._starting) return this._starting;
    if (this.ready) return Promise.resolve();
    this._stopping = false;
    const self = this;
    this._starting = this._start().then(function () {
      self._starting = null;
    }, function (e) {
      self._starting = null;
      throw e;
    });
    return this._starting;
  }

  async _start() {
    if (!this._conn) {
      try {
        this._conn = await this._dbus.connect(this._address);
      } catch (e) {
        throw userError('Could not reach the desktop session bus (' + (e && e.message) + ').',
          'Say Anything needs a desktop session (KDE Plasma or GNOME) to set up its shortcut.');
      }
      const self = this;
      this._conn.on('close', function () { self._onLost('session bus connection closed'); });
    }
    const v = await this._portal.GlobalShortcuts.version(this._conn);
    if (!v) {
      throw userError('xdg-desktop-portal has no GlobalShortcuts interface.',
        'Your desktop does not support global shortcuts for apps. KDE Plasma 6 or GNOME 48 or newer is needed.');
    }
    const gs = new this._portal.GlobalShortcuts(this._conn);
    await gs.create();
    const st = this._settings() || {};
    let bound;
    try {
      bound = await gs.bind([
        { id: 'dictate', description: 'Dictate (hold to talk, tap for hands-free)',
          preferredTrigger: triggerFor(st.hotkey) || DEFAULT_TRIGGER.main },
        { id: 'pad', description: 'Dictate to the drop pad',
          preferredTrigger: triggerFor(st.padHotkey) || DEFAULT_TRIGGER.pad },
        // Esc can't be bound globally without stealing it from every app, so
        // cancelling a recording gets its own chord.
        { id: 'cancel', description: 'Cancel the current dictation',
          preferredTrigger: DEFAULT_TRIGGER.cancel },
      ], '');
    } catch (e) {
      try { await gs.close(); } catch (e2) { /* ignore */ }
      if (e && e.cancelled) {
        throw userError('The shortcut request was declined.', 'The dictation shortcut was not set up. Restart Say Anything to be asked again.');
      }
      throw e;
    }
    const self = this;
    gs.on('activated', function (ev) { self._onShortcut(ev.id, true); });
    gs.on('deactivated', function (ev) { self._onShortcut(ev.id, false); });
    gs.on('changed', function (list) { self.bound = list; self.emit('bound', list); });
    gs.on('closed', function () { self._onLost('portal closed the shortcut session'); });
    this._gs = gs;
    this.bound = bound;
    this.ready = true;
    this._log.info('linux: shortcuts bound: ' + bound.map(function (b) { return b.id + '=' + (b.triggerDescription || '?'); }).join(', '));
    this.emit('bound', bound);
    this.emit('ready');
  }

  _onShortcut(id, down) {
    if (id === 'dictate') this.emit('shortcut', { id: 'main', down: down });
    else if (id === 'pad') this.emit('shortcut', { id: 'pad', down: down });
    else if (id === 'cancel') this.emit('shortcut', { id: 'cancel', down: down });
  }

  _onLost(why) {
    if (this._stopping || (!this.ready && !this._gs)) return;
    const wasReady = this.ready;
    this.ready = false;
    this._gs = null;
    this._rd = null;
    if (this._conn && this._conn._closed) this._conn = null;
    this._log.warn('linux: ' + why);
    if (!wasReady) return;
    this.emit('crash', { code: null, signal: why });
    this._restarts++;
    if (this._restarts > MAX_RESTARTS) { this.emit('unavailable', { restarts: this._restarts - 1 }); return; }
    const self = this;
    const t = setTimeout(function () {
      self.start().then(function () { self._restarts = 0; }, function (e) {
        self._log.error('linux: restart failed: ' + (e && e.message));
        self.emit('unavailable', { restarts: self._restarts });
      });
    }, 500 * Math.pow(2, this._restarts - 1));
    if (t.unref) t.unref();
  }

  stop() {
    this._stopping = true;
    this.ready = false;
    const gs = this._gs;
    const rd = this._rd;
    const conn = this._conn;
    this._gs = null; this._rd = null; this._conn = null;
    return Promise.all([
      gs ? gs.close().catch(function () {}) : null,
      rd ? rd.close().catch(function () {}) : null,
    ]).then(function () { if (conn) conn.close(); });
  }

  // ---- keyboard access (RemoteDesktop) ---------------------------------

  _ensureRemote() {
    if (this._rd && this._rd.handle) return Promise.resolve(this._rd);
    if (this._rdRefused) return Promise.resolve(null);
    if (this._rdStarting) return this._rdStarting;
    const self = this;
    this._rdStarting = (async function () {
      if (!self._conn) return null;
      if (!(await self._portal.RemoteDesktop.version(self._conn))) {
        self._rdRefused = true;
        self._log.warn('linux: no RemoteDesktop portal; dictation will be left on the clipboard');
        return null;
      }
      const rd = new self._portal.RemoteDesktop(self._conn);
      try {
        await rd.create();
        await rd.selectKeyboard({ restoreToken: self._readToken() });
        const res = await rd.start('');
        self._writeToken(res.restoreToken);
      } catch (e) {
        try { await rd.close(); } catch (e2) { /* ignore */ }
        self._rdRefused = true;
        self._log.warn('linux: keyboard access ' + (e && e.cancelled ? 'declined' : 'failed') + ' (' + (e && e.message) + '); dictation will be left on the clipboard');
        return null;
      }
      rd.on('closed', function () { if (self._rd === rd) self._rd = null; });
      self._rd = rd;
      return rd;
    })().finally(function () { self._rdStarting = null; });
    return this._rdStarting;
  }

  // ---- clipboard --------------------------------------------------------

  _snapshot() {
    const cb = this._clipboard();
    const snap = {};
    try { snap.text = cb.readText(); } catch (e) { /* ignore */ }
    try { snap.html = cb.readHTML(); } catch (e) { /* ignore */ }
    try { snap.rtf = cb.readRTF(); } catch (e) { /* ignore */ }
    try {
      const img = cb.readImage();
      if (img && typeof img.isEmpty === 'function' && !img.isEmpty()) snap.image = img;
    } catch (e) { /* ignore */ }
    return snap;
  }

  _restore(snap) {
    const cb = this._clipboard();
    const data = {};
    if (snap.text) data.text = snap.text;
    if (snap.html) data.html = snap.html;
    if (snap.rtf) data.rtf = snap.rtf;
    if (snap.image) data.image = snap.image;
    try {
      if (Object.keys(data).length) cb.write(data); else cb.clear();
    } catch (e) {
      this._log.warn('linux: clipboard restore failed: ' + (e && e.message));
    }
  }

  // ---- helper interface ---------------------------------------------------

  /** The portal owns the binding; remember the set for parity only. */
  watch(vks) { this.watched = Array.isArray(vks) ? vks.slice() : []; }

  capture() {
    throw userError('rebind capture is not available on Linux',
      'On Linux the shortcut is set in your desktop settings: open your desktop\'s keyboard shortcut settings and look for Say Anything.');
  }

  captureCancel() {}

  pickPoint() { return Promise.reject(new Error('placing at a point is not available on Wayland')); }

  pickCancel() {}

  /**
   * @param {string} text
   * @param {number} restoreMs
   * @returns {Promise<{ok:boolean, err?:string, clipboardOnly?:boolean}>}
   */
  paste(text, restoreMs) {
    const self = this;
    const run = function () { return self._paste(String(text == null ? '' : text), restoreMs); };
    const p = this._queue.then(run, run);
    this._queue = p.then(function () {}, function () {});
    return p;
  }

  async _paste(text, restoreMs) {
    const cb = this._clipboard();
    const rd = await this._ensureRemote();
    if (!rd) {
      try { cb.writeText(text); } catch (e) { return { ok: false, err: 'could not set clipboard' }; }
      return { ok: true, clipboardOnly: true, err: 'no keyboard access' };
    }
    const saved = this._snapshot();
    try { cb.writeText(text); } catch (e) { return { ok: false, err: 'could not set clipboard' }; }
    try {
      await rd.pasteChord();
    } catch (e) {
      // Keyboard session failed mid-way: leave the dictation on the clipboard.
      this._log.warn('linux: Ctrl+V through the portal failed: ' + (e && e.message));
      this._rd = null;
      return { ok: true, clipboardOnly: true, err: 'paste failed' };
    }
    const ms = Math.min(Math.max(Number(restoreMs) || 0, 0), 60000);
    if (ms > 0) await delay(ms);
    this._restore(saved);
    return { ok: true };
  }

  /** No per-character typing through the portal yet: paste instead. */
  type(text) { return this.paste(text, 300); }

  copy(text) {
    try {
      this._clipboard().writeText(String(text == null ? '' : text));
      return Promise.resolve({ ok: true });
    } catch (e) {
      return Promise.resolve({ ok: false, err: 'could not set clipboard' });
    }
  }

  /** Wayland apps cannot click elsewhere; leave the text for Ctrl+V. */
  placeAt(text) {
    return this.copy(text).then(function () {
      throw new Error('placing text at a point is not available on Wayland; it is on the clipboard');
    });
  }

  foreground() { return Promise.resolve({ exe: '', title: '' }); }

  perms() {}

  permsRequest() {}

  ping() { return Promise.resolve(!!(this.ready && this._conn)); }
}

function userError(message, userMessage) {
  const e = new Error(message);
  /** @type {any} */ (e).userMessage = userMessage;
  return e;
}

function create(deps) { return new LinuxHelper(deps); }

module.exports = { create: create, LinuxHelper: LinuxHelper, triggerFor: triggerFor, DEFAULT_TRIGGER: DEFAULT_TRIGGER };
