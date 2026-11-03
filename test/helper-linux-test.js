'use strict';

/*
 * Tests for src/main/linux/helper-linux.js, the Linux stand-in for the native
 * helper, against the fake xdg-desktop-portal on a private dbus-daemon, with a
 * fake clipboard and a temp user-data dir. Plain Node.
 *
 *  A) triggerFor(): Windows-VK bindings -> XDG trigger strings (every OS)
 *  B) start(): binds 'dictate' + 'pad' with preferred triggers, emits ready
 *     and bound; Activated/Deactivated -> 'shortcut' {id:'main'|'pad', down}
 *  C) paste(): clipboard snapshot -> dictation -> Ctrl+V via RemoteDesktop ->
 *     restore; the restore token is saved 0600 and reused by the next start;
 *     the keyboard session is created once, not per paste
 *  D) refused keyboard access: text stays on the clipboard,
 *     {ok:true, clipboardOnly:true}; not asked again in the same run
 *  E) no GlobalShortcuts portal: start() rejects with a userMessage
 *  F) capture() throws with guidance; placeAt() rejects but leaves the text on
 *     the clipboard; foreground() is blank
 *
 * B-F need dbus-daemon: required on Linux CI, skipped elsewhere.
 * Exit code: 0 on success, 1 on any failed assertion.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { LinuxHelper, triggerFor, DEFAULT_TRIGGER } = require('../src/main/linux/helper-linux');
const portal = require('../src/main/linux/portal');
const { startPrivateBus, hasDbusDaemon } = require('./fixtures/private-bus');
const { startFakePortal } = require('./fixtures/fake-portal');

let failures = 0;
let passes = 0;
function check(cond, msg) {
  if (cond) { passes++; }
  else { failures++; console.error('  FAIL- ' + msg); }
}
function nextEvent(em, name, ms) {
  return new Promise(function (resolve) {
    const t = setTimeout(function () { em.removeListener(name, on); resolve(null); }, ms);
    function on(v) { clearTimeout(t); resolve(v === undefined ? true : v); }
    em.once(name, on);
  });
}

function fakeClipboard(initial) {
  const cb = {
    text: initial || '', html: '', writes: [],
    readText: function () { return cb.text; },
    readHTML: function () { return cb.html; },
    readRTF: function () { return ''; },
    readImage: function () { return { isEmpty: function () { return true; } }; },
    writeText: function (t) { cb.text = t; cb.html = ''; cb.writes.push(['text', t]); },
    write: function (d) { cb.text = d.text || ''; cb.html = d.html || ''; cb.writes.push(['write', d]); },
    clear: function () { cb.text = ''; cb.html = ''; cb.writes.push(['clear']); },
  };
  return cb;
}

const silent = { info: function () {}, warn: function () {}, error: function () {} };

function unitTests() {
  console.log('helper-linux: triggerFor');
  check(triggerFor({ vk: 68, mods: [17, 18] }) === 'CTRL+ALT+d', 'Ctrl+Alt+D -> CTRL+ALT+d');
  check(triggerFor({ vk: 32, mods: [91] }) === 'LOGO+space', 'Win+Space -> LOGO+space');
  check(triggerFor({ vk: 120, mods: [] }) === 'F9', 'F9 -> F9');
  check(triggerFor({ vk: 49, mods: [16, 17] }) === 'CTRL+SHIFT+1', 'modifier order is canonical');
  check(triggerFor({ vk: 163, mods: [] }) === null, 'bare Right Ctrl -> null (use the default)');
  check(triggerFor({ vk: 84, mods: [164] }) === null, 'physical Left Alt modifier -> null');
  check(triggerFor(null) === null, 'missing binding -> null');
  check(/^CTRL\+LOGO\+space$/.test(DEFAULT_TRIGGER.main), 'default main trigger is a chord, not Super+Space');
}

async function busTests() {
  if (!hasDbusDaemon()) {
    if (process.platform === 'linux' && process.env.CI) check(false, 'dbus-daemon is required on Linux CI');
    else console.log('helper-linux: SKIP bus tests (no dbus-daemon on this machine)');
    return;
  }
  const bus = await startPrivateBus();
  const fake = await startFakePortal(bus.address);
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sa-linux-helper-'));
  const helpers = [];
  function make(cb, settings) {
    const h = new LinuxHelper({
      address: bus.address, clipboard: cb, userData: tmp, log: silent,
      settings: function () { return settings || { hotkey: { vk: 163, mods: [] }, padHotkey: { vk: 68, mods: [17, 18] } }; },
    });
    helpers.push(h);
    return h;
  }
  try {
    // ---- B) start + shortcuts
    console.log('helper-linux: shortcuts');
    const cb = fakeClipboard('user clipboard');
    const h = make(cb);
    const readyEv = nextEvent(h, 'ready', 3000);
    await h.start();
    check(await readyEv === true && h.ready === true, 'B) start() resolves and emits ready');
    check(fake.bound.length === 3 && fake.bound[0].id === 'dictate' && fake.bound[1].id === 'pad' && fake.bound[2].id === 'cancel', 'B) binds dictate + pad + cancel');
    check(fake.bound[2].preferred === DEFAULT_TRIGGER.cancel && DEFAULT_TRIGGER.cancel !== 'Escape', 'B) cancel is a chord, never a bare Esc');
    check(h.bound.length === 3 && h.bound[2].triggerDescription === DEFAULT_TRIGGER.cancel, 'B) bound shortcuts kept for Settings');
    check(fake.bound[0].preferred === DEFAULT_TRIGGER.main, 'B) bare-modifier hotkey falls back to the default chord');
    check(fake.bound[1].preferred === 'CTRL+ALT+d', 'B) an expressible pad hotkey is offered as-is');
    check(await h.ping() === true, 'B) ping() true once ready');
    const session = h._gs.handle;
    let ev = nextEvent(h, 'shortcut', 2000);
    fake.activate(session, 'dictate');
    let got = await ev;
    check(got && got.id === 'main' && got.down === true, 'B) Activated dictate -> shortcut main down');
    ev = nextEvent(h, 'shortcut', 2000);
    fake.activate(session, 'dictate', 'Deactivated');
    got = await ev;
    check(got && got.id === 'main' && got.down === false, 'B) Deactivated -> shortcut main up');
    ev = nextEvent(h, 'shortcut', 2000);
    fake.activate(session, 'pad');
    got = await ev;
    check(got && got.id === 'pad' && got.down === true, 'B) Activated pad -> shortcut pad down');
    ev = nextEvent(h, 'shortcut', 2000);
    fake.activate(session, 'cancel');
    got = await ev;
    check(got && got.id === 'cancel' && got.down === true, 'B) Activated cancel -> shortcut cancel down');

    // ---- C) paste through RemoteDesktop
    console.log('helper-linux: paste');
    const res = await h.paste('dictated words', 30);
    check(res && res.ok === true && !res.clipboardOnly, 'C) paste ok');
    const K = portal.KEYSYM;
    check(JSON.stringify(fake.keys) === JSON.stringify([[K.Control_L, 1], [K.v, 1], [K.v, 0], [K.Control_L, 0]]), 'C) Ctrl+V sent through the portal');
    check(cb.writes.some(function (w) { return w[0] === 'text' && w[1] === 'dictated words'; }), 'C) dictation was put on the clipboard');
    check(cb.text === 'user clipboard', 'C) the user\'s clipboard is restored afterwards');
    const tokFile = path.join(tmp, 'linux-portal.json');
    const tok = JSON.parse(fs.readFileSync(tokFile, 'utf8'));
    check(tok.remoteDesktopRestoreToken === 'restore-2', 'C) restore token saved');
    if (process.platform !== 'win32') check((fs.statSync(tokFile).mode & 0o777) === 0o600, 'C) token file is 0600');
    const startsBefore = fake.calls.filter(function (c) { return c === 'Start'; }).length;
    await h.paste('again', 0);
    const startsAfter = fake.calls.filter(function (c) { return c === 'Start'; }).length;
    check(startsBefore === 1 && startsAfter === 1, 'C) keyboard session reused (one Start for two pastes)');
    check(fake.keys.length === 8, 'C) second paste sent another Ctrl+V');
    const t1 = h.type('typed');
    check(typeof t1.then === 'function', 'C) type() returns a promise');
    check((await t1).ok === true, 'C) type() falls back to paste');
    await h.stop();

    // Second launch reuses the saved token.
    fake.selectOptions = null;
    const h2 = make(fakeClipboard(''));
    await h2.start();
    await h2.paste('x', 0);
    check(fake.selectOptions && fake.selectOptions.restore_token === 'restore-2', 'C) next launch passes the saved restore token');
    await h2.stop();

    // ---- D) refused keyboard access
    console.log('helper-linux: refused keyboard access');
    fake.cancel.add('Start');
    const cb3 = fakeClipboard('before');
    const h3 = make(cb3);
    await h3.start();
    const r3 = await h3.paste('only on clipboard', 30);
    check(r3.ok === true && r3.clipboardOnly === true, 'D) refused -> {ok:true, clipboardOnly:true}');
    check(cb3.text === 'only on clipboard', 'D) dictation stays on the clipboard (not restored away)');
    const startsNow = fake.calls.filter(function (c) { return c === 'Start'; }).length;
    await h3.paste('second', 0);
    check(fake.calls.filter(function (c) { return c === 'Start'; }).length === startsNow, 'D) not asked again in the same run');
    fake.cancel.clear();

    // ---- F) unsupported operations
    console.log('helper-linux: unsupported operations');
    let threw = null;
    try { h3.capture(); } catch (e) { threw = e; }
    check(threw && /desktop settings/.test(threw.userMessage || ''), 'F) capture() throws with guidance');
    let rejected = false;
    try { await /** @type {any} */ (h3).placeAt('placed text', 10, 10, 0); } catch (e) { rejected = true; }
    check(rejected && cb3.text === 'placed text', 'F) placeAt() rejects but leaves the text on the clipboard');
    const fg = await h3.foreground();
    check(fg.exe === '' && fg.title === '', 'F) foreground() is blank on Wayland');
    await h3.stop();

    // ---- RemoteDesktop portal missing entirely
    fake.missing.add('org.freedesktop.portal.RemoteDesktop');
    const cb5 = fakeClipboard('');
    const h5 = make(cb5);
    await h5.start();
    const r5 = await h5.paste('no portal', 0);
    check(r5.ok === true && r5.clipboardOnly === true && cb5.text === 'no portal', 'D) no RemoteDesktop portal -> clipboard only');
    await h5.stop();
    fake.missing.clear();

    // ---- E) no GlobalShortcuts portal
    console.log('helper-linux: missing portal');
    fake.missing.add('org.freedesktop.portal.GlobalShortcuts');
    const h4 = make(fakeClipboard(''));
    let err = null;
    try { await h4.start(); } catch (e) { err = e; }
    check(err && /global shortcuts/i.test(err.userMessage || '') && h4.ready === false, 'E) no GlobalShortcuts -> start() rejects with a userMessage');
    await h4.stop();
    fake.missing.clear();
  } finally {
    for (const h of helpers) { try { await h.stop(); } catch (e) { /* ignore */ } }
    fake.stop();
    bus.stop();
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (e) { /* ignore */ }
  }
}

(async function main() {
  try {
    unitTests();
    await busTests();
  } catch (e) {
    failures++;
    console.error('  FAIL- unexpected error: ' + (e && e.stack || e));
  }
  console.log('helper-linux-test: ' + passes + ' passed, ' + failures + ' failed');
  process.exit(failures ? 1 : 0);
})();
