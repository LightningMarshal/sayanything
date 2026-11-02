'use strict';

/**
 * Boot-time module loading (WS-11): required vs optional.
 *
 * main.js used to load every module with a "swallow the error, return null"
 * wrapper, so a broken REQUIRED module (state machine, helper, settings...)
 * left the app sitting silently in the tray, doing nothing. Now:
 *
 *  - a REQUIRED module that fails to load is a fatal boot error: main.js shows
 *    a dialog naming the module and the log file, then exits non-zero;
 *  - an OPTIONAL module degrades gracefully (the feature is unavailable, the
 *    failure is logged).
 *
 * PURE apart from the injected require function, so test/boot-modules-test.js
 * can drive it with a fake. No dependencies of its own.
 */

/** @typedef {{key:string, id:string, required:boolean, what:string}} ModuleSpec */

/** @type {ModuleSpec[]} */
const SPEC = [
  { key: 'config', id: './config', required: true, what: 'paths and constants' },
  { key: 'log', id: './log', required: false, what: 'logging' },
  { key: 'ipc', id: './ipc', required: true, what: 'IPC channel names' },
  { key: 'settingsStore', id: './stores/settings', required: true, what: 'settings' },
  { key: 'historyStore', id: './stores/history', required: false, what: 'dictation history' },
  { key: 'helper', id: './helper', required: true, what: 'native input helper' },
  { key: 'binaries', id: './whisper/binaries', required: true, what: 'whisper binaries' },
  { key: 'server', id: './whisper/server', required: true, what: 'whisper server' },
  { key: 'models', id: './whisper/models', required: false, what: 'model downloads' },
  { key: 'rewriter', id: './whisper/rewrite', required: false, what: 'AI rewrite' },
  { key: 'audioSession', id: './audio-session', required: true, what: 'audio capture' },
  { key: 'windows', id: './windows', required: true, what: 'windows' },
  { key: 'tray', id: './tray', required: false, what: 'tray icon' },
  { key: 'state', id: './state', required: true, what: 'dictation state machine' },
  { key: 'permissions', id: './permissions', required: false, what: 'macOS permission checks' },
];

/**
 * @param {(id:string) => any} requireFn  resolves ids relative to the caller
 * @param {ModuleSpec[]} [spec]
 * @returns {{mods: Object<string, any>, failures: Array<{key:string, id:string, required:boolean, what:string, error:Error}>}}
 */
function loadModules(requireFn, spec) {
  const list = spec || SPEC;
  const mods = {};
  const failures = [];
  for (const m of list) {
    try {
      mods[m.key] = requireFn(m.id);
    } catch (err) {
      mods[m.key] = null;
      failures.push({ key: m.key, id: m.id, required: m.required, what: m.what, error: err });
    }
  }
  return { mods: mods, failures: failures };
}

/** The required-module failures only. */
function fatalFailures(failures) {
  return (failures || []).filter(function (f) { return f.required; });
}

/**
 * Human-readable text for the fatal boot dialog.
 * @param {Array<{id:string, what:string, error:Error}>} fatal
 * @param {string} [logPath]
 */
function fatalMessage(fatal, logPath) {
  const lines = ['Say Anything could not start because a required part failed to load:', ''];
  for (const f of fatal) {
    const msg = (f.error && f.error.message) ? String(f.error.message).split('\n')[0] : 'unknown error';
    lines.push('  ' + f.what + ' (' + f.id + '): ' + msg);
  }
  lines.push('');
  lines.push('Reinstalling usually fixes this.' + (logPath ? ' Details are in the log: ' + logPath : ''));
  return lines.join('\n');
}

module.exports = { SPEC: SPEC, loadModules: loadModules, fatalFailures: fatalFailures, fatalMessage: fatalMessage };
