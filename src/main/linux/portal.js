'use strict';

/**
 * xdg-desktop-portal clients for the Linux port (docs/LINUX-PORT.md, phase 1).
 *
 *  - GlobalShortcuts: the hotkey. The compositor owns the key binding and only
 *    tells us "shortcut <id> activated / deactivated" (press / release), so
 *    the app never sees a single keystroke. The user approves the binding
 *    once (GNOME asks; KDE lists it in System Settings).
 *  - RemoteDesktop: text insertion. After the dictated text is on the
 *    clipboard, Ctrl+V is sent as keysyms through a keyboard-only remote
 *    desktop session the user granted. With persist_mode=2 the portal hands
 *    back a restore token so later launches don't prompt again.
 *
 * Specs: https://flatpak.github.io/xdg-desktop-portal/docs/ (GlobalShortcuts,
 * RemoteDesktop, Request, Session). Every "request" method returns a Request
 * object path and answers later with a Response(u code, a{sv} results) signal
 * on it; we subscribe to the predicted path BEFORE calling to avoid the race
 * the spec warns about.
 */

const crypto = require('crypto');
const { EventEmitter } = require('events');
const dbus = require('./dbus');

const BUS_NAME = 'org.freedesktop.portal.Desktop';
const OBJ_PATH = '/org/freedesktop/portal/desktop';
const IFACE_REQUEST = 'org.freedesktop.portal.Request';
const IFACE_SESSION = 'org.freedesktop.portal.Session';
const IFACE_GS = 'org.freedesktop.portal.GlobalShortcuts';
const IFACE_RD = 'org.freedesktop.portal.RemoteDesktop';

const RESPONSE = { SUCCESS: 0, CANCELLED: 1, OTHER: 2 };
const DEVICE = { KEYBOARD: 1, POINTER: 2, TOUCHSCREEN: 4 };
const PERSIST = { NONE: 0, TRANSIENT: 1, PERSISTENT: 2 };
const KEYSYM = { Control_L: 0xffe3, v: 0x0076 };
const KEY_RELEASED = 0;
const KEY_PRESSED = 1;

// Dialog requests wait on the user, so give them a long time.
const REQUEST_TIMEOUT_MS = 5 * 60 * 1000;

class PortalError extends Error {
  /** @param {string} message @param {number} [code] Response code */
  constructor(message, code) {
    super(message);
    this.name = 'PortalError';
    this.code = code;
    this.cancelled = code === RESPONSE.CANCELLED;
  }
}

function newToken() {
  return 'sayanything_' + crypto.randomBytes(8).toString('hex');
}

/**
 * Unique bus name currently owning the portal. Signals are broadcast and any
 * peer on the session bus can emit one, so every portal signal we act on must
 * come from this sender (a forged Activated would otherwise start a recording).
 */
async function portalOwner(conn) {
  const r = await conn.busCall('GetNameOwner', 's', [BUS_NAME]);
  return String(r[0]);
}

/** Spec: request path = /org/freedesktop/portal/desktop/request/SENDER/TOKEN,
 *  SENDER = unique name without the leading ':' and with '.' -> '_'. */
function requestPath(uniqueName, token) {
  const sender = String(uniqueName).replace(/^:/, '').replace(/\./g, '_');
  return OBJ_PATH + '/request/' + sender + '/' + token;
}

/**
 * Call a request-style portal method and resolve with its Response results.
 * `options` (the trailing a{sv}) gets a fresh handle_token.
 * @param {any} conn dbus Connection
 * @param {string} iface
 * @param {string} member
 * @param {string} signature full signature, ending in a{sv}
 * @param {any[]} args all arguments except the trailing options
 * @param {Object<string, [string, any]>} [options]
 * @returns {Promise<Object<string, any>>}
 */
async function portalRequest(conn, iface, member, signature, args, options) {
  const owner = await portalOwner(conn);
  const token = newToken();
  const opts = Object.assign({}, options || {}, { handle_token: ['s', token] });
  let expected = requestPath(conn.uniqueName, token);

  let settle;
  const done = new Promise(function (resolve, reject) { settle = { resolve: resolve, reject: reject }; });
  /** @type {any} */
  let early = null; // a Response that arrived before we learned the real path
  function onSignal(m) {
    if (m.interface !== IFACE_REQUEST || m.member !== 'Response' || m.sender !== owner) return;
    if (m.path !== expected) { if (!early) early = m; return; }
    finish(m);
  }
  function finish(m) {
    const code = m.body[0];
    const results = m.body[1] || {};
    if (code === RESPONSE.SUCCESS) settle.resolve(results);
    else settle.reject(new PortalError(member + (code === RESPONSE.CANCELLED ? ' was cancelled by the user' : ' failed'), code));
  }

  const rule = dbus.matchRule({ type: 'signal', interface: IFACE_REQUEST, member: 'Response', path: expected });
  conn.on('signal', onSignal);
  await conn.addMatch(rule);
  let timer = null;
  try {
    const reply = await conn.call({
      destination: BUS_NAME, path: OBJ_PATH, interface: iface, member: member,
      signature: signature, body: args.concat([opts]),
    });
    const handle = reply[0];
    if (handle !== expected) {
      // Older portals ignored handle_token; follow the path they returned.
      const old = rule;
      expected = handle;
      await conn.addMatch(dbus.matchRule({ type: 'signal', interface: IFACE_REQUEST, member: 'Response', path: expected }));
      conn.removeMatch(old).catch(function () {});
      if (early && early.path === expected) finish(early);
    }
    timer = setTimeout(function () {
      settle.reject(new PortalError(member + ': no response from the desktop portal'));
    }, REQUEST_TIMEOUT_MS);
    if (timer.unref) timer.unref();
    return await done;
  } finally {
    if (timer) clearTimeout(timer);
    conn.removeListener('signal', onSignal);
    conn.removeMatch(dbus.matchRule({ type: 'signal', interface: IFACE_REQUEST, member: 'Response', path: expected })).catch(function () {});
  }
}

/** Read the `version` property of a portal interface; 0 when it is missing. */
async function interfaceVersion(conn, iface) {
  try {
    const r = await conn.call({
      destination: BUS_NAME, path: OBJ_PATH, interface: 'org.freedesktop.DBus.Properties',
      member: 'Get', signature: 'ss', body: [iface, 'version'], timeoutMs: 5000,
    });
    return Number(r[0]) || 0;
  } catch (e) {
    return 0;
  }
}

/** Shared session bookkeeping: Closed signal + Close(). */
class PortalSession extends EventEmitter {
  constructor(conn) {
    super();
    this.conn = conn;
    this.handle = null;
    this._owner = null; // portal's unique bus name; signals from anyone else are ignored
    this._onSignal = this._onSignal.bind(this);
    conn.on('signal', this._onSignal);
  }

  async _adopt(handle) {
    this._owner = await portalOwner(this.conn);
    this.handle = String(handle);
    await this.conn.addMatch(dbus.matchRule({ type: 'signal', interface: IFACE_SESSION, member: 'Closed', path: this.handle }));
  }

  _onSignal(m) {
    if (!this._owner || m.sender !== this._owner) return;
    if (this.handle && m.path === this.handle && m.interface === IFACE_SESSION && m.member === 'Closed') {
      this.handle = null;
      this.emit('closed');
    }
    this._onOtherSignal(m);
  }

  _onOtherSignal(m) { void m; }

  _need() {
    if (!this.handle) throw new PortalError('portal session is not open');
    return this.handle;
  }

  /** Close the portal session (idempotent). */
  async close() {
    const h = this.handle;
    this.handle = null;
    this.conn.removeListener('signal', this._onSignal);
    if (!h) return;
    try {
      await this.conn.call({ destination: BUS_NAME, path: h, interface: IFACE_SESSION, member: 'Close', timeoutMs: 5000 });
    } catch (e) { /* already gone */ }
  }
}

/**
 * GlobalShortcuts session. Events:
 *   'activated'   {id, timestamp}  (shortcut pressed)
 *   'deactivated' {id, timestamp}  (shortcut released)
 *   'changed'     [{id, description, triggerDescription}]
 *   'closed'
 */
class GlobalShortcuts extends PortalSession {
  static version(conn) { return interfaceVersion(conn, IFACE_GS); }

  async create() {
    await this.conn.addMatch(dbus.matchRule({ type: 'signal', sender: BUS_NAME, interface: IFACE_GS }));
    const res = await portalRequest(this.conn, IFACE_GS, 'CreateSession', 'a{sv}', [], {
      session_handle_token: ['s', newToken()],
    });
    if (!res.session_handle) throw new PortalError('GlobalShortcuts.CreateSession returned no session');
    await this._adopt(res.session_handle);
    return this.handle;
  }

  /**
   * Ask the compositor to bind shortcuts. Resolves with what was actually
   * bound (the user may change or refuse triggers).
   * @param {{id:string, description:string, preferredTrigger?:string}[]} shortcuts
   * @param {string} [parentWindow] e.g. 'wayland:<handle>' or ''
   */
  async bind(shortcuts, parentWindow) {
    const list = shortcuts.map(function (s) {
      const o = { description: ['s', s.description] };
      if (s.preferredTrigger) o.preferred_trigger = ['s', s.preferredTrigger];
      return [s.id, o];
    });
    const res = await portalRequest(this.conn, IFACE_GS, 'BindShortcuts', 'oa(sa{sv})sa{sv}',
      [this._need(), list, parentWindow || ''], {});
    return normalizeShortcuts(res.shortcuts);
  }

  /** Currently bound shortcuts. */
  async list() {
    const res = await portalRequest(this.conn, IFACE_GS, 'ListShortcuts', 'oa{sv}', [this._need()], {});
    return normalizeShortcuts(res.shortcuts);
  }

  _onOtherSignal(m) {
    if (m.interface !== IFACE_GS || !this.handle || m.body[0] !== this.handle) return;
    if (m.member === 'Activated' || m.member === 'Deactivated') {
      this.emit(m.member === 'Activated' ? 'activated' : 'deactivated', {
        id: String(m.body[1]),
        timestamp: typeof m.body[2] === 'bigint' ? Number(m.body[2]) : (m.body[2] || 0),
      });
    } else if (m.member === 'ShortcutsChanged') {
      this.emit('changed', normalizeShortcuts(m.body[1]));
    }
  }
}

function normalizeShortcuts(raw) {
  if (!Array.isArray(raw)) return [];
  return raw.map(function (pair) {
    const o = (pair && pair[1]) || {};
    return {
      id: String(pair && pair[0]),
      description: typeof o.description === 'string' ? o.description : '',
      triggerDescription: typeof o.trigger_description === 'string' ? o.trigger_description : '',
    };
  });
}

/**
 * RemoteDesktop session, keyboard only. Events: 'closed'.
 */
class RemoteDesktop extends PortalSession {
  static version(conn) { return interfaceVersion(conn, IFACE_RD); }

  constructor(conn) {
    super(conn);
    this.devices = 0;
    this.restoreToken = null;
  }

  async create() {
    const res = await portalRequest(this.conn, IFACE_RD, 'CreateSession', 'a{sv}', [], {
      session_handle_token: ['s', newToken()],
    });
    if (!res.session_handle) throw new PortalError('RemoteDesktop.CreateSession returned no session');
    await this._adopt(res.session_handle);
    return this.handle;
  }

  /**
   * Request keyboard access. Pass a restore token from an earlier start() to
   * skip the dialog when the user already granted it.
   * @param {{restoreToken?:string|null, persist?:boolean}} [o]
   */
  async selectKeyboard(o) {
    o = o || {};
    /** @type {Object<string, [string, any]>} */
    const opts = { types: ['u', DEVICE.KEYBOARD] };
    if (o.persist !== false) opts.persist_mode = ['u', PERSIST.PERSISTENT];
    if (o.restoreToken) opts.restore_token = ['s', String(o.restoreToken)];
    await portalRequest(this.conn, IFACE_RD, 'SelectDevices', 'oa{sv}', [this._need()], opts);
  }

  /**
   * Start the session (this is where the user is asked, if at all).
   * @param {string} [parentWindow]
   * @returns {Promise<{devices:number, restoreToken:(string|null)}>}
   */
  async start(parentWindow) {
    const res = await portalRequest(this.conn, IFACE_RD, 'Start', 'osa{sv}', [this._need(), parentWindow || ''], {});
    this.devices = Number(res.devices) || 0;
    this.restoreToken = typeof res.restore_token === 'string' ? res.restore_token : null;
    if (!(this.devices & DEVICE.KEYBOARD)) {
      throw new PortalError('RemoteDesktop.Start: keyboard access was not granted', RESPONSE.OTHER);
    }
    return { devices: this.devices, restoreToken: this.restoreToken };
  }

  /** Press or release one keysym. */
  key(keysym, pressed) {
    return this.conn.call({
      destination: BUS_NAME, path: OBJ_PATH, interface: IFACE_RD, member: 'NotifyKeyboardKeysym',
      signature: 'oa{sv}iu', body: [this._need(), {}, keysym, pressed ? KEY_PRESSED : KEY_RELEASED],
      timeoutMs: 5000,
    });
  }

  /** Ctrl+V. Releases are always sent, even if a press failed. */
  async pasteChord() {
    let err = null;
    try {
      await this.key(KEYSYM.Control_L, true);
      await this.key(KEYSYM.v, true);
    } catch (e) { err = e; }
    try { await this.key(KEYSYM.v, false); } catch (e) { err = err || e; }
    try { await this.key(KEYSYM.Control_L, false); } catch (e) { err = err || e; }
    if (err) throw err;
  }
}

module.exports = {
  GlobalShortcuts: GlobalShortcuts,
  RemoteDesktop: RemoteDesktop,
  PortalError: PortalError,
  RESPONSE: RESPONSE,
  DEVICE: DEVICE,
  KEYSYM: KEYSYM,
  BUS_NAME: BUS_NAME,
  OBJ_PATH: OBJ_PATH,
  _internal: { requestPath: requestPath, portalRequest: portalRequest, portalOwner: portalOwner },
};
