'use strict';

/**
 * General tab: language, formatting, launch at login, microphone picker.
 * Part of the Settings window (src/renderer/settings/*.js): plain scripts that
 * share window.SayAnythingSettings (S); see settings.js for load order.
 */

(function (S) {
  'use strict';

  // -------------------------------------------------------------------------
  // General
  // -------------------------------------------------------------------------

  var LANGS = [
    ['en', 'English'], ['auto', 'Auto-detect'],
    ['es', 'Spanish'], ['fr', 'French'], ['de', 'German'], ['it', 'Italian'],
    ['pt', 'Portuguese'], ['nl', 'Dutch'], ['pl', 'Polish'], ['ru', 'Russian'],
    ['uk', 'Ukrainian'], ['zh', 'Chinese'], ['ja', 'Japanese'], ['ko', 'Korean'],
    ['hi', 'Hindi'], ['ar', 'Arabic'], ['tr', 'Turkish'], ['sv', 'Swedish'],
  ];

  function buildLanguageOptions() {
    var sel = S.$('language');
    if (!sel || sel.options.length) return;
    for (var i = 0; i < LANGS.length; i++) {
      var opt = document.createElement('option');
      opt.value = LANGS[i][0];
      opt.textContent = LANGS[i][1];
      sel.appendChild(opt);
    }
  }

  function renderGeneral() {
    if (!S.settings) return;
    S.setSelectValue('language', S.settings.language);

    S.setChecked('fmt-fillerRemoval', S.settings.format.fillerRemoval);
    S.setChecked('fmt-voiceCommands', S.settings.format.voiceCommands);
    S.setChecked('fmt-trailingSpace', S.settings.format.trailingSpace);
    S.setChecked('fmt-autoCapitalize', S.settings.format.autoCapitalize);
    S.setChecked('fmt-artifactStrip', S.settings.format.artifactStrip);

    S.setChecked('mic-warm', S.settings.mic.warm);
    S.setRange('mic-preroll', 'mic-preroll-out', S.settings.mic.preRollMs, ' ms');

    var mode = S.settings.inject.mode === 'type' ? 'type' : 'paste';
    var pasteR = S.$('inject-paste'); var typeR = S.$('inject-type');
    if (pasteR && !S.focused(pasteR)) pasteR.checked = (mode === 'paste');
    if (typeR && !S.focused(typeR)) typeR.checked = (mode === 'type');
    S.setRange('inject-restore', 'inject-restore-out', S.settings.inject.restoreClipboardMs, ' ms');

    S.setChecked('overlay-chime', S.settings.overlay.chime);
    S.setChecked('overlay-streaming', S.settings.streaming && S.settings.streaming.enabled);
    S.setRange('overlay-offset', 'overlay-offset-out', S.settings.overlay.offsetY, ' px');

    S.setChecked('launch-at-login', S.settings.launchAtLogin);
    S.setChecked('history-enabled', S.settings.history.enabled);
  }

  function wireGeneral() {
    S.$('language').addEventListener('change', function () { S.persist({ language: this.value }); });

    S.bindToggle('fmt-fillerRemoval', function (v) { S.persist({ format: { fillerRemoval: v } }); });
    S.bindToggle('fmt-voiceCommands', function (v) { S.persist({ format: { voiceCommands: v } }); });
    S.bindToggle('fmt-trailingSpace', function (v) { S.persist({ format: { trailingSpace: v } }); });
    S.bindToggle('fmt-autoCapitalize', function (v) { S.persist({ format: { autoCapitalize: v } }); });
    S.bindToggle('fmt-artifactStrip', function (v) { S.persist({ format: { artifactStrip: v } }); });

    S.bindToggle('mic-warm', function (v) { S.persist({ mic: { warm: v } }); });
    S.bindRange('mic-preroll', 'mic-preroll-out', ' ms', function (n) { S.persist({ mic: { preRollMs: n } }); });

    S.$('mic-device').addEventListener('change', function () { S.persist({ mic: { deviceId: this.value } }); });
    S.$('mic-grant').addEventListener('click', grantMic);

    var modeInputs = document.querySelectorAll('input[name="injectMode"]');
    for (var i = 0; i < modeInputs.length; i++) {
      modeInputs[i].addEventListener('change', function () {
        if (this.checked) S.persist({ inject: { mode: this.value } });
      });
    }
    S.bindRange('inject-restore', 'inject-restore-out', ' ms', function (n) { S.persist({ inject: { restoreClipboardMs: n } }); });

    S.bindToggle('overlay-chime', function (v) { S.persist({ overlay: { chime: v } }); });
    S.bindToggle('overlay-streaming', function (v) { S.persist({ streaming: { enabled: v } }); });
    S.bindRange('overlay-offset', 'overlay-offset-out', ' px', function (n) { S.persist({ overlay: { offsetY: n } }); });

    S.bindToggle('launch-at-login', function (v) { S.persist({ launchAtLogin: v }); });
    S.bindToggle('history-enabled', function (v) { S.persist({ history: { enabled: v } }); S.loadHistory(); });
  }


  // -------------------------------------------------------------------------
  // Microphone device picker
  // -------------------------------------------------------------------------

  function refreshMics() {
    if (!navigator.mediaDevices || !navigator.mediaDevices.enumerateDevices) return;
    navigator.mediaDevices.enumerateDevices().then(function (devices) {
      var sel = S.$('mic-device');
      if (!sel) return;
      var wanted = S.settings ? S.settings.mic.deviceId : 'default';
      var inputs = devices.filter(function (d) { return d.kind === 'audioinput'; });
      var missingLabels = false;

      sel.innerHTML = '';
      var def = document.createElement('option');
      def.value = 'default';
      def.textContent = 'System default';
      sel.appendChild(def);

      for (var i = 0; i < inputs.length; i++) {
        var d = inputs[i];
        if (d.deviceId === 'default' || d.deviceId === '') continue;
        var opt = document.createElement('option');
        opt.value = d.deviceId;
        if (d.label) {
          opt.textContent = d.label;
        } else {
          opt.textContent = 'Microphone ' + (i + 1);
          missingLabels = true;
        }
        sel.appendChild(opt);
      }

      // select the saved device if still present, else fall back to default
      var found = false;
      for (var j = 0; j < sel.options.length; j++) {
        if (sel.options[j].value === wanted) { found = true; break; }
      }
      sel.value = found ? wanted : 'default';

      var grantRow = S.$('mic-grant-row');
      if (grantRow) grantRow.hidden = !missingLabels;
    }).catch(function () { /* enumeration not available */ });
  }

  function grantMic() {
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      S.toast('Microphone unavailable');
      return;
    }
    navigator.mediaDevices.getUserMedia({ audio: true }).then(function (stream) {
      stream.getTracks().forEach(function (t) { t.stop(); });
      refreshMics();
    }).catch(function () {
      S.toast('Microphone access denied');
    });
  }


  S.LANGS = LANGS;
  S.buildLanguageOptions = buildLanguageOptions;
  S.renderGeneral = renderGeneral;
  S.wireGeneral = wireGeneral;
  S.refreshMics = refreshMics;
  S.grantMic = grantMic;
})(window.SayAnythingSettings);
