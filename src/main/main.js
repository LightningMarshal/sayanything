'use strict';

/**
 * SayAnything main process entry.
 *
 * Responsibilities:
 *  - single-instance lock
 *  - `--smoke` headless self-test (NO windows) that runs before any window is
 *    created and exits with a status code
 *  - boot order: settings -> log -> (helper.start() + binaries.ensure() +
 *    server.start(), in parallel, tolerating whisper failure) -> createOverlay ->
 *    tray -> watch(hotkey) -> wire the dictation state machine
 *  - all ipcMain handlers for the settings renderer + audio channel routing
 *  - settings.onChange side effects: hotkey rewatch (state.js), model -> server
 *    restart, launch-at-login sync, and forwarding settings:changed to the UI
 *  - graceful shutdown of the native children
 *
 * Boot never crashes: every module is required defensively and every side effect
 * is guarded, per SPEC's resilience rules.
 */

const fs = require('fs');
const { app, BrowserWindow, ipcMain, session, Notification, dialog } = require('electron');

// Set the app name before anything reads a user path, so Electron's own caches
// live under %APPDATA%/SayAnything alongside our data (config.js anchors there too).
try { app.setName('SayAnything'); } catch (e) { /* best-effort */ }

// Required modules failing to load is fatal (dialog + exit, see failBoot);
// optional ones degrade gracefully. See boot-modules.js (WS-11).
const bootModules = require('./boot-modules');
const ipcHandlers = require('./ipc-handlers');
const loaded = bootModules.loadModules(function (id) { return require(id); });
const bootFatal = bootModules.fatalFailures(loaded.failures);

const config = loaded.mods.config;
const log = loaded.mods.log || { debug: noop, info: noop, warn: noop, error: noop };
const ipc = loaded.mods.ipc;
const settingsStore = loaded.mods.settingsStore;
const historyStore = loaded.mods.historyStore;
const helper = loaded.mods.helper;
const binaries = loaded.mods.binaries;
const server = loaded.mods.server;
const models = loaded.mods.models;
const rewriter = loaded.mods.rewriter;
const audioSession = loaded.mods.audioSession;
const windows = loaded.mods.windows;
const tray = loaded.mods.tray;
const state = loaded.mods.state;
const permissions = loaded.mods.permissions;

for (const f of loaded.failures) {
  try { log.error('boot: failed to load ' + (f.required ? 'REQUIRED' : 'optional') + ' module ' + f.id, f.error); }
  catch (e) { /* logging itself is unavailable */ }
}

// A required module is missing: tell the user plainly and quit, instead of
// sitting in the tray doing nothing.
function failBoot(reason) {
  let logPath = '';
  try { logPath = require('path').join(config.LOGS_DIR, 'SayAnything.log'); } catch (e) { /* config missing */ }
  const msg = reason || bootModules.fatalMessage(bootFatal, logPath);
  try { log.error('boot: fatal — ' + msg.replace(/\n+/g, ' | ')); } catch (e) { /* ignore */ }
  try { dialog.showErrorBox('Say Anything could not start', msg); } catch (e) { /* headless */ }
  app.exit(1);
}

const IS_DARWIN = process.platform === 'darwin';

function noop() {}
function logInfo() { if (log && log.info) log.info.apply(log, arguments); }
function logError() { if (log && log.error) log.error.apply(log, arguments); }
function logWarn() { if (log && log.warn) log.warn.apply(log, arguments); }

const isSmoke = process.argv.includes('--smoke');

/** Call a possibly-missing function; swallow sync throws and rejected promises. */
function safeCall(fn, label) {
  try {
    const r = fn();
    if (r && typeof r.catch === 'function') {
      r.catch(function (err) { logError(label + ' failed', err); });
    }
    return r;
  } catch (err) {
    logError(label + ' threw', err);
    return null;
  }
}

// ---------------------------------------------------------------------------
// single-instance lock
// ---------------------------------------------------------------------------

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', function () {
    try {
      if (windows && windows.createSettings) {
        windows.createSettings(); // focuses the existing settings window
      }
    } catch (e) { /* ignore */ }
  });

  if (isSmoke) {
    app.whenReady().then(function () {
      if (bootFatal.length) {
        process.stdout.write(JSON.stringify({ summary: true, ok: false,
          error: 'required modules failed to load: ' + bootFatal.map(function (f) { return f.id; }).join(', ') }) + '\n');
        app.exit(1);
        return;
      }
      return runSmoke();
    }).catch(function (err) {
      try { process.stdout.write(JSON.stringify({ summary: true, ok: false, error: String(err) }) + '\n'); } catch (e) { /* ignore */ }
      app.exit(1);
    });
  } else {
    app.whenReady().then(function () {
      if (bootFatal.length) return failBoot();
      return boot();
    }).catch(function (err) {
      logError('boot failed', err);
      failBoot('Say Anything hit an unexpected error while starting:\n\n  ' +
        ((err && err.message) || String(err)) + '\n\nDetails are in the log.');
    });
    app.on('window-all-closed', function () { /* keep running in the tray */ });
    app.on('will-quit', shutdown);
  }
}

// ---------------------------------------------------------------------------
// --smoke: headless self-test (no windows)
// ---------------------------------------------------------------------------

function runSmoke() {
  return require('./smoke').runSmoke({
    app: app, fs: fs, config: config, settingsStore: settingsStore, helper: helper,
    binaries: binaries, server: server, models: models,
  });
}
// ---------------------------------------------------------------------------
// normal boot
// ---------------------------------------------------------------------------

let lastModel = null;
let lastLaunchAtLogin = null;
let setupNotice = false; // set once we've told the user to run setup (dedupes notices)

function boot() {
  logInfo('SayAnything boot: starting');

  let settings = null;
  try {
    settings = (settingsStore && settingsStore.get) ? settingsStore.get() : null;
  } catch (e) {
    logError('settings load failed', e);
  }
  lastModel = settings ? settings.model : null;
  lastLaunchAtLogin = settings ? !!settings.launchAtLogin : null;

  // Sync launch-at-login with the persisted preference (best-effort).
  applyLoginItem(settings ? !!settings.launchAtLogin : false);

  // Grant microphone access to our own trusted renderers (both windows use the
  // default session). Without this Electron denies getUserMedia and the mic /
  // device-label picker fail. Everything else is denied (privacy-first).
  wirePermissions();

  // Subscribe to whisper status BEFORE starting so no early status is missed.
  if (server && server.on) {
    server.on('status', function (st) {
      forwardWhisperStatus(st);
    });
  }

  // Native pieces in parallel; whisper failure is non-fatal (SPEC resilience).
  // Helper start failure is normally non-fatal too, but if the app is otherwise
  // set up (so no setup dialog will fire) a dead dictation hotkey must not be
  // silent — tell the user how to recover.
  Promise.resolve()
    .then(function () { return helper && helper.start && helper.start(); })
    .catch(function (err) {
      logError('helper.start failed', err);
      if (!setupNotice) {
        // The Linux portal adapter explains itself (no portal, request declined).
        notify('Say Anything: hotkey unavailable', (err && err.userMessage) ||
          'The dictation hotkey may not work. Try running:  node scripts/setup.js');
      }
    });

  // If the helper gives up after its rapid-retry cap, the hotkey is dead — tell
  // the user via a tray notification + overlay error instead of failing silently.
  if (helper && helper.on) {
    helper.on('unavailable', function (info) {
      logError('helper unavailable after ' + (info && info.restarts) + ' restarts — hotkey is dead');
      notify('Say Anything: dictation stopped', 'The hotkey stopped responding. Restart Say Anything to get dictation back.');
      try {
        const wc = windows && windows.getOverlayWC && windows.getOverlayWC();
        if (wc && ipc) {
          windows.showOverlay && windows.showOverlay();
          wc.send(ipc.OVERLAY_STATE, { state: 'error', detail: { message: 'Dictation stopped. Restart Say Anything to fix it.' } });
        }
      } catch (e) { /* ignore */ }
    });
  }

  // Set the initial watched hotkey now; helper re-asserts it once ready.
  try {
    const vk = settings && settings.hotkey && settings.hotkey.vk;
    if (helper && helper.watch && typeof vk === 'number') helper.watch([vk]);
  } catch (e) {
    logError('initial watch failed', e);
  }

  // Windows + tray first, so the first-run guidance below has a tray to fall back
  // on and can open the settings window when a model still needs downloading.
  safeCall(function () { return windows && windows.createOverlay && windows.createOverlay(); }, 'createOverlay');
  // Pre-create the drop pad (hidden) so it's loaded and ready on first use.
  safeCall(function () { return windows && windows.createPad && windows.createPad(); }, 'createPad');
  safeCall(function () { return tray && tray.create && tray.create(); }, 'tray.create');

  // Whisper engine — but ONLY if `node scripts/setup.js` has actually run. A
  // fresh clone has no binaries and no model; guide the user to setup instead of
  // sitting silently in the tray or pulling large files off the internet at boot.
  bootWhisper(settings);

  // IPC + settings side-effects + the dictation state machine.
  wireIpc();
  wireSettingsSideEffects();
  safeCall(function () { return state && state.init && state.init(); }, 'state.init');

  // First-run welcome / macOS permissions onboarding.
  //  - Windows: the one-time intro (unchanged).
  //  - macOS: a permission-gated onboarding — shown whenever a TCC grant is still
  //    missing (not just first run), because dictation literally cannot work
  //    without Input Monitoring + Accessibility + Microphone. It auto-closes the
  //    moment all three grants land (see wirePermsOnboarding).
  try {
    wirePermsOnboarding();
    startOnboarding(settings);
  } catch (e) {
    logError('onboarding wiring failed', e);
  }

  logInfo('SayAnything boot: ready');
}

function shutdown() {
  safeCall(function () { return helper && helper.stop && helper.stop(); }, 'helper.stop');
  safeCall(function () { return server && server.stop && server.stop(); }, 'server.stop');
  safeCall(function () { return tray && tray.destroy && tray.destroy(); }, 'tray.destroy');
}

// ---------------------------------------------------------------------------
// first-run readiness + whisper start
// ---------------------------------------------------------------------------

function whisperBinariesReady() {
  try { return !!(binaries && binaries.isReady && binaries.isReady()); }
  catch (e) { return false; }
}

function localModelNames() {
  try { return (models && models.listLocal) ? models.listLocal() : []; }
  catch (e) { return []; }
}

/**
 * Start whisper if setup has run; otherwise guide the user. Three states:
 *   - no binaries         -> setup was never run: clear dialog + notification
 *   - binaries, no model  -> setup interrupted: open the model manager
 *   - binaries + model     -> start the server (no runtime download needed)
 */
function bootWhisper(settings) {
  const binOk = whisperBinariesReady();
  const selected = (settings && settings.model) || 'small.en';
  const local = localModelNames();
  const modelReady = local.indexOf(selected) !== -1;

  if (!binOk) {
    logWarn('first run: whisper binaries missing — setup has not been run');
    guideRunSetup();
    return;
  }
  if (!modelReady) {
    logWarn('first run: model "' + selected + '" not downloaded — opening the model manager');
    guideDownloadModel(local.length > 0);
    return;
  }

  const port = (settings && settings.whisperPort) || (config && config.DEFAULT_PORT) || 8737;
  Promise.resolve()
    .then(function () { return server && server.start && server.start(selected, port); })
    .then(function () { logInfo('SayAnything boot: whisper server ready'); })
    .catch(function (err) { logError('whisper start failed (non-fatal)', err); });
}

/** Setup was never run: a plain-language dialog + notification pointing at setup.js. */
function guideRunSetup() {
  if (setupNotice) return;
  setupNotice = true;
  const msg =
    'Say Anything needs a one-time setup before it can transcribe.\n\n' +
    'Open a terminal in the Say Anything folder and run:\n\n' +
    '    node scripts/setup.js\n\n' +
    'That downloads the local speech engine and the default model (a few minutes,\n' +
    'just once). Then start Say Anything again with:  npm start\n\n' +
    'Say Anything sits in the tray meanwhile. Nothing runs until setup finishes.';
  // Non-blocking: showErrorBox is modal and synchronous, which left boot paused
  // (no IPC handlers, no state machine) until the user closed the dialog.
  try {
    if (dialog && dialog.showMessageBox) {
      dialog.showMessageBox({ type: 'info', title: 'Say Anything needs a quick setup',
        message: 'Say Anything needs a quick setup', detail: msg, buttons: ['OK'] })
        .catch(function (e) { logError('setup dialog failed', e); });
    }
  } catch (e) { logError('setup dialog failed', e); }
  notify('Say Anything needs a quick setup',
    'Run  node scripts/setup.js  in the Say Anything folder, then restart Say Anything.');
}

/** Binaries are present but no usable model: land the user on the model manager. */
function guideDownloadModel(haveOtherModel) {
  if (setupNotice) return;
  setupNotice = true;
  safeCall(function () { return windows && windows.createSettings && windows.createSettings(); }, 'createSettings');
  const body = haveOtherModel
    ? 'Your selected model isn’t downloaded yet. Open Settings, then Models to get it or pick another.'
    : 'No speech model yet. Open Settings, then Models to download one and you’re good to go.';
  notify('Say Anything needs a voice model', body);
}

// ---------------------------------------------------------------------------
// welcome / macOS permissions onboarding
// ---------------------------------------------------------------------------
//
// On darwin the welcome window doubles as the TCC onboarding (three grants). It is
// created HERE (not via windows.js) so it can carry the welcome preload that
// bridges the perms:* channels — windows.showWelcome() ships no preload and is
// owned by windows.js. The renderer branches on the preload's platform flag, so
// the same welcome/index.html serves both the Windows intro and the macOS
// onboarding. windows.js owns the window lifecycle.

// First-run welcome / macOS permission onboarding: see onboarding.js.
let onboarding = null;
function getOnboarding() {
  if (!onboarding) {
    onboarding = require('./onboarding').createOnboarding({
      BrowserWindow: BrowserWindow, app: app, ipc: ipc, settingsStore: settingsStore,
      helper: helper, windows: windows, permissions: permissions, isDarwin: IS_DARWIN, isLinux: process.platform === 'linux', log: log,
    });
  }
  return onboarding;
}
function wirePermsOnboarding() { getOnboarding().wirePermsOnboarding(); }
function startOnboarding(settings) { getOnboarding().startOnboarding(settings); }

// ---------------------------------------------------------------------------
// login item
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// renderer permissions (mic only; deny everything else)
// ---------------------------------------------------------------------------

// Renderers may use the microphone and nothing else (no camera, no
// notifications, no geolocation...): see media-permissions.js.
function wirePermissions() {
  try {
    require('./media-permissions').install(session && session.defaultSession);
  } catch (e) {
    logWarn('wirePermissions failed', e);
  }
}

function applyLoginItem(enabled) {
  try {
    app.setLoginItemSettings({
      openAtLogin: !!enabled,
      path: process.execPath,
      args: [app.getAppPath()],
    });
  } catch (e) {
    logWarn('applyLoginItem failed', e);
  }
}

// ---------------------------------------------------------------------------
// settings renderer helpers
// ---------------------------------------------------------------------------

function sendToSettings(channel, payload) {
  try {
    const wc = windows && windows.getSettingsWC && windows.getSettingsWC();
    if (wc) wc.send(channel, payload);
  } catch (e) { /* ignore */ }
}

function notify(title, body) {
  try {
    if (Notification && Notification.isSupported && Notification.isSupported()) {
      new Notification({ title: title, body: body }).show();
    }
  } catch (e) { /* best-effort */ }
}

// After a model download completes, start whisper if the downloaded model is the
// active one and the server isn't already up (binaries must be present, else the
// launch fails non-fatally and the user is already looking at the setup guidance).
function maybeStartAfterDownload(name) {
  let selected = null;
  try { selected = settingsStore.get().model; } catch (e) { /* ignore */ }
  if (name !== selected) return;
  const st = (server && server.status) ? server.status() : { running: false };
  if (st.running) return;
  if (!whisperBinariesReady()) return;
  logInfo('active model downloaded + engine idle -> starting whisper (' + selected + ')');
  restartWhisper(selected);
}

function forwardWhisperStatus(st) {
  const s = st || (server && server.status ? server.status() : { running: false, model: null, port: null });
  sendToSettings(ipc.WHISPER_STATUS, { running: !!s.running, model: s.model || null, port: s.port || null });
}

// Serialize whisper restarts so a model change + explicit restart cannot race.
// The settings UI both persists the new model (=> onChange restart) AND calls
// whisper:restart, so coalesce: if a restart to the SAME model is already in
// flight, reuse it instead of reloading the model a second time.
let whisperChain = Promise.resolve();
let whisperBusy = false;
let whisperPendingModel;
function restartWhisper(model) {
  if (whisperBusy && whisperPendingModel === model) return whisperChain;
  whisperBusy = true;
  whisperPendingModel = model;
  whisperChain = whisperChain.then(function () {
    if (!server || !server.restart) return null;
    return server.restart(model).then(null, function (e) {
      logError('whisper restart failed (non-fatal)', e);
    });
  }).then(function (r) { whisperBusy = false; return r; },
          function (e) { whisperBusy = false; throw e; });
  return whisperChain;
}

// ---------------------------------------------------------------------------
// settings.onChange side effects
// ---------------------------------------------------------------------------

function wireSettingsSideEffects() {
  if (!settingsStore || !settingsStore.onChange) return;
  settingsStore.onChange(function (s) {
    // Forward to the settings UI so open panels stay in sync.
    sendToSettings(ipc.SETTINGS_CHANGED, { settings: s });

    // Model change -> restart whisper with the new model.
    if (s.model !== lastModel) {
      lastModel = s.model;
      logInfo('settings: model changed -> restarting whisper (' + s.model + ')');
      restartWhisper(s.model);
    }

    // Launch-at-login change -> sync the OS login item.
    const launch = !!s.launchAtLogin;
    if (launch !== lastLaunchAtLogin) {
      lastLaunchAtLogin = launch;
      applyLoginItem(launch);
    }
    // Hotkey rewatch + paused are handled inside state.js (its own onChange).
  });
}

// ---------------------------------------------------------------------------
// IPC handlers
// ---------------------------------------------------------------------------

function wireIpc() {
  if (!ipc) return;
  ipcHandlers.registerIpcHandlers({
    ipcMain: ipcMain, ipc: ipc, app: app, log: log, isDarwin: IS_DARWIN,
    settingsStore: settingsStore, historyStore: historyStore, helper: helper, server: server,
    models: models, rewriter: rewriter, audioSession: audioSession, windows: windows,
    state: state, permissions: permissions,
    restartWhisper: restartWhisper, sendToSettings: sendToSettings,
    maybeStartAfterDownload: maybeStartAfterDownload,
  });
}
// ---------------------------------------------------------------------------
// exported for potential tooling / tests (harmless in production)
// ---------------------------------------------------------------------------

module.exports = { boot: boot, runSmoke: runSmoke };
