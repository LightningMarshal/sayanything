'use strict';

/*
 * Tests for src/main/linux/portal.js against a fake xdg-desktop-portal
 * (test/fixtures/fake-portal.js) on a private dbus-daemon. Linux only;
 * required on Linux CI, skipped elsewhere. Asserts:
 *   A) GlobalShortcuts: version, CreateSession, BindShortcuts (preferred
 *      trigger passed through, bound result normalized), Activated /
 *      Deactivated become 'activated' / 'deactivated' events
 *   B) a FORGED Activated from another bus peer is ignored
 *   C) RemoteDesktop: keyboard-only SelectDevices with persist_mode=2 and the
 *      saved restore token, Start returns the new token, pasteChord sends
 *      Ctrl down, v down, v up, Ctrl up
 *   D) user cancellation rejects with PortalError.cancelled; Start without a
 *      keyboard grant rejects
 *   E) portal-side Session.Closed emits 'closed'; close() calls Session.Close
 *
 * Exit code: 0 on success, 1 on any failed assertion.
 */

const dbus = require('../src/main/linux/dbus');
const portal = require('../src/main/linux/portal');
const { startPrivateBus, hasDbusDaemon } = require('./fixtures/private-bus');
const { startFakePortal } = require('./fixtures/fake-portal');

let failures = 0;
let passes = 0;
function check(cond, msg) {
  if (cond) { passes++; }
  else { failures++; console.error('  FAIL- ' + msg); }
}
function wait(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }
function nextEvent(em, name, ms) {
  return new Promise(function (resolve) {
    const t = setTimeout(function () { em.removeListener(name, on); resolve(null); }, ms);
    function on(v) { clearTimeout(t); resolve(v === undefined ? true : v); }
    em.once(name, on);
  });
}

async function main() {
  if (!hasDbusDaemon()) {
    if (process.platform === 'linux' && process.env.CI) check(false, 'dbus-daemon is required on Linux CI');
    else console.log('portal-test: SKIP (no dbus-daemon on this machine)');
    return;
  }
  const bus = await startPrivateBus();
  const fake = await startFakePortal(bus.address);
  const app = await dbus.connect(bus.address);
  const rogue = await dbus.connect(bus.address);
  try {
    // ---- A) GlobalShortcuts
    console.log('portal: GlobalShortcuts');
    check(await portal.GlobalShortcuts.version(app) === 1, 'A) version property read');
    const gs = new portal.GlobalShortcuts(app);
    const handle = await gs.create();
    check(/^\/org\/freedesktop\/portal\/desktop\/session\//.test(handle), 'A) CreateSession -> session handle');
    const bound = await gs.bind([{ id: 'dictate', description: 'Hold to dictate', preferredTrigger: 'LOGO+space' }], '');
    check(fake.bound.length === 1 && fake.bound[0].preferred === 'LOGO+space', 'A) preferred_trigger sent to the portal');
    check(bound.length === 1 && bound[0].id === 'dictate' && bound[0].triggerDescription === 'LOGO+space', 'A) bound shortcuts normalized');
    const listed = await gs.list();
    check(listed.length === 1 && listed[0].id === 'dictate', 'A) ListShortcuts');

    let ev = nextEvent(gs, 'activated', 2000);
    fake.activate(handle, 'dictate');
    let got = await ev;
    check(got && got.id === 'dictate' && got.timestamp === 12345, 'A) Activated -> activated {id, timestamp}');
    ev = nextEvent(gs, 'deactivated', 2000);
    fake.activate(handle, 'dictate', 'Deactivated');
    got = await ev;
    check(got && got.id === 'dictate', 'A) Deactivated -> deactivated');
    ev = nextEvent(gs, 'activated', 300);
    fake.activate('/org/freedesktop/portal/desktop/session/other/x', 'dictate');
    check(await ev === null, 'A) signals for another session are ignored');

    // ---- B) forged signal
    ev = nextEvent(gs, 'activated', 500);
    rogue.signal({ path: portal.OBJ_PATH, interface: 'org.freedesktop.portal.GlobalShortcuts', member: 'Activated',
      signature: 'osta{sv}', body: [handle, 'dictate', 1n, {}] });
    check(await ev === null, 'B) a forged Activated from another peer is ignored');
    ev = nextEvent(gs, 'closed', 500);
    rogue.signal({ path: handle, interface: 'org.freedesktop.portal.Session', member: 'Closed', signature: 'a{sv}', body: [{}] });
    check(await ev === null && gs.handle === handle, 'B) a forged Session.Closed is ignored');

    // ---- E) close
    await gs.close();
    check(fake.calls.indexOf('Session.Close') !== -1 && gs.handle === null, 'E) close() calls Session.Close');

    // ---- C) RemoteDesktop
    console.log('portal: RemoteDesktop');
    check(await portal.RemoteDesktop.version(app) === 2, 'C) version property read');
    const rd = new portal.RemoteDesktop(app);
    await rd.create();
    await rd.selectKeyboard({ restoreToken: 'restore-1' });
    const so = fake.selectOptions || {};
    check(so.types === portal.DEVICE.KEYBOARD, 'C) SelectDevices asks for the keyboard only');
    check(so.persist_mode === 2 && so.restore_token === 'restore-1', 'C) persist_mode=2 and the saved restore token');
    const st = await rd.start('');
    check(st.restoreToken === 'restore-2' && st.devices === 1, 'C) Start returns the new restore token');
    await rd.pasteChord();
    const K = portal.KEYSYM;
    check(JSON.stringify(fake.keys) === JSON.stringify([[K.Control_L, 1], [K.v, 1], [K.v, 0], [K.Control_L, 0]]),
      'C) pasteChord = Ctrl down, v down, v up, Ctrl up (' + JSON.stringify(fake.keys) + ')');

    // ---- E) portal closes the session
    ev = nextEvent(rd, 'closed', 2000);
    fake.closeSession(rd.handle);
    check(await ev === true && rd.handle === null, 'E) Session.Closed from the portal -> closed');
    let threw = false;
    try { await rd.pasteChord(); } catch (e) { threw = e instanceof portal.PortalError; }
    check(threw, 'E) using a closed session rejects with PortalError');

    // ---- D) cancellation / refusal
    console.log('portal: cancellation');
    fake.cancel.add('Start');
    const rd2 = new portal.RemoteDesktop(app);
    await rd2.create();
    await rd2.selectKeyboard({});
    let err = null;
    try { await rd2.start(''); } catch (e) { err = e; }
    check(err instanceof portal.PortalError && err.cancelled === true, 'D) user cancel -> PortalError.cancelled');
    fake.cancel.clear();
    fake.grantDevices = portal.DEVICE.POINTER;
    const rd3 = new portal.RemoteDesktop(app);
    await rd3.create();
    await rd3.selectKeyboard({ persist: false });
    check(fake.selectOptions && fake.selectOptions.persist_mode === undefined, 'D) persist:false omits persist_mode');
    err = null;
    try { await rd3.start(''); } catch (e) { err = e; }
    check(err instanceof portal.PortalError && !err.cancelled, 'D) Start without keyboard access rejects');
    await rd2.close();
    await rd3.close();
    await wait(50);
  } finally {
    app.close();
    rogue.close();
    fake.stop();
    bus.stop();
  }
}

main().catch(function (e) {
  failures++;
  console.error('  FAIL- unexpected error: ' + (e && e.stack || e));
}).then(function () {
  console.log('portal-test: ' + passes + ' passed, ' + failures + ' failed');
  process.exit(failures ? 1 : 0);
});
