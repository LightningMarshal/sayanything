'use strict';

/**
 * IPC surface tests (WS-13): plain node, fake ipcMain and fake modules.
 *
 *  1. The channel allowlists inlined in each preload (sandboxed preloads cannot
 *     require ipc.js) match the per-window lists in src/main/ipc.js exactly.
 *  2. Every channel a renderer may send/invoke has exactly one main-process
 *     handler, and no handler exists for a channel no renderer can reach.
 *  3. Renderer input is validated: unknown model names are refused (they flow
 *     into a file path and a URL), pad coordinates are coerced to integers, and
 *     an abandoned hotkey capture times out and disarms the helper.
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const EventEmitter = require('events');
const ipc = require('../src/main/ipc');
const { registerIpcHandlers } = require('../src/main/ipc-handlers');

let passed = 0;
let failed = 0;
function eq(a, b, label) {
  try { assert.deepStrictEqual(a, b); passed++; }
  catch (e) { failed++; console.error('FAIL: ' + label + '\n  expected ' + JSON.stringify(b) + '\n  actual   ' + JSON.stringify(a)); }
}
const sorted = function (a) { return a.slice().sort(); };

// ---- 1. preload allowlists == ipc.js -----------------------------------------
function preloadLists(file) {
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'preload', file), 'utf8');
  function arr(name) {
    const m = src.match(new RegExp('const ' + name + ' = (\\[[\\s\\S]*?\\]);'));
    if (!m) throw new Error(file + ': no ' + name + ' list');
    return JSON.parse(m[1].replace(/'/g, '"').replace(/,\s*\]/, ']'));
  }
  return { send: arr('SEND'), on: arr('ON'), invoke: arr('INVOKE') };
}
const WINDOWS = { overlay: ipc.OVERLAY, pad: ipc.PAD, settings: ipc.SETTINGS, welcome: ipc.WELCOME };
for (const w of Object.keys(WINDOWS)) {
  const p = preloadLists(w + '.js');
  for (const kind of ['send', 'on', 'invoke']) {
    eq(sorted(p[kind]), sorted(WINDOWS[w][kind]), 'preload ' + w + '.js ' + kind.toUpperCase() + ' matches ipc.js');
  }
}

// ---- fakes --------------------------------------------------------------------
function harness(over) {
  const on = {};
  const handle = {};
  const ipcMain = {
    on: function (ch, fn) { (on[ch] = on[ch] || []).push(fn); },
    handle: function (ch, fn) { (handle[ch] = handle[ch] || []).push(fn); },
  };
  const calls = [];
  /** @type {any} */
  const helper = new EventEmitter();
  helper.capture = function () { calls.push('capture'); };
  helper.captureCancel = function () { calls.push('captureCancel'); };
  const timers = [];
  const d = Object.assign({
    ipcMain: ipcMain, ipc: ipc, app: { getVersion: function () { return '9.9.9'; } },
    log: { error: function () {}, warn: function () {} },
    settingsStore: { get: function () { return { model: 'small.en', rewrite: {} }; }, set: function (p) { calls.push(['set', p]); return p; } },
    historyStore: { list: function () { return []; }, remove: function () {}, clear: function () {} },
    helper: helper,
    server: { status: function () { return { running: false }; } },
    models: {
      catalog: function () { return [{ name: 'small.en' }, { name: 'tiny.en' }]; },
      listLocal: function () { return ['small.en']; },
      download: function (name) { calls.push(['download', name]); return Promise.resolve(); },
      cancel: function () {},
    },
    rewriter: null, audioSession: { collect: function () {} }, windows: { movePad: function (x, y) { calls.push(['movePad', x, y]); } },
    state: {
      padDropAt: function (x, y) { calls.push(['padDropAt', x, y]); },
      padCopy: function () {}, padDismiss: function () {}, audioError: function () {}, silence: function () {},
    },
    permissions: null, isDarwin: false,
    restartWhisper: function () { return Promise.resolve(); },
    sendToSettings: function () {}, maybeStartAfterDownload: function () {},
    setTimer: function (fn, ms) { timers.push({ fn: fn, ms: ms }); return timers.length; },
    clearTimer: function () {},
  }, over || {});
  registerIpcHandlers(d);
  return { on: on, handle: handle, calls: calls, helper: helper, timers: timers };
}

// ---- 2. handlers <-> allowlists -------------------------------------------------
const h = harness();
const rendererSends = [].concat(ipc.OVERLAY.send, ipc.PAD.send, ipc.SETTINGS.send, ipc.WELCOME.send);
const rendererInvokes = [].concat(ipc.OVERLAY.invoke, ipc.PAD.invoke, ipc.SETTINGS.invoke, ipc.WELCOME.invoke);
eq(sorted(Object.keys(h.on)), sorted(rendererSends), 'ipcMain.on handlers == channels renderers may send');
eq(sorted(Object.keys(h.handle)), sorted(rendererInvokes), 'ipcMain.handle handlers == channels renderers may invoke');
eq(Object.keys(h.handle).every(function (c) { return h.handle[c].length === 1; }), true, 'each invoke channel has exactly one handler');

// ---- 3. input validation -----------------------------------------------------------
(async function () {
  // Unknown / path-traversal model names are refused before any download.
  for (const bad of ['../../evil', 'https://example.com/x', '', null, 'small.en/../x']) {
    let threw = false;
    try { await h.handle[ipc.MODELS_DOWNLOAD][0]({}, bad); } catch (e) { threw = true; }
    eq(threw, true, 'models:download refuses ' + JSON.stringify(bad));
  }
  eq(h.calls.filter(function (c) { return c[0] === 'download'; }).length, 0, 'no download started for bad names');
  await h.handle[ipc.MODELS_DOWNLOAD][0]({}, 'tiny.en');
  eq(h.calls.filter(function (c) { return c[0] === 'download'; }), [['download', 'tiny.en']], 'catalog name downloads');

  // Pad coordinates are coerced to integers; the text never comes from the renderer.
  h.on[ipc.PAD_PLACE][0]({}, { x: '12.9', y: 30.7, text: 'injected by renderer' });
  eq(h.calls.filter(function (c) { return c[0] === 'padDropAt'; }), [['padDropAt', 12, 30]], 'pad:place passes integer coords only');
  h.on[ipc.PAD_PLACE][0]({}, null);
  eq(h.calls.filter(function (c) { return c[0] === 'padDropAt'; }).length, 1, 'pad:place ignores a null payload');

  // models:list reports catalog state (incl. verified) without throwing.
  const list = await h.handle[ipc.MODELS_LIST][0]({});
  eq(list.map(function (m) { return [m.name, m.downloaded, m.active]; }), [['small.en', true, true], ['tiny.en', false, false]], 'models:list');

  // hotkey:linux reports what the desktop bound, and only on Linux.
  const notLinux = await h.handle[ipc.HOTKEY_LINUX][0]({});
  eq(notLinux, { linux: false, bound: [] }, 'hotkey:linux on Windows/macOS: linux false, nothing bound');
  const hl = harness({ isLinux: true });
  hl.helper.bound = [{ id: 'dictate', description: 'Dictate', triggerDescription: 'Ctrl+Meta+Space', extra: 'dropped' }];
  const onLinux = await hl.handle[ipc.HOTKEY_LINUX][0]({});
  eq(onLinux, { linux: true, bound: [{ id: 'dictate', description: 'Dictate', triggerDescription: 'Ctrl+Meta+Space' }] },
    'hotkey:linux on Linux: bound shortcuts, only the documented fields');

  // Hotkey capture: an abandoned capture times out AND disarms the helper.
  const h2 = harness();
  const p = h2.handle[ipc.HOTKEY_CAPTURE][0]({});
  eq(h2.calls.indexOf('capture') !== -1, true, 'capture: helper armed');
  eq(h2.timers.length, 1, 'capture: timeout scheduled');
  h2.timers[0].fn();
  let rejected = false;
  try { await p; } catch (e) { rejected = /timed out/.test(e.message); }
  eq(rejected, true, 'capture: times out');
  eq(h2.calls.indexOf('captureCancel') !== -1, true, 'capture: helper disarmed on timeout');

  // Capture success resolves with vk/name/mods.
  const h3 = harness();
  const p3 = h3.handle[ipc.HOTKEY_CAPTURE][0]({});
  h3.helper.emit('captured', { vk: 84, name: 'T', mods: [164] });
  eq(await p3, { vk: 84, name: 'T', mods: [164] }, 'capture: resolves with the captured key');

  // Rewrite model listing degrades when the module is unavailable.
  eq(await h.handle[ipc.REWRITE_MODELS][0]({}, {}), { reachable: false, models: [], host: '' }, 'rewrite:models without module');

  console.log('ipc-handlers-test: ' + passed + ' passed, ' + failed + ' failed');
  process.exit(failed > 0 ? 1 : 0);
})().catch(function (e) { console.error(e); process.exit(1); });
