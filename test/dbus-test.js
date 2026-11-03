'use strict';

/*
 * Tests for src/main/linux/dbus.js, the minimal D-Bus client behind the Linux
 * portal integration. Plain Node.
 *
 *  A) Wire format (every OS): round-trips for every type, alignment checked
 *     against hand-computed bytes, big-endian decoding, malformed input is
 *     rejected with an Error (never a crash or hang), address parsing.
 *  B) Interop (Linux with dbus-daemon): a private bus; Hello, bus calls, and
 *     systemd's busctl (an independent D-Bus implementation) calling a method
 *     we serve with a nested signature, so our decoding of THEIR encoding and
 *     their decoding of OUR reply are both checked. Required on Linux CI,
 *     skipped elsewhere.
 *
 * Exit code: 0 on success, 1 on any failed assertion.
 */

const { spawnSync, execFile } = require('child_process');

function runAsync(cmd, args, timeoutMs) {
  return new Promise(function (resolve) {
    execFile(cmd, args, { encoding: 'utf8', timeout: timeoutMs }, function (err, stdout, stderr) {
      resolve({ status: err ? (typeof err.code === 'number' ? err.code : 1) : 0, stdout: stdout, stderr: stderr });
    });
  });
}
const dbus = require('../src/main/linux/dbus');
const { startPrivateBus, hasDbusDaemon } = require('./fixtures/private-bus');

const I = dbus._internal;
let failures = 0;
let passes = 0;
function check(cond, msg) {
  if (cond) { passes++; }
  else { failures++; console.error('  FAIL- ' + msg); }
}
function deepEq(a, b) {
  return JSON.stringify(a, replacer) === JSON.stringify(b, replacer);
}
function replacer(k, v) {
  if (typeof v === 'bigint') return 'n:' + v.toString();
  if (v instanceof Map) return { __map: Array.from(v.entries()) };
  return v;
}
function throwsErr(fn) {
  try { fn(); return false; } catch (e) { return e instanceof Error; }
}

function roundTrip(sig, value, expected) {
  const enc = I.encodeMessage({ type: 1, serial: 7, path: '/a/b', member: 'M', signature: sig, body: [value] });
  const len = I.messageLength(enc);
  check(len === enc.length, sig + ': messageLength matches (' + len + ' vs ' + enc.length + ')');
  const m = I.decodeMessage(enc);
  check(m.signature === sig && m.path === '/a/b' && m.member === 'M' && m.serial === 7, sig + ': header fields survive');
  check(deepEq(m.body[0], expected === undefined ? value : expected), sig + ': value round-trips (' + JSON.stringify(m.body[0], replacer) + ')');
}

// ---- A) wire format ---------------------------------------------------------
function unitTests() {
  console.log('dbus wire format');
  roundTrip('y', 255);
  roundTrip('b', true);
  roundTrip('b', false);
  roundTrip('n', -32768);
  roundTrip('q', 65535);
  roundTrip('i', -2147483648);
  roundTrip('u', 4294967295);
  roundTrip('x', -9007199254740993n);
  roundTrip('t', 18446744073709551615n);
  roundTrip('t', 5, 5n);
  roundTrip('d', 3.25);
  roundTrip('s', 'héllo ✓ 𝄞');
  roundTrip('s', '');
  roundTrip('o', '/org/freedesktop/portal/desktop/request/1_42/sayanything_ab');
  roundTrip('g', 'a{sv}(ii)');
  roundTrip('ai', [1, -2, 3]);
  roundTrip('ai', []);
  roundTrip('at', [1n, 2n], [1n, 2n]);
  roundTrip('ay', Buffer.from([1, 2, 3]), [1, 2, 3]);
  roundTrip('(ybt)', [1, true, 9n]);
  roundTrip('a(sa{sv})', [['dictate', { description: ['s', 'Hold to dictate'], preferred_trigger: ['s', 'LOGO+space'] }]],
    [['dictate', { description: 'Hold to dictate', preferred_trigger: 'LOGO+space' }]]);
  roundTrip('a{sv}', { types: ['u', 1], persist_mode: ['u', 2], restore_token: ['s', 'tok'], nested: ['a{sv}', { x: ['t', 3n] }] },
    { types: 1, persist_mode: 2, restore_token: 'tok', nested: { x: 3n } });
  roundTrip('a{us}', new Map([[1, 'a'], [2, 'b']]));
  roundTrip('a{sv}', [['k', ['ai', [1, 2]]]], { k: [1, 2] });
  roundTrip('v', ['(sd)', ['pi', 3.14]], ['pi', 3.14]);
  roundTrip('aai', [[1], [], [2, 3]]);

  // Alignment, byte-exact: body 'yt' -> y at 0, pad to 8, t at 8 (16 bytes).
  const w = new I.Writer();
  w.write('y', 1); w.write('t', 2n);
  const b = w.result();
  check(b.length === 16 && b[0] === 1 && b.readBigUInt64LE(8) === 2n && b.subarray(1, 8).every(function (x) { return x === 0; }),
    'alignment: y then t pads to offset 8');
  // Empty array of 8-aligned elements still pads after the length.
  const w2 = new I.Writer();
  w2.write('a(tt)', []);
  check(w2.result().length === 8 && w2.result().readUInt32LE(0) === 0, 'alignment: empty a(tt) = length + pad to 8');
  // Dict entries are 8-aligned.
  const w3 = new I.Writer();
  w3.write('a{yy}', new Map([[1, 2], [3, 4]]));
  const b3 = w3.result();
  check(b3.readUInt32LE(0) === 10 && b3[8] === 1 && b3[9] === 2 && b3[16] === 3 && b3[17] === 4, 'alignment: dict entries start 8-aligned');

  // Big-endian message decodes (other implementations may send 'B').
  const be = Buffer.from([
    0x42, 2, 1, 1,        // 'B', METHOD_RETURN, flags=NO_REPLY, v1
    0, 0, 0, 4,           // body length 4
    0, 0, 0, 9,           // serial 9
    0, 0, 0, 15,          // fields array length = 8 + 7 = 15 bytes
    5, 1, 0x75, 0, 0, 0, 0, 3, // REPLY_SERIAL 'u' = 3 (padded to 4)
    8, 1, 0x67, 0, 1, 0x75, 0, // SIGNATURE 'g' = "u"
    0,                    // header pad to 8 (16 + 15 = 31 -> 32)
    0, 0, 1, 0,           // body: u = 256
  ]);
  check(I.messageLength(be) === be.length, 'big-endian: messageLength');
  const bm = I.decodeMessage(be);
  check(bm.type === 2 && bm.serial === 9 && bm.replySerial === 3 && bm.body[0] === 256, 'big-endian: header and body decode');

  // Encoder rejects bad input.
  check(throwsErr(function () { I.encodeMessage({ type: 1, serial: 1, signature: 'u', body: [-1] }); }), 'encode: u out of range');
  check(throwsErr(function () { I.encodeMessage({ type: 1, serial: 1, signature: 'i', body: [1.5] }); }), 'encode: non-integer');
  check(throwsErr(function () { I.encodeMessage({ type: 1, serial: 1, signature: 'o', body: ['not/a/path'] }); }), 'encode: bad object path');
  check(throwsErr(function () { I.encodeMessage({ type: 1, serial: 1, signature: 's', body: ['a\0b'] }); }), 'encode: NUL in string');
  check(throwsErr(function () { I.encodeMessage({ type: 1, serial: 1, signature: 'v', body: ['bare'] }); }), 'encode: variant without signature');
  check(throwsErr(function () { I.encodeMessage({ type: 1, serial: 1, signature: 'ss', body: ['one'] }); }), 'encode: body/signature count mismatch');
  check(throwsErr(function () { I.splitSignature('a{sv'); }), 'signature: unterminated dict');
  check(throwsErr(function () { I.splitSignature('()'); }), 'signature: empty struct');
  check(throwsErr(function () { I.splitSignature('a{svv}'); }), 'signature: 3-type dict entry');
  check(throwsErr(function () { I.splitSignature('z'); }), 'signature: unknown code');
  check(throwsErr(function () { I.splitSignature('a'.repeat(100) + 'i'); }), 'signature: too deep');
  check(deepEq(I.splitSignature('sa{sv}(ii)aai'), ['s', 'a{sv}', '(ii)', 'aai']), 'signature: split');

  // Decoder: truncation and corruption at every byte never crash.
  const good = I.encodeMessage({ type: 4, serial: 3, path: '/x', interface: 'a.b', member: 'S', signature: 'sa{sv}t',
    body: ['hi', { k: ['as', ['a', 'b']] }, 4n] });
  let ok = true;
  for (let cut = 0; cut < good.length; cut++) {
    const part = good.subarray(0, cut);
    try {
      const n = I.messageLength(part);
      if (n !== -1 && n <= part.length) I.decodeMessage(part);
    } catch (e) { if (!(e instanceof Error)) ok = false; }
  }
  check(ok, 'decode: every truncation fails cleanly');
  let seed = 12345;
  function rnd() { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed; }
  let crashes = 0;
  for (let t = 0; t < 3000; t++) {
    const m = Buffer.from(good);
    const flips = 1 + (rnd() % 4);
    for (let f = 0; f < flips; f++) m[rnd() % m.length] = rnd() & 0xff;
    try {
      const n = I.messageLength(m);
      if (n === m.length) I.decodeMessage(m);
    } catch (e) { if (!(e instanceof Error)) crashes++; }
  }
  check(crashes === 0, 'decode: 3000 random corruptions fail cleanly');

  // Address parsing.
  check(deepEq(I.parseAddress('unix:path=/run/user/1000/bus'), ['/run/user/1000/bus']), 'address: path');
  check(deepEq(I.parseAddress('unix:abstract=/tmp/dbus-x,guid=abc'), ['\0/tmp/dbus-x']), 'address: abstract');
  check(deepEq(I.parseAddress('tcp:host=x,port=1;unix:path=/a%20b'), ['/a b']), 'address: skips tcp, unescapes');
  check(deepEq(I.parseAddress(''), []), 'address: empty');
  check(dbus.matchRule({ type: 'signal', path: "/a", member: "it's" }) === "type='signal',path='/a',member='it'\\''s'", 'matchRule quoting');
}

// ---- B) interop with a real bus ---------------------------------------------
async function interopTests() {
  if (!hasDbusDaemon()) {
    if (process.platform === 'linux' && process.env.CI) {
      check(false, 'interop: dbus-daemon is required on Linux CI');
    } else {
      console.log('dbus interop: SKIP (no dbus-daemon on this machine)');
    }
    return;
  }
  console.log('dbus interop (private dbus-daemon)');
  const bus = await startPrivateBus();
  let a = null;
  let b = null;
  try {
    a = await dbus.connect(bus.address);
    b = await dbus.connect(bus.address);
    check(/^:\d+\.\d+$/.test(a.uniqueName || ''), 'Hello returns a unique name (' + a.uniqueName + ')');
    const id = await a.busCall('GetId', '', []);
    check(typeof id[0] === 'string' && id[0].length === 32, 'GetId returns the bus id');
    const names = (await a.busCall('ListNames', '', []))[0];
    check(names.indexOf(a.uniqueName) !== -1 && names.indexOf(b.uniqueName) !== -1, 'ListNames includes both connections');

    // Our client <-> our server, through the daemon.
    // Decoding drops variant signatures, so Echo re-wraps a{sv} values
    // (integers -> 'i', string arrays -> 'as', other strings -> 's').
    function rewrap(sig, body) {
      const types = I.splitSignature(sig);
      return body.map(function (v, i) {
        if (types[i] !== 'a{sv}') return v;
        const o = {};
        Object.keys(v).forEach(function (k) {
          const x = v[k];
          o[k] = Array.isArray(x) ? ['as', x] : (typeof x === 'number' ? ['i', x] : ['s', String(x)]);
        });
        return o;
      });
    }
    a.serve('/test', function (m) {
      if (m.interface === 'com.example.Test' && m.member === 'Echo') return { signature: m.signature, body: rewrap(m.signature, m.body) };
      if (m.member === 'BadReply') return { signature: 'v', body: ['no signature'] };
      if (m.member === 'Boom') { const e = new Error('nope'); /** @type {any} */ (e).dbusName = 'com.example.Error.Boom'; throw e; }
      return undefined;
    });
    const sig = 'sa{sv}a(tb)';
    const body = ['x', { n: ['i', -5], s: ['as', ['p', 'q']] }, [[1n, true], [2n, false]]];
    const echo = await b.call({ destination: a.uniqueName, path: '/test', interface: 'com.example.Test', member: 'Echo', signature: sig, body: body });
    check(deepEq(echo, ['x', { n: -5, s: ['p', 'q'] }, [[1n, true], [2n, false]]]), 'method call round-trips through the daemon');
    let errName = '';
    try { await b.call({ destination: a.uniqueName, path: '/test', interface: 'com.example.Test', member: 'Boom' }); }
    catch (e) { errName = e.dbusName; }
    check(errName === 'com.example.Error.Boom', 'errors carry the D-Bus error name');
    errName = '';
    try { await b.call({ destination: a.uniqueName, path: '/test', member: 'BadReply', timeoutMs: 3000 }); } catch (e) { errName = e.dbusName; }
    check(errName === 'org.freedesktop.DBus.Error.Failed', 'an unencodable reply becomes an error, not a hang');
    errName = '';
    try { await b.call({ destination: a.uniqueName, path: '/nothing', member: 'X' }); } catch (e) { errName = e.dbusName; }
    check(errName === 'org.freedesktop.DBus.Error.UnknownObject', 'unknown object -> UnknownObject');

    // Signals with a match rule.
    const got = new Promise(function (resolve) {
      b.on('signal', function (m) { if (m.member === 'Ping' && m.interface === 'com.example.Test') resolve(m); });
    });
    await b.addMatch(dbus.matchRule({ type: 'signal', interface: 'com.example.Test' }));
    a.signal({ path: '/test', interface: 'com.example.Test', member: 'Ping', signature: 'ot', body: ['/test', 99n] });
    const sm = await got;
    check(sm.sender === a.uniqueName && sm.body[0] === '/test' && sm.body[1] === 99n, 'signal delivered with sender and body');

    const owned = await a.requestName('com.example.Owned');
    check(owned === 1, 'RequestName -> primary owner');

    // Independent implementation: systemd's busctl calls our Echo.
    const busctl = spawnSync('busctl', ['--version'], { stdio: 'ignore' });
    if (busctl.status !== 0) {
      console.log('  busctl not installed: skipping cross-implementation check');
    } else {
      // Must be async: spawnSync would block the event loop that serves Echo.
      const r = await runAsync('busctl', ['--address=' + bus.address, '--json=short', 'call', '--', a.uniqueName, '/test', 'com.example.Test', 'Echo',
        'sa{sv}at', 'hé', '2', 'k', 'i', '-7', 'l', 'as', '2', 'p', 'q', '3', '1', '18446744073709551615', '0'],
        10000);
      let parsed = null;
      try { parsed = JSON.parse(r.stdout); } catch (e) { /* reported below */ }
      check(r.status === 0 && parsed && parsed.type === 'sa{sv}at', 'busctl call succeeded (' + (r.stderr || '').trim() + ')');
      if (parsed) {
        const d = parsed.data;
        check(d[0] === 'hé', 'busctl: string survives our decode + encode');
        check(d[1].k && d[1].k.type === 'i' && d[1].k.data === -7, 'busctl: a{sv} int variant survives');
        check(d[1].l && d[1].l.type === 'as' && deepEq(d[1].l.data, ['p', 'q']), 'busctl: a{sv} array variant survives');
        // JSON.parse rounds 2^64-1, so check busctl's raw text for the exact digits.
        check(d[2].length === 3 && d[2][0] === 1 && d[2][2] === 0 && /\[1,18446744073709551615,0\]/.test(r.stdout), 'busctl: at incl. max uint64 survives');
      }
    }
  } finally {
    if (a) a.close();
    if (b) b.close();
    bus.stop();
  }
}

(async function main() {
  try {
    unitTests();
    await interopTests();
  } catch (e) {
    failures++;
    console.error('  FAIL- unexpected error: ' + (e && e.stack || e));
  }
  console.log('dbus-test: ' + passes + ' passed, ' + failures + ' failed');
  process.exit(failures ? 1 : 0);
})();
