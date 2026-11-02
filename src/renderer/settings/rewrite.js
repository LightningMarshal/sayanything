'use strict';

/**
 * Rewrite tab: optional local AI cleanup (loopback-only model server).
 * Part of the Settings window (src/renderer/settings/*.js): plain scripts that
 * share window.SayAnythingSettings (S); see settings.js for load order.
 */

(function (S) {
  'use strict';

  // -------------------------------------------------------------------------
  // Rewrite (local AI via Ollama)
  // -------------------------------------------------------------------------

  var ollamaModels = [];       // last-known list of the configured server's models
  var ollamaReachable = false; // last-known server reachability

  // Loopback-only validation for the endpoint field (mirrors the main-process
  // gate). Returns a normalized origin, or null when the URL isn't local.
  function normalizeLocalUrl(v) {
    if (typeof v !== 'string' || !v.trim()) return null;
    var u;
    try { u = new URL(v.trim()); } catch (e) { return null; }
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
    var h = u.hostname.toLowerCase();
    if (h.charAt(0) === '[' && h.charAt(h.length - 1) === ']') h = h.slice(1, -1);
    var loopback = (h === 'localhost' || h === '::1' || /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}S.$/.test(h));
    if (!loopback) return null;
    return u.protocol + '//' + u.host;
  }

  function renderRewrite() {
    if (!S.settings) return;
    var rw = S.settings.rewrite || {};
    S.setChecked('rewrite-enabled', rw.enabled);
    S.setSelectValue('rewrite-style', rw.style || 'cleanup');
    S.setSelectValue('rewrite-api', rw.api || 'ollama');
    var ep = S.$('rewrite-endpoint');
    if (ep && !S.focused(ep)) ep.value = rw.endpoint || 'http://127.0.0.1:11434';
    // The model <select> is populated live from the configured server; if we
    // already have the list, make sure the saved model is shown/selected.
    populateOllamaSelect();
  }

  function wireRewrite() {
    S.bindToggle('rewrite-enabled', function (v) { S.persist({ rewrite: { enabled: v } }); });

    var style = S.$('rewrite-style');
    if (style) style.addEventListener('change', function () { S.persist({ rewrite: { style: this.value } }); });

    var apiSel = S.$('rewrite-api');
    if (apiSel) apiSel.addEventListener('change', function () {
      S.persist({ rewrite: { api: this.value } });
      loadOllamaModels(true);
    });

    var ep = S.$('rewrite-endpoint');
    if (ep) ep.addEventListener('change', function () {
      var norm = normalizeLocalUrl(this.value);
      if (!norm) {
        S.toast('Only a local address is allowed (localhost / 127.0.0.1)');
        this.value = (S.settings && S.settings.rewrite && S.settings.rewrite.endpoint) || 'http://127.0.0.1:11434';
        return;
      }
      this.value = norm;
      S.persist({ rewrite: { endpoint: norm } });
      loadOllamaModels(true);
    });

    var model = S.$('rewrite-model');
    if (model) model.addEventListener('change', function () {
      if (this.value) S.persist({ rewrite: { model: this.value } });
    });

    var refresh = S.$('rewrite-refresh');
    if (refresh) refresh.addEventListener('click', function () { loadOllamaModels(true); });
  }

  function setRewriteStatus(text, kind) {
    var statusEl = S.$('rewrite-status');
    if (!statusEl) return;
    statusEl.textContent = text;
    statusEl.classList.remove('rewrite-warn', 'rewrite-ok');
    if (kind) statusEl.classList.add(kind);
  }

  function loadOllamaModels(userInitiated) {
    var serverApi = (S.$('rewrite-api') && S.$('rewrite-api').value) ||
      (S.settings && S.settings.rewrite && S.settings.rewrite.api) || 'ollama';
    var endpoint = (S.$('rewrite-endpoint') && S.$('rewrite-endpoint').value) ||
      (S.settings && S.settings.rewrite && S.settings.rewrite.endpoint) || '';
    setRewriteStatus('Checking ' + (serverApi === 'openai' ? 'the server' : 'Ollama') + '…', null);
    S.api.invoke('rewrite:models', { endpoint: endpoint, api: serverApi }).then(function (res) {
      res = res || {};
      ollamaReachable = !!res.reachable;
      ollamaModels = Array.isArray(res.models) ? res.models : [];
      populateOllamaSelect();
      if (!ollamaReachable) {
        if (serverApi === 'openai') {
          setRewriteStatus('No server reachable there. Start your local model server, then hit Refresh.', 'rewrite-warn');
        } else {
          setRewriteStatus('Ollama not detected — install from ollama.com, it’s free and local.', 'rewrite-warn');
        }
      } else if (!ollamaModels.length) {
        setRewriteStatus('Server is running but has no models loaded.', 'rewrite-warn');
      } else {
        setRewriteStatus(ollamaModels.length + ' model' + (ollamaModels.length === 1 ? '' : 's') + ' available on this machine.', 'rewrite-ok');
      }
    }).catch(function () {
      ollamaReachable = false;
      ollamaModels = [];
      populateOllamaSelect();
      setRewriteStatus('Could not reach the model server. Check the address and try Refresh.', 'rewrite-warn');
    });
  }

  function populateOllamaSelect() {
    var sel = S.$('rewrite-model');
    if (!sel || S.focused(sel)) return;
    var saved = (S.settings && S.settings.rewrite && S.settings.rewrite.model) || '';
    sel.innerHTML = '';

    if (!ollamaModels.length) {
      var opt = document.createElement('option');
      opt.value = saved || '';
      opt.textContent = saved ? (saved + ' (not installed)') : 'No models found';
      sel.appendChild(opt);
      sel.value = opt.value;
      return;
    }

    var hasSaved = saved && ollamaModels.indexOf(saved) !== -1;
    if (saved && !hasSaved) {
      // Keep the saved-but-missing model visible so the user isn't silently switched.
      var miss = document.createElement('option');
      miss.value = saved;
      miss.textContent = saved + ' (not installed)';
      sel.appendChild(miss);
    }
    for (var i = 0; i < ollamaModels.length; i++) {
      var o = document.createElement('option');
      o.value = ollamaModels[i];
      o.textContent = ollamaModels[i];
      sel.appendChild(o);
    }
    sel.value = saved || ollamaModels[0];
  }


  S.ollamaModels = ollamaModels;
  S.ollamaReachable = ollamaReachable;
  S.normalizeLocalUrl = normalizeLocalUrl;
  S.renderRewrite = renderRewrite;
  S.wireRewrite = wireRewrite;
  S.setRewriteStatus = setRewriteStatus;
  S.loadOllamaModels = loadOllamaModels;
  S.populateOllamaSelect = populateOllamaSelect;
})(window.SayAnythingSettings);
