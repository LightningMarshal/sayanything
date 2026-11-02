'use strict';

/**
 * About tab: versions and engine / helper status.
 * Part of the Settings window (src/renderer/settings/*.js): plain scripts that
 * share window.SayAnythingSettings (S); see settings.js for load order.
 */

(function (S) {
  'use strict';

  // -------------------------------------------------------------------------
  // About / status
  // -------------------------------------------------------------------------

  function loadAbout() {
    S.api.invoke('app:info').then(function (info) {
      if (!info) return;
      var v = S.$('about-version');
      if (v && info.version) v.textContent = info.version;
      renderWhisperStatus(info.whisper || {});
      renderHelperStatus(info.helper || {});
    }).catch(S.noop);
  }

  function renderWhisperStatus(w) {
    var box = S.$('about-whisper');
    if (box) {
      var dot = S.qs('.dot', box);
      var txt = box.querySelector('span:last-child');
      if (dot) dot.className = 'dot ' + (w.running ? 'ok' : 'bad');
      if (txt) txt.textContent = w.running ? 'running' : 'stopped';
    }
    var detail = S.$('about-whisper-detail');
    if (detail) {
      detail.textContent = (w.model ? ('model ' + w.model) : '') + (w.port ? ('  ·  port ' + w.port) : '');
    }
    var rd = S.$('rail-status-dot');
    var rt = S.$('rail-status-text');
    if (rd) rd.className = 'dot ' + (w.running ? 'ok' : '');
    if (rt) rt.textContent = w.running ? 'on-device · ready' : 'on-device · private';
  }

  function renderHelperStatus(h) {
    var box = S.$('about-helper');
    if (!box) return;
    var dot = S.qs('.dot', box);
    var txt = box.querySelector('span:last-child');
    if (dot) dot.className = 'dot ' + (h.running ? 'ok' : 'bad');
    if (txt) txt.textContent = h.running ? 'running' : 'stopped';
  }

  function wireAbout() {
    var btn = S.$('about-restart');
    if (btn) btn.addEventListener('click', function () {
      btn.disabled = true;
      S.api.invoke('whisper:restart').then(function () { S.toast('Restarting engine…'); }, S.noop)
        .then(function () { setTimeout(function () { btn.disabled = false; loadAbout(); }, 800); });
    });
  }


  S.loadAbout = loadAbout;
  S.renderWhisperStatus = renderWhisperStatus;
  S.renderHelperStatus = renderHelperStatus;
  S.wireAbout = wireAbout;
})(window.SayAnythingSettings);
