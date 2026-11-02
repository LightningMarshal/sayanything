'use strict';

/**
 * Scenario tests for the dictation state machine (src/main/state.js).
 *
 * Run: `node test/state-test.js` — exits non-zero on any failure. Plain node,
 * no framework, no Electron: the machine is built with createStateMachine()
 * and every collaborator (helper, windows, audio, whisper client, settings,
 * history, rewrite) is a small fake defined below. Time is a manual clock, so
 * tap-vs-hold timing and timers are deterministic.
 *
 * Each scenario builds a fresh machine via harness(), drives helper 'key'
 * events the way the native helper would, and asserts on what the machine
 * asked the fakes to do (paste/copy calls, overlay states, watch sets, ...).
 */

const assert = require('assert');
const EventEmitter = require('events');
const { createStateMachine, TAP_MS } = require('../src/main/state');
const ipc = require('../src/main/ipc');
const hotkeyMatch = require('../src/main/hotkey-match');
const formatter = require('../src/main/whisper/formatter');

const RCTRL = 163;
const RALT = 165;
const ESC = 27;
const LALT = 164;
const KEY_T = 84;

// ---------------------------------------------------------------------------
// fakes
// ---------------------------------------------------------------------------

function deepMerge(base, part) {
  for (const k of Object.keys(part)) {
    const v = part[k];
    if (v && typeof v === 'object' && !Array.isArray(v) && base[k] && typeof base[k] === 'object') {
      deepMerge(base[k], v);
    } else {
      base[k] = v;
    }
  }
  return base;
}

function defaultSettings() {
  return {
    hotkey: { vk: RCTRL, name: 'Right Ctrl', mods: [] },
    padHotkey: { vk: RALT, name: 'Right Alt', mods: [] },
    pad: { enabled: true, excludeFromClipboardHistory: true },
    mic: { deviceId: 'default', preRollMs: 0, warm: false },
    model: 'small.en',
    language: 'en',
    format: { fillerRemoval: true, voiceCommands: true, trailingSpace: true, autoCapitalize: true, artifactStrip: true },
    dictionary: [],
    rewrite: { enabled: false, style: 'cleanup', model: '', timeoutMs: 10000 },
    inject: { mode: 'paste', restoreClipboardMs: 300 },
    streaming: { enabled: false },
    autoStop: { enabled: true, silenceMs: 2000 },
    overlay: { chime: false, offsetY: 48 },
    history: { enabled: true, max: 200 },
    paused: false,
    maxUtteranceSec: 300,
  };
}

function harness(opts) {
  opts = opts || {};
  const calls = [];             // ordered log of interesting side effects
  let clock = 1000;
  let timerSeq = 0;
  const timers = [];            // {id, at, fn}

  const settings = deepMerge(defaultSettings(), opts.settings || {});
  const listeners = [];
  const settingsStore = {
    get: function () { return settings; },
    onChange: function (cb) { listeners.push(cb); return function () {}; },
    set: function (partial) { deepMerge(settings, partial); listeners.forEach(function (cb) { cb(settings); }); },
  };

  const helper = new EventEmitter();
  helper.watched = [];
  helper.watch = function (vks) { helper.watched = vks.slice().sort(function (a, b) { return a - b; }); };
  helper.paste = function (text, restoreMs) { calls.push(['paste', text, restoreMs]); return Promise.resolve({ ok: true }); };
  helper.type = function (text) { calls.push(['type', text]); return Promise.resolve({ ok: true }); };
  helper.copy = function (text, o) { calls.push(['copy', text, !!(o && o.noHistory)]); return Promise.resolve({ ok: true }); };
  helper.placeAt = function (text, x, y) { calls.push(['placeAt', text, x, y]); return Promise.resolve({ ok: true }); };
  helper.foreground = function () { return Promise.resolve({ exe: 'notepad.exe', title: 'x' }); };

  const overlay = [];           // overlay states in order
  const windows = {
    getOverlayWC: function () {
      return { send: function (ch, payload) { if (ch === ipc.OVERLAY_STATE) overlay.push(payload.state); else calls.push([ch, payload]); } };
    },
    getPadWC: function () { return { send: function (ch, payload) { calls.push([ch, payload]); } }; },
    showOverlay: function () {}, hideOverlay: function () {},
    showPad: function () { calls.push(['showPad']); }, hidePad: function () {},
  };

  const audio = { begun: [], aborted: [], finished: [] };
  const audioSession = {
    begin: function (o) { audio.begun.push(o.sessionId); },
    finish: function (id) { audio.finished.push(id); return Promise.resolve(Buffer.from('wav' + id)); },
    abort: function (id) { audio.aborted.push(id); },
  };

  // Transcripts are handed out per call; a test may supply deferred ones to
  // control completion order (overlapping sessions).
  const transcripts = (opts.transcripts || ['hello world']).slice();
  const client = {
    transcribe: function () {
      const next = transcripts.length ? transcripts.shift() : 'hello world';
      if (next && typeof next.then === 'function') return next.then(function (t) { return { text: t, ms: 5 }; });
      return Promise.resolve({ text: next, ms: 5 });
    },
  };

  const history = { items: [], add: function (it) { history.items.push(it); } };
  const noop = function () {};
  const log = { info: noop, warn: noop, error: noop, debug: noop };

  const sm = createStateMachine({
    ipc: ipc, log: log, settingsStore: settingsStore, helper: helper, hotkeyMatch: hotkeyMatch,
    audioSession: audioSession, client: client,
    streaming: { start: noop, stop: noop },
    formatter: formatter,
    rewriter: { rewrite: function (t) { return Promise.resolve({ text: t.trim().toUpperCase(), reason: 'ok' }); } },
    history: history, windows: windows,
    now: function () { return clock; },
    setTimer: function (fn, ms) { const id = ++timerSeq; timers.push({ id: id, at: clock + ms, fn: fn }); return id; },
    clearTimer: function (id) { const i = timers.findIndex(function (t) { return t.id === id; }); if (i !== -1) timers.splice(i, 1); },
    platform: 'win32',
  });
  sm.init();

  function advance(ms) {
    const until = clock + ms;
    for (;;) {
      timers.sort(function (a, b) { return a.at - b.at; });
      const t = timers[0];
      if (!t || t.at > until) break;
      timers.shift();
      clock = t.at;
      t.fn();
    }
    clock = until;
  }

  function key(vk, down, extra) {
    const ev = { vk: vk, down: down };
    if (extra) Object.assign(ev, extra);
    helper.emit('key', ev);
  }
  // Physical press: down, hold `ms`, up.
  function press(vk, ms, extra) {
    key(vk, true, extra);
    advance(ms);
    key(vk, false, extra);
  }

  return {
    sm: sm, helper: helper, calls: calls, overlay: overlay, audio: audio, history: history,
    settingsStore: settingsStore, advance: advance, key: key, press: press,
    pastes: function () { return calls.filter(function (c) { return c[0] === 'paste'; }).map(function (c) { return c[1]; }); },
    copies: function () { return calls.filter(function (c) { return c[0] === 'copy'; }); },
  };
}

// Let all pending promise chains settle (the pipeline is promise-based).
function settle() { return new Promise(function (r) { setImmediate(r); }).then(function () { return new Promise(function (r) { setImmediate(r); }); }); }

// ---------------------------------------------------------------------------
// runner
// ---------------------------------------------------------------------------

let passed = 0;
let failed = 0;
const scenarios = [];
function scenario(name, fn) { scenarios.push({ name: name, fn: fn }); }
function eq(actual, expected, label) {
  try { assert.deepStrictEqual(actual, expected); passed++; }
  catch (e) {
    failed++;
    console.error('FAIL: ' + label);
    console.error('  expected: ' + JSON.stringify(expected));
    console.error('  actual:   ' + JSON.stringify(actual));
  }
}

// ---------------------------------------------------------------------------
// scenarios
// ---------------------------------------------------------------------------

scenario('hold >= TAP_MS finalizes and pastes', async function () {
  const h = harness();
  h.press(RCTRL, TAP_MS + 200);
  await settle();
  eq(h.pastes(), ['Hello world '], 'hold: one paste of the formatted text');
  eq(h.overlay.slice(0, 3), ['listening', 'transcribing', 'success'], 'hold: overlay sequence');
  eq(h.history.items.length, 1, 'hold: history recorded once');
  eq(h.history.items[0].app, 'notepad.exe', 'hold: history records the foreground app');
  eq(h.sm._peek().recording, null, 'hold: machine back to idle');
});

scenario('tap latches; second tap finalizes', async function () {
  const h = harness();
  h.press(RCTRL, 100);
  await settle();
  eq(h.sm._peek().recording && h.sm._peek().recording.phase, 'latched', 'tap: session latched');
  eq(h.pastes(), [], 'tap: nothing pasted yet');
  eq(h.calls.some(function (c) { return c[0] === ipc.AUDIO_VAD && c[1].enabled; }), true, 'tap: auto-stop VAD armed');
  h.advance(3000);
  h.press(RCTRL, 80);
  await settle();
  eq(h.pastes(), ['Hello world '], 'tap: second tap pasted');
  eq(h.sm._peek().recording, null, 'tap: idle after second tap');
});

scenario('Esc cancels a recording; nothing is inserted', async function () {
  const h = harness();
  h.key(RCTRL, true);
  eq(h.helper.watched.indexOf(ESC) !== -1, true, 'esc: Esc is watched while recording');
  h.advance(500);
  h.key(ESC, true);
  h.key(ESC, false);
  h.key(RCTRL, false);
  await settle();
  eq(h.pastes(), [], 'esc: nothing pasted');
  eq(h.audio.aborted.length, 1, 'esc: audio aborted');
  eq(h.overlay.indexOf('cancelled') !== -1, true, 'esc: overlay shows cancelled');
  eq(h.helper.watched.indexOf(ESC), -1, 'esc: Esc no longer watched when idle');
});

scenario('OS key-repeat is ignored', async function () {
  const h = harness();
  h.key(RCTRL, true);
  h.advance(100); h.key(RCTRL, true);
  h.advance(100); h.key(RCTRL, true);
  h.advance(300); h.key(RCTRL, false);
  await settle();
  eq(h.audio.begun.length, 1, 'repeat: exactly one session started');
  eq(h.pastes().length, 1, 'repeat: exactly one paste');
});

scenario('overlapping sessions inject in start order', async function () {
  let releaseFirst;
  const first = new Promise(function (r) { releaseFirst = r; });
  const h = harness({ transcripts: [first, 'second one'] });
  h.press(RCTRL, 400);               // session 1 finalizes, transcription pending
  h.press(RCTRL, 400);               // session 2 records + finalizes while 1 is pending
  await settle();
  eq(h.pastes(), [], 'overlap: nothing injected while session 1 is pending');
  releaseFirst('first one');
  await settle(); await settle();
  eq(h.pastes(), ['First one ', 'Second one '], 'overlap: session 1 pasted before session 2');
});

scenario('pausing mid-recording cancels and never injects', async function () {
  const h = harness();
  h.key(RCTRL, true);
  h.advance(400);
  h.settingsStore.set({ paused: true });
  h.key(RCTRL, false);
  await settle();
  eq(h.pastes(), [], 'pause: nothing pasted');
  eq(h.audio.aborted.length, 1, 'pause: audio aborted');
  h.press(RCTRL, 400);
  await settle();
  eq(h.audio.begun.length, 1, 'pause: presses while paused start nothing');
});

scenario('helper crash resets held state so the hotkey still works', async function () {
  const h = harness();
  h.key(RCTRL, true);                 // the key-up is lost in the crash
  h.helper.emit('crash', { code: 1 });
  eq(h.sm._peek().heldVk, 0, 'crash: held key cleared');
  eq(h.sm._peek().recording, null, 'crash: recording cancelled');
  h.press(RCTRL, 400);
  await settle();
  eq(h.pastes(), ['Hello world '], 'crash: next press dictates normally');
});

scenario('max utterance auto-finalizes', async function () {
  const h = harness({ settings: { maxUtteranceSec: 5 } });
  h.press(RCTRL, 100);                // latch
  h.advance(5000);
  await settle();
  eq(h.pastes(), ['Hello world '], 'max: auto-finalized and pasted');
});

scenario('silence() finalizes only a latched session', async function () {
  const h = harness();
  h.key(RCTRL, true);
  h.advance(50);
  const id = h.sm._peek().recording.id;
  h.sm.silence(id);
  eq(h.sm._peek().recording !== null, true, 'silence: ignored while key is held');
  h.key(RCTRL, false);                // < TAP_MS => latched
  h.sm.silence(id + 99);
  eq(h.sm._peek().recording !== null, true, 'silence: wrong session id ignored');
  h.sm.silence(id);
  await settle();
  eq(h.pastes(), ['Hello world '], 'silence: latched session finalized');
});

scenario('nothing heard: no paste, no history', async function () {
  const h = harness({ transcripts: ['   '] });
  h.press(RCTRL, 400);
  await settle();
  eq(h.pastes(), [], 'empty: nothing pasted');
  eq(h.history.items.length, 0, 'empty: no history');
  eq(h.overlay.indexOf('nothing-heard') !== -1, true, 'empty: overlay nothing-heard');
});

scenario('rewrite enabled: rewritten text is injected', async function () {
  const h = harness({ settings: { rewrite: { enabled: true, model: 'llama3.2' } } });
  h.press(RCTRL, 400);
  await settle(); await settle();
  eq(h.pastes(), ['HELLO WORLD '], 'rewrite: rewritten text pasted with trailing space');
  eq(h.overlay.indexOf('rewriting') !== -1, true, 'rewrite: overlay showed rewriting');
});

scenario('drop pad: copies with history opt-out, then places on drop', async function () {
  const h = harness();
  h.press(RALT, 400);
  await settle();
  eq(h.copies(), [['copy', 'Hello world ', true]], 'pad: auto-copy marked noHistory');
  eq(h.pastes(), [], 'pad: nothing pasted at the caret');
  eq(h.sm._peek().padText, 'Hello world ', 'pad: holds the text');
  h.sm.padDropAt(10, 20);
  await settle();
  eq(h.calls.filter(function (c) { return c[0] === 'placeAt'; }), [['placeAt', 'Hello world ', 10, 20]], 'pad: placed at drop point');
  eq(h.sm._peek().padText, null, 'pad: cleared after placing');
});

scenario('drop pad: setting off -> ordinary copy', async function () {
  const h = harness({ settings: { pad: { excludeFromClipboardHistory: false } } });
  h.press(RALT, 400);
  await settle();
  eq(h.copies(), [['copy', 'Hello world ', false]], 'pad off: copy not marked noHistory');
});

scenario('combo hotkeys sharing a trigger resolve by modifiers', async function () {
  const h = harness({ settings: {
    hotkey: { vk: KEY_T, name: 'Alt+T', mods: [18] },
    padHotkey: { vk: KEY_T, name: 'T', mods: [] },
  } });
  eq(h.helper.watched.indexOf(LALT) !== -1, true, 'combo: Alt variants watched');
  // Alt held + T => main binding (more specific).
  h.key(LALT, true, { held: [LALT] });
  h.press(KEY_T, 400, { held: [LALT, KEY_T] });
  h.key(LALT, false, { held: [] });
  await settle();
  eq(h.pastes(), ['Hello world '], 'combo: Alt+T pasted at caret (main binding)');
  // T alone => pad binding.
  h.press(KEY_T, 400, { held: [KEY_T] });
  await settle();
  eq(h.copies().length, 1, 'combo: bare T went to the pad');
});

scenario('pad disabled: pad key starts nothing', async function () {
  const h = harness({ settings: { pad: { enabled: false } } });
  eq(h.helper.watched.indexOf(RALT), -1, 'pad disabled: Right Alt not watched');
  h.press(RALT, 400);
  await settle();
  eq(h.audio.begun.length, 0, 'pad disabled: no session');
});

// ---------------------------------------------------------------------------

(async function main() {
  for (const s of scenarios) {
    try { await s.fn(); }
    catch (e) { failed++; console.error('FAIL (threw): ' + s.name + '\n  ' + (e && e.stack)); }
  }
  console.log('state-test: ' + passed + ' passed, ' + failed + ' failed (' + scenarios.length + ' scenarios)');
  process.exit(failed > 0 ? 1 : 0);
})();
