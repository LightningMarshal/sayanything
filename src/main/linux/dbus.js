'use strict';

/**
 * Minimal D-Bus client (Linux), written against the D-Bus specification
 * (https://dbus.freedesktop.org/doc/dbus-specification.html). Zero npm deps.
 *
 * Why not a library: the project ships zero runtime npm dependencies, and the
 * Linux port only needs a small slice of D-Bus to talk to xdg-desktop-portal
 * (GlobalShortcuts for the hotkey, RemoteDesktop for Ctrl+V). That slice:
 *  - connect to the session bus over a unix socket (path= or abstract=),
 *    SASL EXTERNAL auth, Hello;
 *  - send method calls and await their replies / errors;
 *  - receive signals (with AddMatch rules);
 *  - answer incoming method calls and emit signals (used by the test-suite's
 *    fake portal; cheap to keep, and lets the app reply to Introspect later).
 *  - marshal / unmarshal every basic type plus arrays, structs, dict entries
 *    and variants. Unix fd passing is NOT supported (the portals we use do not
 *    need it), so 'h' values are plain indices with no fds attached.
 *
 * JS value mapping (decode and encode):
 *   y n q i u h d -> number        x t -> BigInt (encode also accepts number)
 *   b -> boolean                   s o g -> string
 *   (...) struct -> Array          a<T> -> Array
 *   a{KV} dict -> plain object when K is s/o/g, otherwise Map
 *              (encode accepts a plain object, a Map, or an array of [k, v])
 *   v variant -> decode: the inner value (signature dropped)
 *                encode: a [signature, value] pair, e.g. ['s', 'hello']
 */

const net = require('net');
const { EventEmitter } = require('events');

const TYPE = { METHOD_CALL: 1, METHOD_RETURN: 2, ERROR: 3, SIGNAL: 4 };
const FLAG_NO_REPLY_EXPECTED = 0x1;
const FIELD = {
  PATH: 1, INTERFACE: 2, MEMBER: 3, ERROR_NAME: 4, REPLY_SERIAL: 5,
  DESTINATION: 6, SENDER: 7, SIGNATURE: 8, UNIX_FDS: 9,
};

const MAX_MESSAGE = 128 * 1024 * 1024; // spec maximum
const MAX_DEPTH = 64;                   // spec: 32 array + 32 struct nesting

// ---------------------------------------------------------------------------
// Signatures
// ---------------------------------------------------------------------------

function alignOf(code) {
  switch (code) {
    case 'y': case 'g': case 'v': return 1;
    case 'n': case 'q': return 2;
    case 'b': case 'i': case 'u': case 's': case 'o': case 'a': case 'h': return 4;
    case 'x': case 't': case 'd': case '(': case '{': return 8;
    default: throw new Error('dbus: unknown type code ' + JSON.stringify(code));
  }
}

/** Length of the single complete type starting at sig[i]. */
function completeTypeEnd(sig, i, depth) {
  if ((depth || 0) > MAX_DEPTH) throw new Error('dbus: signature nested too deeply');
  const c = sig.charAt(i);
  if (c === 'a') return completeTypeEnd(sig, i + 1, (depth || 0) + 1);
  if (c === '(' || c === '{') {
    const close = c === '(' ? ')' : '}';
    let j = i + 1;
    let n = 0;
    while (sig.charAt(j) !== close) {
      if (j >= sig.length) throw new Error('dbus: unterminated container in signature ' + JSON.stringify(sig));
      j = completeTypeEnd(sig, j, (depth || 0) + 1);
      n++;
    }
    if (n === 0) throw new Error('dbus: empty struct in signature');
    if (c === '{' && n !== 2) throw new Error('dbus: dict entry must have 2 types');
    return j + 1;
  }
  if ('ybnqiuxtdsoghv'.indexOf(c) === -1 || c === '') {
    throw new Error('dbus: bad signature ' + JSON.stringify(sig) + ' at ' + i);
  }
  return i + 1;
}

/** Split a signature into its complete types: 'sa{sv}u' -> ['s','a{sv}','u']. */
function splitSignature(sig) {
  const out = [];
  let i = 0;
  while (i < sig.length) {
    const j = completeTypeEnd(sig, i, 0);
    out.push(sig.slice(i, j));
    i = j;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Writer (always little-endian)
// ---------------------------------------------------------------------------

class Writer {
  constructor() { this.buf = Buffer.alloc(256); this.len = 0; }
  _ensure(n) {
    if (this.len + n <= this.buf.length) return;
    let size = this.buf.length * 2;
    while (size < this.len + n) size *= 2;
    const nb = Buffer.alloc(size);
    this.buf.copy(nb, 0, 0, this.len);
    this.buf = nb;
  }
  align(n) {
    const pad = (n - (this.len % n)) % n;
    this._ensure(pad);
    this.buf.fill(0, this.len, this.len + pad);
    this.len += pad;
  }
  bytes(b) { this._ensure(b.length); b.copy(this.buf, this.len); this.len += b.length; }
  u8(v) { this._ensure(1); this.buf.writeUInt8(v, this.len); this.len += 1; }
  result() { return this.buf.subarray(0, this.len); }

  write(sig, value, depth) {
    depth = depth || 0;
    if (depth > MAX_DEPTH) throw new Error('dbus: value nested too deeply');
    const c = sig.charAt(0);
    this.align(alignOf(c));
    switch (c) {
      case 'y': this._ensure(1); this.buf.writeUInt8(num(value, 0, 0xff), this.len); this.len += 1; return;
      case 'b': this._ensure(4); this.buf.writeUInt32LE(value ? 1 : 0, this.len); this.len += 4; return;
      case 'n': this._ensure(2); this.buf.writeInt16LE(num(value, -0x8000, 0x7fff), this.len); this.len += 2; return;
      case 'q': this._ensure(2); this.buf.writeUInt16LE(num(value, 0, 0xffff), this.len); this.len += 2; return;
      case 'i': this._ensure(4); this.buf.writeInt32LE(num(value, -0x80000000, 0x7fffffff), this.len); this.len += 4; return;
      case 'u': case 'h': this._ensure(4); this.buf.writeUInt32LE(num(value, 0, 0xffffffff), this.len); this.len += 4; return;
      case 'x': this._ensure(8); this.buf.writeBigInt64LE(BigInt(value), this.len); this.len += 8; return;
      case 't': this._ensure(8); this.buf.writeBigUInt64LE(BigInt(value), this.len); this.len += 8; return;
      case 'd': this._ensure(8); this.buf.writeDoubleLE(Number(value), this.len); this.len += 8; return;
      case 's': case 'o': {
        const b = Buffer.from(String(value), 'utf8');
        if (b.indexOf(0) !== -1) throw new Error('dbus: string contains NUL');
        if (c === 'o' && !validObjectPath(String(value))) throw new Error('dbus: invalid object path ' + JSON.stringify(value));
        this._ensure(4); this.buf.writeUInt32LE(b.length, this.len); this.len += 4;
        this.bytes(b); this.u8(0);
        return;
      }
      case 'g': {
        const b = Buffer.from(String(value), 'ascii');
        if (b.length > 255) throw new Error('dbus: signature too long');
        splitSignature(String(value)); // validate
        this.u8(b.length); this.bytes(b); this.u8(0);
        return;
      }
      case 'v': {
        if (!Array.isArray(value) || value.length !== 2 || typeof value[0] !== 'string') {
          throw new Error('dbus: variant must be encoded as [signature, value]');
        }
        const inner = value[0];
        if (splitSignature(inner).length !== 1) throw new Error('dbus: variant signature must be one complete type');
        this.write('g', inner, depth + 1);
        this.write(inner, value[1], depth + 1);
        return;
      }
      case '(': {
        const types = splitSignature(sig.slice(1, completeTypeEnd(sig, 0, 0) - 1));
        if (!Array.isArray(value) || value.length !== types.length) {
          throw new Error('dbus: struct ' + sig + ' needs an array of ' + types.length);
        }
        for (let k = 0; k < types.length; k++) this.write(types[k], value[k], depth + 1);
        return;
      }
      case 'a': {
        const elem = sig.slice(1, completeTypeEnd(sig, 0, 0));
        const lenPos = this.len;
        this._ensure(4); this.len += 4;
        this.align(alignOf(elem.charAt(0)));
        const start = this.len;
        if (elem.charAt(0) === '{') {
          const kv = splitSignature(elem.slice(1, -1));
          for (const pair of entriesOf(value)) {
            this.align(8);
            this.write(kv[0], pair[0], depth + 1);
            this.write(kv[1], pair[1], depth + 1);
          }
        } else if (elem === 'y' && Buffer.isBuffer(value)) {
          this.bytes(value);
        } else {
          if (!Array.isArray(value)) throw new Error('dbus: array ' + sig + ' needs an Array');
          for (const v of value) this.write(elem, v, depth + 1);
        }
        const n = this.len - start;
        if (n > 64 * 1024 * 1024) throw new Error('dbus: array too long');
        this.buf.writeUInt32LE(n, lenPos);
        return;
      }
      default:
        throw new Error('dbus: cannot write type ' + JSON.stringify(sig));
    }
  }
}

function num(v, lo, hi) {
  const n = Number(v);
  if (!Number.isInteger(n) || n < lo || n > hi) throw new Error('dbus: integer out of range: ' + v);
  return n;
}

function entriesOf(value) {
  if (value instanceof Map) return Array.from(value.entries());
  if (Array.isArray(value)) return value;
  if (value && typeof value === 'object') return Object.keys(value).map(function (k) { return [k, value[k]]; });
  throw new Error('dbus: dict needs an object, Map or array of pairs');
}

function validObjectPath(p) {
  return p === '/' || /^(\/[A-Za-z0-9_]+)+$/.test(p);
}

// ---------------------------------------------------------------------------
// Reader
// ---------------------------------------------------------------------------

class Reader {
  /**
   * @param {Buffer} buf
   * @param {boolean} le little-endian?
   * @param {number} [base] offset that alignment is measured from
   */
  constructor(buf, le, base) { this.buf = buf; this.le = le; this.pos = 0; this.base = base || 0; }
  align(n) {
    const abs = this.base + this.pos;
    const pad = (n - (abs % n)) % n;
    this._need(pad);
    this.pos += pad;
  }
  _need(n) { if (this.pos + n > this.buf.length) throw new Error('dbus: message truncated'); }

  read(sig, depth) {
    depth = depth || 0;
    if (depth > MAX_DEPTH) throw new Error('dbus: value nested too deeply');
    const c = sig.charAt(0);
    this.align(alignOf(c));
    const b = this.buf;
    const le = this.le;
    let v;
    switch (c) {
      case 'y': this._need(1); v = b.readUInt8(this.pos); this.pos += 1; return v;
      case 'b': {
        this._need(4); v = le ? b.readUInt32LE(this.pos) : b.readUInt32BE(this.pos); this.pos += 4;
        if (v > 1) throw new Error('dbus: bad boolean');
        return v === 1;
      }
      case 'n': this._need(2); v = le ? b.readInt16LE(this.pos) : b.readInt16BE(this.pos); this.pos += 2; return v;
      case 'q': this._need(2); v = le ? b.readUInt16LE(this.pos) : b.readUInt16BE(this.pos); this.pos += 2; return v;
      case 'i': this._need(4); v = le ? b.readInt32LE(this.pos) : b.readInt32BE(this.pos); this.pos += 4; return v;
      case 'u': case 'h': this._need(4); v = le ? b.readUInt32LE(this.pos) : b.readUInt32BE(this.pos); this.pos += 4; return v;
      case 'x': this._need(8); v = le ? b.readBigInt64LE(this.pos) : b.readBigInt64BE(this.pos); this.pos += 8; return v;
      case 't': this._need(8); v = le ? b.readBigUInt64LE(this.pos) : b.readBigUInt64BE(this.pos); this.pos += 8; return v;
      case 'd': this._need(8); v = le ? b.readDoubleLE(this.pos) : b.readDoubleBE(this.pos); this.pos += 8; return v;
      case 's': case 'o': {
        this._need(4);
        const n = le ? b.readUInt32LE(this.pos) : b.readUInt32BE(this.pos); this.pos += 4;
        this._need(n + 1);
        v = b.toString('utf8', this.pos, this.pos + n);
        if (b[this.pos + n] !== 0) throw new Error('dbus: string not NUL-terminated');
        this.pos += n + 1;
        return v;
      }
      case 'g': {
        this._need(1);
        const n = b.readUInt8(this.pos); this.pos += 1;
        this._need(n + 1);
        v = b.toString('ascii', this.pos, this.pos + n);
        this.pos += n + 1;
        return v;
      }
      case 'v': {
        const inner = this.read('g', depth + 1);
        if (splitSignature(inner).length !== 1) throw new Error('dbus: bad variant signature');
        return this.read(inner, depth + 1);
      }
      case '(': {
        const types = splitSignature(sig.slice(1, completeTypeEnd(sig, 0, 0) - 1));
        const out = [];
        for (const t of types) out.push(this.read(t, depth + 1));
        return out;
      }
      case 'a': {
        const elem = sig.slice(1, completeTypeEnd(sig, 0, 0));
        this._need(4);
        const n = le ? b.readUInt32LE(this.pos) : b.readUInt32BE(this.pos); this.pos += 4;
        if (n > 64 * 1024 * 1024) throw new Error('dbus: array too long');
        this.align(alignOf(elem.charAt(0)));
        const end = this.pos + n;
        if (end > b.length) throw new Error('dbus: message truncated');
        if (elem.charAt(0) === '{') {
          const kv = splitSignature(elem.slice(1, -1));
          const stringKeys = 'sog'.indexOf(kv[0]) !== -1;
          const out = stringKeys ? Object.create(null) : new Map();
          while (this.pos < end) {
            this.align(8);
            const k = this.read(kv[0], depth + 1);
            const val = this.read(kv[1], depth + 1);
            if (stringKeys) out[k] = val; else out.set(k, val);
          }
          if (this.pos !== end) throw new Error('dbus: array length mismatch');
          return stringKeys ? Object.assign({}, out) : out;
        }
        const arr = [];
        while (this.pos < end) arr.push(this.read(elem, depth + 1));
        if (this.pos !== end) throw new Error('dbus: array length mismatch');
        return arr;
      }
      default:
        throw new Error('dbus: cannot read type ' + JSON.stringify(sig));
    }
  }
}

// ---------------------------------------------------------------------------
// Messages
// ---------------------------------------------------------------------------

/**
 * @typedef {{type:number, flags?:number, serial:number, path?:string,
 *   interface?:string, member?:string, errorName?:string, replySerial?:number,
 *   destination?:string, sender?:string, signature?:string, body?:any[]}} Message
 */

/** @param {Message} m @returns {Buffer} */
function encodeMessage(m) {
  const sig = m.signature || '';
  const body = m.body || [];
  const types = splitSignature(sig);
  if (types.length !== body.length) {
    throw new Error('dbus: body has ' + body.length + ' values for signature ' + JSON.stringify(sig));
  }
  const bw = new Writer();
  for (let i = 0; i < types.length; i++) bw.write(types[i], body[i]);
  const bodyBuf = bw.result();

  const fields = [];
  if (m.path) fields.push([FIELD.PATH, ['o', m.path]]);
  if (m.interface) fields.push([FIELD.INTERFACE, ['s', m.interface]]);
  if (m.member) fields.push([FIELD.MEMBER, ['s', m.member]]);
  if (m.errorName) fields.push([FIELD.ERROR_NAME, ['s', m.errorName]]);
  if (m.replySerial != null) fields.push([FIELD.REPLY_SERIAL, ['u', m.replySerial]]);
  if (m.destination) fields.push([FIELD.DESTINATION, ['s', m.destination]]);
  if (m.sender) fields.push([FIELD.SENDER, ['s', m.sender]]);
  if (sig) fields.push([FIELD.SIGNATURE, ['g', sig]]);

  const hw = new Writer();
  hw.u8(0x6c); // 'l' little-endian
  hw.u8(m.type);
  hw.u8(m.flags || 0);
  hw.u8(1);    // protocol version
  hw.write('u', bodyBuf.length);
  hw.write('u', m.serial);
  hw.write('a(yv)', fields);
  hw.align(8);
  const out = Buffer.concat([hw.result(), bodyBuf]);
  if (out.length > MAX_MESSAGE) throw new Error('dbus: message too large');
  return out;
}

/**
 * Total byte length of the message at the start of buf, or -1 if more bytes
 * are needed to know.
 */
function messageLength(buf) {
  if (buf.length < 16) return -1;
  const le = buf[0] === 0x6c;
  if (!le && buf[0] !== 0x42) throw new Error('dbus: bad endianness byte');
  const bodyLen = le ? buf.readUInt32LE(4) : buf.readUInt32BE(4);
  const fieldsLen = le ? buf.readUInt32LE(12) : buf.readUInt32BE(12);
  const headerLen = 16 + fieldsLen + ((8 - ((16 + fieldsLen) % 8)) % 8);
  const total = headerLen + bodyLen;
  if (total > MAX_MESSAGE) throw new Error('dbus: incoming message too large');
  return total;
}

/** @param {Buffer} buf one complete message @returns {Message} */
function decodeMessage(buf) {
  const le = buf[0] === 0x6c;
  const r = new Reader(buf, le);
  r.pos = 1;
  const type = r.read('y');
  const flags = r.read('y');
  const version = r.read('y');
  if (version !== 1) throw new Error('dbus: unsupported protocol version ' + version);
  const bodyLen = r.read('u');
  const serial = r.read('u');
  const fields = r.read('a(yv)');
  r.align(8);
  /** @type {Message} */
  const m = { type: type, flags: flags, serial: serial };
  for (const f of fields) {
    const code = f[0];
    const val = f[1];
    if (code === FIELD.PATH) m.path = val;
    else if (code === FIELD.INTERFACE) m.interface = val;
    else if (code === FIELD.MEMBER) m.member = val;
    else if (code === FIELD.ERROR_NAME) m.errorName = val;
    else if (code === FIELD.REPLY_SERIAL) m.replySerial = val;
    else if (code === FIELD.DESTINATION) m.destination = val;
    else if (code === FIELD.SENDER) m.sender = val;
    else if (code === FIELD.SIGNATURE) m.signature = val;
  }
  const bodyStart = r.pos;
  if (bodyStart + bodyLen !== buf.length) throw new Error('dbus: body length mismatch');
  const sig = m.signature || '';
  // Body alignment is measured from the start of the message (spec), and the
  // body always starts 8-aligned, so a reader based at bodyStart is correct.
  const br = new Reader(buf.subarray(bodyStart), le, 0);
  m.body = [];
  for (const t of splitSignature(sig)) m.body.push(br.read(t));
  if (br.pos !== bodyLen) throw new Error('dbus: trailing bytes in body');
  return m;
}

// ---------------------------------------------------------------------------
// Connection
// ---------------------------------------------------------------------------

/** Parse DBUS_SESSION_BUS_ADDRESS into a list of net.connect() paths. */
function parseAddress(addr) {
  const out = [];
  for (const part of String(addr || '').split(';')) {
    const colon = part.indexOf(':');
    if (colon === -1) continue;
    const transport = part.slice(0, colon);
    if (transport !== 'unix') continue;
    const kv = {};
    for (const p of part.slice(colon + 1).split(',')) {
      const eq = p.indexOf('=');
      if (eq > 0) kv[p.slice(0, eq)] = decodeURIComponent(p.slice(eq + 1));
    }
    if (kv.path) out.push(kv.path);
    else if (kv.abstract) out.push('\0' + kv.abstract);
  }
  return out;
}

function defaultSessionAddress() {
  if (process.env.DBUS_SESSION_BUS_ADDRESS) return process.env.DBUS_SESSION_BUS_ADDRESS;
  if (process.env.XDG_RUNTIME_DIR) return 'unix:path=' + process.env.XDG_RUNTIME_DIR + '/bus';
  return '';
}

class DBusError extends Error {
  constructor(name, message) {
    super(name + (message ? ': ' + message : ''));
    this.name = 'DBusError';
    this.dbusName = name;
  }
}

/**
 * A connection to a message bus.
 * Events: 'signal' (Message), 'call' (Message, reply) for incoming method
 * calls when no handler matched, 'close' (Error|null).
 */
class Connection extends EventEmitter {
  constructor(sock) {
    super();
    this._sock = sock;
    this._serial = 1;
    this._pending = new Map();   // serial -> {resolve, reject, timer}
    this._rx = Buffer.alloc(0);
    this._closed = false;
    this._handlers = new Map();  // path -> fn(msg) => {signature, body} | Promise
    this.uniqueName = null;
    const self = this;
    sock.on('data', function (d) { self._onData(d); });
    sock.on('error', function (e) { self._close(e); });
    sock.on('close', function () { self._close(null); });
  }

  _nextSerial() {
    const s = this._serial;
    this._serial = this._serial >= 0xfffffffe ? 1 : this._serial + 1;
    return s;
  }

  _send(m) {
    if (this._closed) throw new Error('dbus: connection closed');
    this._sock.write(encodeMessage(m));
  }

  _onData(d) {
    this._rx = this._rx.length ? Buffer.concat([this._rx, d]) : d;
    for (;;) {
      let n;
      try { n = messageLength(this._rx); } catch (e) { this._close(e); this._sock.destroy(); return; }
      if (n < 0 || this._rx.length < n) return;
      const one = this._rx.subarray(0, n);
      this._rx = this._rx.subarray(n);
      let m;
      try { m = decodeMessage(Buffer.from(one)); } catch (e) { this._close(e); this._sock.destroy(); return; }
      this._dispatch(m);
    }
  }

  _dispatch(m) {
    if (m.type === TYPE.METHOD_RETURN || m.type === TYPE.ERROR) {
      const p = this._pending.get(m.replySerial);
      if (!p) return;
      this._pending.delete(m.replySerial);
      if (p.timer) clearTimeout(p.timer);
      if (m.type === TYPE.ERROR) p.reject(new DBusError(m.errorName || 'org.freedesktop.DBus.Error.Failed', typeof m.body[0] === 'string' ? m.body[0] : ''));
      else p.resolve(m.body);
      return;
    }
    if (m.type === TYPE.SIGNAL) { this.emit('signal', m); return; }
    if (m.type === TYPE.METHOD_CALL) this._onCall(m);
  }

  _onCall(m) {
    const self = this;
    const wantsReply = !(m.flags & FLAG_NO_REPLY_EXPECTED);
    function reply(signature, body) {
      if (!wantsReply) return;
      self._send({ type: TYPE.METHOD_RETURN, flags: FLAG_NO_REPLY_EXPECTED, serial: self._nextSerial(), replySerial: m.serial, destination: m.sender, signature: signature || '', body: body || [] });
    }
    function fail(name, msg) {
      if (!wantsReply) return;
      self._send({ type: TYPE.ERROR, flags: FLAG_NO_REPLY_EXPECTED, serial: self._nextSerial(), replySerial: m.serial, destination: m.sender, errorName: name, signature: 's', body: [String(msg || name)] });
    }
    if (m.interface === 'org.freedesktop.DBus.Peer' && m.member === 'Ping') { reply('', []); return; }
    const h = this._handlers.get(m.path);
    if (!h) { fail('org.freedesktop.DBus.Error.UnknownObject', 'no object at ' + m.path); return; }
    Promise.resolve().then(function () { return h(m); }).then(function (r) {
      if (r === undefined) { fail('org.freedesktop.DBus.Error.UnknownMethod', 'no method ' + m.interface + '.' + m.member); return; }
      try {
        reply(r && r.signature, r && r.body);
      } catch (e) {
        // The handler's reply could not be encoded: the caller must still get
        // an answer, not hang until its timeout.
        fail('org.freedesktop.DBus.Error.Failed', 'could not encode reply: ' + (e && e.message));
      }
    }, function (e) {
      fail((e && e.dbusName) || 'org.freedesktop.DBus.Error.Failed', e && e.message);
    }).catch(function () { /* connection gone */ });
  }

  _close(err) {
    if (this._closed) return;
    this._closed = true;
    for (const p of this._pending.values()) {
      if (p.timer) clearTimeout(p.timer);
      p.reject(err || new Error('dbus: connection closed'));
    }
    this._pending.clear();
    this.emit('close', err || null);
  }

  /**
   * Call a method and resolve with the reply body (an array).
   * @param {{destination?:string, path:string, interface?:string, member:string,
   *          signature?:string, body?:any[], timeoutMs?:number, noReply?:boolean}} o
   * @returns {Promise<any[]>}
   */
  call(o) {
    const self = this;
    const serial = this._nextSerial();
    const msg = {
      type: TYPE.METHOD_CALL, flags: o.noReply ? FLAG_NO_REPLY_EXPECTED : 0, serial: serial,
      destination: o.destination, path: o.path, interface: o.interface, member: o.member,
      signature: o.signature || '', body: o.body || [],
    };
    if (o.noReply) {
      try { this._send(msg); } catch (e) { return Promise.reject(e); }
      return Promise.resolve([]);
    }
    return new Promise(function (resolve, reject) {
      const timeoutMs = o.timeoutMs == null ? 25000 : o.timeoutMs;
      const entry = { resolve: resolve, reject: reject, timer: null };
      if (timeoutMs > 0) {
        entry.timer = setTimeout(function () {
          self._pending.delete(serial);
          reject(new DBusError('org.freedesktop.DBus.Error.NoReply', o.member + ' timed out after ' + timeoutMs + 'ms'));
        }, timeoutMs);
        if (entry.timer.unref) entry.timer.unref();
      }
      self._pending.set(serial, entry);
      try { self._send(msg); } catch (e) {
        self._pending.delete(serial);
        if (entry.timer) clearTimeout(entry.timer);
        reject(e);
      }
    });
  }

  /** Emit a signal from this connection. */
  signal(o) {
    this._send({
      type: TYPE.SIGNAL, flags: FLAG_NO_REPLY_EXPECTED, serial: this._nextSerial(),
      path: o.path, interface: o.interface, member: o.member, destination: o.destination,
      signature: o.signature || '', body: o.body || [],
    });
  }

  /** Serve incoming method calls on `path`. fn(msg) returns {signature, body}, undefined (unknown method) or throws. */
  serve(path, fn) {
    if (fn) this._handlers.set(path, fn); else this._handlers.delete(path);
  }

  /** Bus helpers. */
  busCall(member, signature, body) {
    return this.call({
      destination: 'org.freedesktop.DBus', path: '/org/freedesktop/DBus',
      interface: 'org.freedesktop.DBus', member: member, signature: signature, body: body,
    });
  }
  addMatch(rule) { return this.busCall('AddMatch', 's', [rule]); }
  removeMatch(rule) { return this.busCall('RemoveMatch', 's', [rule]); }
  async requestName(name, flags) {
    const r = await this.busCall('RequestName', 'su', [name, flags == null ? 4 : flags]); // 4 = DO_NOT_QUEUE
    return r[0]; // 1 primary owner, 2 in queue, 3 exists, 4 already owner
  }

  close() {
    try { this._sock.end(); } catch (e) { /* ignore */ }
    try { this._sock.destroy(); } catch (e) { /* ignore */ }
    this._close(null);
  }
}

function uidHex() {
  const uid = typeof process.getuid === 'function' ? process.getuid() : 0;
  return Buffer.from(String(uid), 'ascii').toString('hex');
}

/** SASL EXTERNAL handshake on a fresh socket. Resolves once BEGIN is sent. */
function authenticate(sock, timeoutMs) {
  return new Promise(function (resolve, reject) {
    let acc = '';
    const timer = setTimeout(function () { cleanup(); reject(new Error('dbus: auth timed out')); }, timeoutMs);
    function cleanup() {
      clearTimeout(timer);
      sock.removeListener('data', onData);
      sock.removeListener('error', onErr);
      sock.removeListener('close', onClose);
    }
    function onErr(e) { cleanup(); reject(e); }
    function onClose() { cleanup(); reject(new Error('dbus: connection closed during auth')); }
    function onData(d) {
      acc += d.toString('latin1');
      const nl = acc.indexOf('\r\n');
      if (nl === -1) { if (acc.length > 4096) { cleanup(); reject(new Error('dbus: bad auth reply')); } return; }
      const line = acc.slice(0, nl);
      const rest = acc.slice(nl + 2);
      cleanup();
      if (line.indexOf('OK ') !== 0) { reject(new Error('dbus: auth rejected (' + line.slice(0, 80) + ')')); return; }
      if (rest.length) { reject(new Error('dbus: unexpected data after auth')); return; }
      sock.write('BEGIN\r\n');
      resolve();
    }
    sock.on('data', onData);
    sock.on('error', onErr);
    sock.on('close', onClose);
    sock.write('\0AUTH EXTERNAL ' + uidHex() + '\r\n');
  });
}

/**
 * Connect, authenticate and say Hello.
 * @param {string} [address] D-Bus address; defaults to the session bus
 * @param {{timeoutMs?:number}} [opts]
 * @returns {Promise<Connection>}
 */
async function connect(address, opts) {
  const timeoutMs = (opts && opts.timeoutMs) || 5000;
  const paths = parseAddress(address || defaultSessionAddress());
  if (!paths.length) throw new Error('dbus: no usable unix session bus address');
  let lastErr = null;
  for (const p of paths) {
    try {
      const sock = await new Promise(function (resolve, reject) {
        const s = net.connect(p);
        s.once('connect', function () { s.removeListener('error', reject); resolve(s); });
        s.once('error', reject);
      });
      await authenticate(sock, timeoutMs);
      const conn = new Connection(sock);
      const hello = await conn.call({
        destination: 'org.freedesktop.DBus', path: '/org/freedesktop/DBus',
        interface: 'org.freedesktop.DBus', member: 'Hello', timeoutMs: timeoutMs,
      });
      conn.uniqueName = hello[0];
      return conn;
    } catch (e) {
      lastErr = e;
    }
  }
  throw lastErr || new Error('dbus: could not connect');
}

/** Build a match rule string from fields (values are quoted and escaped). */
function matchRule(fields) {
  return Object.keys(fields).filter(function (k) { return fields[k] != null; }).map(function (k) {
    return k + "='" + String(fields[k]).replace(/'/g, "'\\''") + "'";
  }).join(',');
}

module.exports = {
  connect: connect,
  matchRule: matchRule,
  DBusError: DBusError,
  TYPE: TYPE,
  // exported for tests
  _internal: {
    splitSignature: splitSignature, encodeMessage: encodeMessage, decodeMessage: decodeMessage,
    messageLength: messageLength, parseAddress: parseAddress, Writer: Writer, Reader: Reader,
  },
};
