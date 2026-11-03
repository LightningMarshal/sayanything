'use strict';

/**
 * IPC handlers between the renderers and the main process.
 *
 * registerIpcHandlers(d) wires every ipcMain.on / ipcMain.handle the app uses.
 * All collaborators are passed in (d), so test/ipc-handlers-test.js can check
 * with a fake ipcMain that:
 *  - every channel a preload allows has exactly one handler, and nothing else
 *    is registered (the preload allowlists and handlers cannot drift apart);
 *  - renderer input is validated (catalog-only model names, integer pad
 *    coordinates, a capture that times out and disarms the helper).
 *
 * Renderer payloads are untrusted: handlers coerce and validate them.
 *
 * @param {object} d
 *   ipcMain, ipc, app, settingsStore, historyStore, helper, server, models,
 *   rewriter, audioSession, windows, state, permissions: modules (optional ones
 *   may be null). restartWhisper(model), sendToSettings(ch, payload),
 *   maybeStartAfterDownload(name): main-process actions. log: logger.
 *   isDarwin, isLinux: booleans. setTimer/clearTimer: default setTimeout/clearTimeout.
 */
function registerIpcHandlers(d) {
  const ipcMain = d.ipcMain;
  const ipc = d.ipc;
  const app = d.app;
  const settingsStore = d.settingsStore;
  const historyStore = d.historyStore;
  const helper = d.helper;
  const server = d.server;
  const models = d.models;
  const rewriter = d.rewriter;
  const audioSession = d.audioSession;
  const windows = d.windows;
  const state = d.state;
  const permissions = d.permissions;
  const restartWhisper = d.restartWhisper;
  const sendToSettings = d.sendToSettings;
  const maybeStartAfterDownload = d.maybeStartAfterDownload;
  const IS_DARWIN = !!d.isDarwin;
  const IS_LINUX = !!d.isLinux;
  const setTimer = d.setTimer || setTimeout;
  const clearTimer = d.clearTimer || clearTimeout;
  const log = d.log || {};
  function logError() { if (log.error) log.error.apply(log, arguments); }
  function logWarn() { if (log.warn) log.warn.apply(log, arguments); }


  // ---- overlay renderer -> main (audio) ----
  ipcMain.on(ipc.AUDIO_CHUNK, function (_e, p) {
    if (p && audioSession && audioSession.collect) {
      try { audioSession.collect(p.sessionId, p.buf); } catch (e) { logError('audio:chunk collect failed', e); }
    }
  });
  ipcMain.on(ipc.AUDIO_STARTED, function () { /* informational ack */ });
  ipcMain.on(ipc.AUDIO_STOPPED, function () { /* informational ack */ });
  ipcMain.on(ipc.AUDIO_ERROR, function (_e, p) {
    if (state && state.audioError) {
      try { state.audioError(p && p.message); } catch (e) { logError('audio:error handling failed', e); }
    }
  });
  ipcMain.on(ipc.AUDIO_SILENCE, function (_e, p) {
    if (state && state.silence && p && typeof p.sessionId === 'number') {
      try { state.silence(p.sessionId); } catch (e) { logError('audio:silence handling failed', e); }
    }
  });

  // ---- drop pad renderer -> main ----
  ipcMain.on(ipc.PAD_MOVE, function (_evt, p) {
    if (p && windows && windows.movePad) {
      try { windows.movePad(p.x | 0, p.y | 0); } catch (e) { /* ignore */ }
    }
  });
  ipcMain.on(ipc.PAD_PLACE, function (_evt, p) {
    if (p && state && state.padDropAt) {
      try { state.padDropAt(p.x | 0, p.y | 0); } catch (e) { logError('pad:place failed', e); }
    }
  });
  ipcMain.on(ipc.PAD_COPY, function () {
    if (state && state.padCopy) { try { state.padCopy(); } catch (e) { logError('pad:copy failed', e); } }
  });
  ipcMain.on(ipc.PAD_DISMISS, function () {
    if (state && state.padDismiss) { try { state.padDismiss(); } catch (e) { logError('pad:dismiss failed', e); } }
  });

  // ---- settings renderer invoke handlers ----
  ipcMain.handle(ipc.SETTINGS_GET, function () {
    return settingsStore && settingsStore.get ? settingsStore.get() : null;
  });

  ipcMain.handle(ipc.SETTINGS_SET, function (_e, partial) {
    if (!settingsStore || !settingsStore.set) return null;
    return settingsStore.set(partial || {});
  });

  ipcMain.handle(ipc.MODELS_LIST, function () {
    if (!models || !models.catalog) return [];
    let active = 'small.en';
    try { active = settingsStore.get().model; } catch (e) { /* default */ }
    let local = [];
    try { local = models.listLocal(); } catch (e) { local = []; }
    return models.catalog().map(function (m) {
      return {
        name: m.name,
        sizeMB: m.sizeMB,
        note: m.note || '',
        recommended: !!m.recommended,
        verified: !!m.verified,
        downloaded: local.indexOf(m.name) !== -1,
        active: m.name === active,
      };
    });
  });

  ipcMain.handle(ipc.MODELS_DOWNLOAD, function (_e, name) {
    if (!models || !models.download) throw new Error('models module unavailable');
    // Defense-in-depth: only ever act on a known catalog name. Blocks a renderer
    // (or a compromised one) from steering the download path/URL via the name
    // (e.g. '../../evil') — the name flows into a filesystem path and a fetch URL.
    if (!models.catalog().some(function (m) { return m.name === name; })) {
      throw new Error('unknown model: ' + name);
    }
    return models.download(name, function (p) {
      sendToSettings(ipc.MODELS_PROGRESS, {
        name: name,
        pct: p && p.pct,
        bytes: p && p.bytes,
        total: p && p.total,
      });
    }).then(function () {
      // Final 100% nudge + let the UI re-list.
      sendToSettings(ipc.MODELS_PROGRESS, { name: name, pct: 100, bytes: 0, total: 0 });
      // First-run recovery: if the user just downloaded the active model and the
      // engine isn't running (e.g. it was skipped at boot for lack of a model),
      // start it now so dictation works without restarting the app.
      maybeStartAfterDownload(name);
      return { ok: true };
    });
  });

  ipcMain.handle(ipc.MODELS_CANCEL, function (_e, name) {
    if (models && models.cancel) { try { models.cancel(name); } catch (e) { /* ignore */ } }
    return { ok: true };
  });

  ipcMain.handle(ipc.HISTORY_LIST, function () {
    return historyStore && historyStore.list ? historyStore.list() : [];
  });
  ipcMain.handle(ipc.HISTORY_REMOVE, function (_e, id) {
    if (historyStore && historyStore.remove) historyStore.remove(id);
    return { ok: true };
  });
  ipcMain.handle(ipc.HISTORY_CLEAR, function () {
    if (historyStore && historyStore.clear) historyStore.clear();
    return { ok: true };
  });

  ipcMain.handle(ipc.APP_INFO, function () {
    let version = '';
    try { version = app.getVersion(); } catch (e) { /* ignore */ }
    const st = (server && server.status) ? server.status() : { running: false, model: null, port: null };
    return {
      version: version,
      whisper: { running: !!st.running, model: st.model || null, port: st.port || null },
      helper: { running: !!(helper && helper.ready) },
    };
  });

  // Linux: the desktop owns the shortcuts (GlobalShortcuts portal). Settings shows
  // what it actually bound instead of offering press-to-capture.
  ipcMain.handle(ipc.HOTKEY_LINUX, function () {
    const bound = (IS_LINUX && helper && Array.isArray(helper.bound)) ? helper.bound : [];
    return {
      linux: IS_LINUX,
      bound: bound.map(function (b) {
        return { id: String(b.id), description: String(b.description || ''), triggerDescription: String(b.triggerDescription || '') };
      }),
    };
  });

  ipcMain.handle(ipc.HOTKEY_CAPTURE, function () {
    return new Promise(function (resolve, reject) {
      if (!helper || !helper.capture) { reject(new Error('helper unavailable')); return; }
      let settled = false;
      const to = setTimer(function () {
        if (settled) return;
        settled = true;
        try { helper.removeListener('captured', onCap); } catch (e) { /* ignore */ }
        // Disarm the helper so an abandoned rebind never later transmits a key.
        try { if (helper.captureCancel) helper.captureCancel(); } catch (e) { /* ignore */ }
        reject(new Error('capture timed out'));
      }, 10000);
      function onCap(info) {
        if (settled) return;
        settled = true;
        clearTimer(to);
        resolve({
          vk: info.vk,
          name: info.name || ('VK ' + info.vk),
          mods: Array.isArray(info.mods) ? info.mods : [],
        });
      }
      helper.once('captured', onCap);
      try {
        helper.capture();
      } catch (e) {
        if (!settled) {
          settled = true;
          clearTimer(to);
          try { helper.removeListener('captured', onCap); } catch (e2) { /* ignore */ }
          try { if (helper.captureCancel) helper.captureCancel(); } catch (e2) { /* ignore */ }
          reject(e);
        }
      }
    });
  });

  // Live model picker for the Rewrite settings tab. Queries the configured LOCAL
  // model server (loopback-only, enforced in rewrite.js); never throws — an
  // unreachable server returns { reachable:false } so the UI shows "not detected".
  // Accepts an optional { endpoint, api } so the UI can probe unsaved values;
  // falls back to the saved settings.
  ipcMain.handle(ipc.REWRITE_MODELS, function (_evt, opts) {
    if (!rewriter || !rewriter.listModels) {
      return { reachable: false, models: [], host: '' };
    }
    let rw = {};
    try { rw = settingsStore.get().rewrite || {}; } catch (e) { /* ignore */ }
    const endpoint = (opts && typeof opts.endpoint === 'string' && opts.endpoint) ? opts.endpoint : rw.endpoint;
    const api = (opts && opts.api) ? opts.api : rw.api;
    return rewriter.listModels({ endpoint: endpoint, api: api }).then(function (r) {
      return r || { reachable: false, models: [], host: '' };
    }, function (e) {
      logWarn('rewrite:models query failed', e);
      return { reachable: false, models: [], host: '' };
    });
  });

  ipcMain.handle(ipc.WHISPER_RESTART, function () {
    let model = null;
    try { model = settingsStore.get().model; } catch (e) { /* ignore */ }
    return restartWhisper(model).then(function () {
      return (server && server.status) ? server.status() : { running: false };
    });
  });

  // ---- welcome / permissions onboarding (macOS TCC) ----
  // On win32 these all resolve to "granted" / no-op (permissions.js reports win32),
  // so registering them unconditionally is harmless and keeps the channel set stable.
  ipcMain.handle(ipc.PERMS_GET, function () {
    if (permissions && permissions.get) return permissions.get();
    return { listen: true, ax: true, mic: true, platform: IS_DARWIN ? 'darwin' : 'win32' };
  });

  ipcMain.handle(ipc.PERMS_REQUEST, function (_e, kind) {
    if (!permissions) return { listen: true, ax: true, mic: true, platform: IS_DARWIN ? 'darwin' : 'win32' };
    try {
      if (kind === 'mic') {
        return Promise.resolve(permissions.requestMic()).then(function () { return permissions.get(); });
      }
      if (kind === 'listen') permissions.requestListen();
      else if (kind === 'ax') permissions.requestAx();
    } catch (e) {
      logWarn('perms:request failed', e);
    }
    return permissions.get();
  });

  ipcMain.handle(ipc.PERMS_OPEN_PANE, function (_e, kind) {
    if (permissions && permissions.openPane) {
      try { permissions.openPane(kind); } catch (e) { logWarn('perms:openPane failed', e); }
    }
    return { ok: true };
  });
}

module.exports = { registerIpcHandlers: registerIpcHandlers };
