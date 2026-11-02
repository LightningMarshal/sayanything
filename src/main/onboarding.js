'use strict';

/**
 * First-run welcome (Windows) and permission onboarding (macOS TCC).
 *
 *  - Windows: a one-time intro window, marked seen immediately.
 *  - macOS: a permission-gated window, shown whenever Input Monitoring,
 *    Accessibility or Microphone is still missing, and closed automatically
 *    once all three are granted.
 *
 * createOnboarding(d) returns { wirePermsOnboarding, startOnboarding }.
 * @param {object} d  BrowserWindow, app, ipc, settingsStore, helper, windows,
 *   permissions, isDarwin, log, setTimer (default setTimeout)
 */

const path = require('path');

function createOnboarding(d) {
  const BrowserWindow = d.BrowserWindow;
  const app = d.app;
  const ipc = d.ipc;
  const settingsStore = d.settingsStore;
  const helper = d.helper;
  const windows = d.windows;
  const permissions = d.permissions;
  const IS_DARWIN = !!d.isDarwin;
  const setTimer = d.setTimer || setTimeout;
  const log = d.log || {};
  function logInfo() { if (log.info) log.info.apply(log, arguments); }
  function logError() { if (log.error) log.error.apply(log, arguments); }

  let onboardingWin = null;

  function showOnboarding() {
    if (onboardingWin && !onboardingWin.isDestroyed()) {
      try { onboardingWin.show(); onboardingWin.focus(); } catch (e) { /* ignore */ }
      return onboardingWin;
    }
    const rendererDir = path.join(__dirname, '..', 'renderer');
    const preloadDir = path.join(__dirname, '..', 'preload');

    onboardingWin = new BrowserWindow({
      width: 480,
      height: 620,
      show: false,
      resizable: false,
      maximizable: false,
      fullscreenable: false,
      backgroundColor: '#0B0E14',
      // Framed (unlike the frameless intro) so the OS close button is an escape
      // hatch: the "Start dictating" button is gated until every grant lands, and the
      // app keeps running in the tray if the user closes this to grant later.
      title: 'Say Anything',
      webPreferences: {
        preload: path.join(preloadDir, 'welcome.js'),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        spellcheck: false,
      },
    });

    onboardingWin.setMenu(null);

    // Lock navigation to the local file (defense-in-depth atop the page CSP).
    try {
      const wc = onboardingWin.webContents;
      wc.on('will-navigate', function (e) { e.preventDefault(); });
      wc.setWindowOpenHandler(function () { return { action: 'deny' }; });
    } catch (e) { /* older electron */ }

    onboardingWin.loadFile(path.join(rendererDir, 'welcome', 'index.html')).catch(function (err) {
      logError('onboarding window failed to load', err);
    });

    onboardingWin.once('ready-to-show', function () {
      if (onboardingWin && !onboardingWin.isDestroyed()) {
        onboardingWin.show();
        onboardingWin.focus();
      }
    });
    onboardingWin.on('closed', function () { onboardingWin = null; });

    return onboardingWin;
  }

  function closeOnboarding() {
    if (onboardingWin && !onboardingWin.isDestroyed()) {
      try { onboardingWin.close(); } catch (e) { /* ignore */ }
    }
  }

  function sendToWelcome(channel, payload) {
    try {
      if (onboardingWin && !onboardingWin.isDestroyed()) {
        onboardingWin.webContents.send(channel, payload);
      }
    } catch (e) { /* ignore */ }
  }

  function markWelcomed() {
    try { if (settingsStore && settingsStore.set) settingsStore.set({ welcomed: true }); }
    catch (e) { /* ignore */ }
  }

  // Push live grant status to the onboarding window and, once everything is granted,
  // close it. No re-watch needed: state.init() already sent the full watched set
  // (hotkey variants + pad hotkey) and the helper holds that filter internally, so
  // the event tap it creates once Input Monitoring lands uses it as-is. Watching
  // only a subset here would REPLACE the full set and silently kill the drop pad.
  // No-op on win32.
  function wirePermsOnboarding() {
    if (!IS_DARWIN || !permissions || !permissions.onChange) return;
    permissions.onChange(function (p) {
      sendToWelcome(ipc.PERMS_CHANGED, p);
      if (permissions.allGranted && permissions.allGranted()) {
        logInfo('permissions: all granted — closing onboarding');
        closeOnboarding();
      }
    });
  }

  // Decide whether to show the onboarding. On darwin this is permission-gated (shown
  // whenever a grant is missing, not just first run); on win32 it is the unchanged
  // one-time intro.
  function startOnboarding(settings) {
    if (IS_DARWIN) {
      if (!permissions) return;
      let evaluated = false;
      const evaluate = function () {
        if (evaluated) return;
        evaluated = true;
        try { if (permissions.recheckMic) permissions.recheckMic(); } catch (e) { /* ignore */ }
        if (!permissions.allGranted()) {
          showOnboarding();
        } else {
          // Everything is granted, so there is no onboarding to show — but a
          // menu-bar app that opens NO window on a manual launch looks broken
          // ("I double-clicked it and nothing happened"). Open Settings when the
          // user launched it by hand; stay silent for launch-at-login.
          try {
            const atLogin = !!(app.getLoginItemSettings && app.getLoginItemSettings().wasOpenedAtLogin);
            if (!atLogin && windows && windows.createSettings) windows.createSettings();
          } catch (e) { /* ignore */ }
        }
        // The macOS greeting IS the onboarding, so mark welcomed either way and never
        // fall back to the Windows-flavoured intro on this platform.
        markWelcomed();
      };
      // Prefer to decide after the helper reports listen/ax; fall back on a timer so a
      // missing/dead helper still lets the user grant mic and read the guidance.
      if (helper && helper.once) {
        helper.once('ready', function () {
          try { if (helper.perms) helper.perms(); } catch (e) { /* ignore */ }
          setTimer(evaluate, 250); // let the fresh perms event land first
        });
      }
      setTimer(evaluate, 2000);
      return;
    }

    // Windows: unchanged one-time intro. Marked seen immediately so a crash before
    // the user closes it doesn't re-show forever.
    try {
      if (settings && !settings.welcomed && windows && windows.showWelcome) {
        windows.showWelcome();
        markWelcomed();
      }
    } catch (e) {
      logError('first-run welcome failed', e);
    }
  }

  return { wirePermsOnboarding: wirePermsOnboarding, startOnboarding: startOnboarding };
}

module.exports = { createOnboarding: createOnboarding };
