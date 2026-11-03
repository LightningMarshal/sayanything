'use strict';

/*
 * Fake org.freedesktop.portal.Desktop for test/portal-test.js, served on a
 * private bus with the app's own D-Bus client. Implements the slice of the
 * GlobalShortcuts, RemoteDesktop, Request and Session interfaces the app uses,
 * following the xdg-desktop-portal docs: request methods return the request
 * object path built from the caller's unique name + handle_token, then answer
 * with a Response signal on it.
 *
 * Knobs (set on the returned object):
 *   cancel        Set of method names to answer with response code 1
 *   grantDevices  devices bitmask Start reports (default 1 = keyboard)
 *   restoreToken  restore_token Start reports
 * Records: calls (every method call), keys ([keysym, state] per
 * NotifyKeyboardKeysym), selectOptions (last SelectDevices options), bound.
 */

const dbus = require('../../src/main/linux/dbus');

const OBJ = '/org/freedesktop/portal/desktop';

function senderPart(name) { return String(name).replace(/^:/, '').replace(/\./g, '_'); }

async function startFakePortal(address) {
  const conn = await dbus.connect(address);
  const owned = await conn.requestName('org.freedesktop.portal.Desktop');
  if (owned !== 1) throw new Error('fake portal could not own the bus name');

  const fake = {
    conn: conn,
    cancel: new Set(),
    grantDevices: 1,
    restoreToken: 'restore-2',
    calls: [],
    keys: [],
    selectOptions: null,
    bound: [],
    sessions: new Map(), // path -> {kind, owner}
    activate: function (session, id, member) {
      conn.signal({ path: OBJ, interface: 'org.freedesktop.portal.GlobalShortcuts', member: member || 'Activated',
        signature: 'osta{sv}', body: [session, id, 12345n, {}] });
    },
    closeSession: function (session) {
      conn.signal({ path: session, interface: 'org.freedesktop.portal.Session', member: 'Closed', signature: 'a{sv}', body: [{}] });
    },
    stop: function () { conn.close(); },
  };

  function respond(m, options, results) {
    const token = options.handle_token;
    const path = OBJ + '/request/' + senderPart(m.sender) + '/' + token;
    const code = fake.cancel.has(m.member) ? 1 : 0;
    setTimeout(function () {
      conn.signal({ path: path, interface: 'org.freedesktop.portal.Request', member: 'Response', destination: m.sender,
        signature: 'ua{sv}', body: [code, code === 0 ? results : {}] });
    }, 20);
    return { signature: 'o', body: [path] };
  }

  function newSession(m, options, kind) {
    const path = OBJ + '/session/' + senderPart(m.sender) + '/' + options.session_handle_token;
    fake.sessions.set(path, { kind: kind, owner: m.sender });
    conn.serve(path, function (sm) {
      if (sm.interface === 'org.freedesktop.portal.Session' && sm.member === 'Close') {
        fake.calls.push('Session.Close');
        fake.sessions.delete(path);
        return { signature: '', body: [] };
      }
      return undefined;
    });
    return path;
  }

  function requireSession(m, path, kind) {
    const s = fake.sessions.get(path);
    if (!s || s.kind !== kind || s.owner !== m.sender) {
      const e = new Error('no such session'); /** @type {any} */ (e).dbusName = 'org.freedesktop.portal.Error.InvalidArgument'; throw e;
    }
  }

  conn.serve(OBJ, function (m) {
    fake.calls.push(m.member);
    if (m.interface === 'org.freedesktop.DBus.Properties' && m.member === 'Get') {
      return { signature: 'v', body: [['u', m.body[0] === 'org.freedesktop.portal.GlobalShortcuts' ? 1 : 2]] };
    }
    if (m.interface === 'org.freedesktop.portal.GlobalShortcuts') {
      if (m.member === 'CreateSession') {
        const o = m.body[0];
        return respond(m, o, { session_handle: ['o', newSession(m, o, 'gs')] });
      }
      if (m.member === 'BindShortcuts') {
        requireSession(m, m.body[0], 'gs');
        fake.bound = m.body[1].map(function (p) { return { id: p[0], description: p[1].description, preferred: p[1].preferred_trigger }; });
        const result = m.body[1].map(function (p) {
          return [p[0], { description: ['s', p[1].description], trigger_description: ['s', p[1].preferred_trigger || 'Super+Space'] }];
        });
        return respond(m, m.body[3], { shortcuts: ['a(sa{sv})', result] });
      }
      if (m.member === 'ListShortcuts') {
        requireSession(m, m.body[0], 'gs');
        return respond(m, m.body[1], { shortcuts: ['a(sa{sv})', fake.bound.map(function (b) {
          return [b.id, { description: ['s', b.description], trigger_description: ['s', b.preferred || ''] }];
        })] });
      }
    }
    if (m.interface === 'org.freedesktop.portal.RemoteDesktop') {
      if (m.member === 'CreateSession') {
        const o = m.body[0];
        return respond(m, o, { session_handle: ['s', newSession(m, o, 'rd')] });
      }
      if (m.member === 'SelectDevices') {
        requireSession(m, m.body[0], 'rd');
        fake.selectOptions = m.body[1];
        return respond(m, m.body[1], {});
      }
      if (m.member === 'Start') {
        requireSession(m, m.body[0], 'rd');
        return respond(m, m.body[2], { devices: ['u', fake.grantDevices], restore_token: ['s', fake.restoreToken] });
      }
      if (m.member === 'NotifyKeyboardKeysym') {
        requireSession(m, m.body[0], 'rd');
        fake.keys.push([m.body[2], m.body[3]]);
        return { signature: '', body: [] };
      }
    }
    return undefined;
  });
  return fake;
}

module.exports = { startFakePortal: startFakePortal };
