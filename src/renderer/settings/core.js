'use strict';

/**
 * Shared state, IPC bridge and helpers for the Settings window.
 * Part of the Settings window (src/renderer/settings/*.js): plain scripts that
 * share window.SayAnythingSettings (S); see settings.js for load order.
 */

(function () {
  'use strict';
  /** Shared namespace for the Settings scripts (core.js loads first). */
  var S = window.SayAnythingSettings = window.SayAnythingSettings || /** @type {Record<string, any>} */ ({});

  // -------------------------------------------------------------------------
  // bridge (+ fallback for preview outside Electron)
  // -------------------------------------------------------------------------

  var api = window.sayanything || makeFallbackApi();

  var settings = null;          // latest settings snapshot
  var downloading = Object.create(null); // model name -> true while a download runs

  // -------------------------------------------------------------------------
  // small helpers
  // -------------------------------------------------------------------------

  /** @param {string} id @returns {FormField} */
  function $(id) { return /** @type {FormField} */ (document.getElementById(id)); }
  function qs(sel, root) { return (root || document).querySelector(sel); }
  function noop() {}

  function persist(partial) {
    try { api.invoke('settings:set', partial).catch(noop); } catch (e) { /* ignore */ }
  }

  var toastTimer = null;
  function toast(msg) {
    var t = $('toast');
    if (!t) return;
    t.textContent = msg;
    t.classList.add('show');
    if (toastTimer) clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { t.classList.remove('show'); }, 1700);
  }

  function copyText(text) {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(function () { toast('Copied'); }, function () { legacyCopy(text); });
    } else {
      legacyCopy(text);
    }
  }
  function legacyCopy(text) {
    try {
      var ta = document.createElement('textarea');
      ta.value = text;
      ta.setAttribute('readonly', '');
      ta.style.position = 'absolute';
      ta.style.left = '-9999px';
      document.body.appendChild(ta);
      ta.select();
      document.execCommand('copy');
      document.body.removeChild(ta);
      toast('Copied');
    } catch (e) {
      toast('Could not copy');
    }
  }

  function fmtSize(mb) {
    if (typeof mb !== 'number' || !isFinite(mb)) return '';
    if (mb >= 1024) return (mb / 1024).toFixed(1) + ' GB';
    return Math.round(mb) + ' MB';
  }

  function relTime(at) {
    var diff = Date.now() - at;
    if (diff < 0) diff = 0;
    var s = Math.floor(diff / 1000);
    if (s < 45) return 'just now';
    var m = Math.floor(s / 60);
    if (m < 60) return m + 'm ago';
    var h = Math.floor(m / 60);
    if (h < 24) return h + 'h ago';
    var d = Math.floor(h / 24);
    if (d === 1) return 'yesterday';
    if (d < 7) return d + 'd ago';
    var date = new Date(at);
    return date.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
  }

  // guard: never overwrite a control the user is actively editing
  function focused(elm) { return document.activeElement === elm; }

  function setChecked(id, val) {
    var e = $(id);
    if (e && !focused(e)) e.checked = !!val;
  }
  function setSelectValue(id, val) {
    var e = $(id);
    if (e && !focused(e)) e.value = val;
  }
  function setRange(id, outId, val, suffix) {
    var e = $(id);
    if (e && !focused(e)) e.value = val;
    var o = $(outId);
    if (o) o.textContent = val + suffix;
  }

  // -------------------------------------------------------------------------
  // fallback bridge (preview outside Electron)
  // -------------------------------------------------------------------------

  function makeFallbackApi() {
    var cur = {
      hotkey: { vk: 163, name: 'Right Ctrl' },
      padHotkey: { vk: 165, name: 'Right Alt' },
      pad: { enabled: true, excludeFromClipboardHistory: true },
      mic: { deviceId: 'default', warm: true, preRollMs: 800 },
      model: 'small.en', language: 'en',
      format: { fillerRemoval: true, voiceCommands: true, trailingSpace: true, autoCapitalize: true, artifactStrip: true },
      dictionary: ['Kubernetes', 'PostgreSQL'],
      rewrite: { enabled: false, style: 'cleanup', model: '', timeoutMs: 10000 },
      inject: { mode: 'paste', restoreClipboardMs: 300 },
      streaming: { enabled: true },
      autoStop: { enabled: true, silenceMs: 2000 },
      overlay: { chime: true, offsetY: 48 },
      history: { enabled: true, max: 200 },
      launchAtLogin: false, paused: false, whisperPort: 8737, maxUtteranceSec: 300,
    };
    function merge(base, part) {
      for (var k in part) {
        if (part[k] && typeof part[k] === 'object' && !Array.isArray(part[k])) merge(base[k] || (base[k] = {}), part[k]);
        else base[k] = part[k];
      }
      return base;
    }
    var models = [
      { name: 'tiny.en', sizeMB: 75, downloaded: true, active: false },
      { name: 'base.en', sizeMB: 142, downloaded: false, active: false },
      { name: 'small.en', sizeMB: 466, downloaded: true, active: true },
      { name: 'medium.en', sizeMB: 1500, downloaded: false, active: false },
      { name: 'large-v3-turbo', sizeMB: 1620, downloaded: false, active: false },
    ];
    var history = [
      { id: 'a', text: 'Ship the aurora overlay by Friday.', ms: 640, app: 'notepad.exe', at: Date.now() - 40000 },
      { id: 'b', text: 'Remember to buy oat milk and coffee.', ms: 720, app: 'chrome.exe', at: Date.now() - 3600000 },
    ];
    return {
      send: noop,
      on: function () { return noop; },
      invoke: function (ch, payload) {
        switch (ch) {
          case 'settings:get': return Promise.resolve(JSON.parse(JSON.stringify(cur)));
          case 'settings:set': merge(cur, payload || {}); return Promise.resolve(JSON.parse(JSON.stringify(cur)));
          case 'models:list': return Promise.resolve(models);
          case 'history:list': return Promise.resolve(history);
          case 'app:info': return Promise.resolve({ version: '0.1.0', whisper: { running: true, model: cur.model, port: 8737 }, helper: { running: true } });
          case 'hotkey:capture': return Promise.resolve({ vk: 112, name: 'F1' });
          case 'rewrite:models': return Promise.resolve({ reachable: true, models: ['llama3.2:latest', 'mistral:latest', 'qwen2.5:7b'], host: 'http://127.0.0.1:11434' });
          default: return Promise.resolve(null);
        }
      },
    };
  }
  // -------------------------------------------------------------------------
  // shared widgets (used by several tabs)
  // -------------------------------------------------------------------------

  function bindToggle(id, cb) {
    var e = $(id);
    if (e) e.addEventListener('change', function () { cb(this.checked); });
  }

  function bindRange(id, outId, suffix, cb) {
    var e = $(id);
    if (!e) return;
    e.addEventListener('input', function () {
      var o = $(outId);
      if (o) o.textContent = this.value + suffix;
    });
    e.addEventListener('change', function () { cb(parseInt(this.value, 10)); });
  }

  // Create an element with a class and text content (never markup).
  function el(tag, className, text) {
    var e = document.createElement(tag);
    if (className) e.className = className;
    if (text != null) e.textContent = text;
    return e;
  }

  function button(kind, text, onClick) {
    var b = document.createElement('button');
    b.className = 'btn ' + kind;
    b.textContent = text;
    b.addEventListener('click', onClick);
    return b;
  }


  // Shared mutable state lives on S so every tab sees the same snapshot.
  S.api = api;
  S.settings = settings;
  S.downloading = downloading;
  S.$ = $;
  S.qs = qs;
  S.noop = noop;
  S.persist = persist;
  S.toastTimer = toastTimer;
  S.toast = toast;
  S.copyText = copyText;
  S.legacyCopy = legacyCopy;
  S.fmtSize = fmtSize;
  S.relTime = relTime;
  S.focused = focused;
  S.setChecked = setChecked;
  S.setSelectValue = setSelectValue;
  S.setRange = setRange;
  S.makeFallbackApi = makeFallbackApi;
  S.bindToggle = bindToggle;
  S.bindRange = bindRange;
  S.el = el;
  S.button = button;
})();
