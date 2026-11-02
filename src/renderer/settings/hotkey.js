'use strict';

/**
 * Hotkey tab: dictation and drop-pad hotkeys (press-to-capture), drop-pad options.
 * Part of the Settings window (src/renderer/settings/*.js): plain scripts that
 * share window.SayAnythingSettings (S); see settings.js for load order.
 */

(function (S) {
  'use strict';

  // -------------------------------------------------------------------------
  // Hotkey
  // -------------------------------------------------------------------------

  function renderHotkey() {
    if (!S.settings) return;
    // Fallbacks only apply if a stored name is blank; keep them platform-correct.
    var name = S.$('hotkey-name');
    if (name) name.textContent = S.settings.hotkey.name || (IS_MAC ? 'Right Cmd' : 'Right Ctrl');

    var padName = S.$('padhotkey-name');
    if (padName) padName.textContent = (S.settings.padHotkey && S.settings.padHotkey.name) || (IS_MAC ? 'Right Option' : 'Right Alt');
    S.setChecked('pad-enabled', S.settings.pad && S.settings.pad.enabled);
    S.setChecked('pad-nohistory', !(S.settings.pad && S.settings.pad.excludeFromClipboardHistory === false));

    var a = S.settings.autoStop || {};
    S.setChecked('autostop-enabled', a.enabled);
    var ms = (typeof a.silenceMs === 'number') ? a.silenceMs : 2000;
    var sil = S.$('autostop-silence');
    if (sil && !S.focused(sil)) sil.value = ms;
    var out = S.$('autostop-silence-out');
    if (out) out.textContent = (ms / 1000).toFixed(1) + ' s';
  }

  // Combo hotkeys (issue #1): the capture result carries the trigger vk/name plus
  // any held modifier VKs. Normalize L/R modifiers to a generic one (so "Alt + T"
  // fires on either Alt) and build a display label. Returns { vk, name, mods }.
  // The trigger name comes from the helper (already platform-correct, e.g. "Right
  // Cmd"), but modifier labels are composed here, so mac says Option/Cmd not Alt/Win.
  var IS_MAC = /^Mac/.test(navigator.platform || '');
  var MOD_NORMALIZE = { 16: 16, 160: 16, 161: 16, 17: 17, 162: 17, 163: 17, 18: 18, 164: 18, 165: 18, 91: 91, 92: 91 };
  var MOD_LABEL = IS_MAC
    ? { 16: 'Shift', 17: 'Ctrl', 18: 'Option', 91: 'Cmd' }
    : { 16: 'Shift', 17: 'Ctrl', 18: 'Alt', 91: 'Win' };
  var MOD_ORDER = [17, 18, 16, 91]; // Ctrl, Alt/Option, Shift, Win/Cmd

  function composeHotkey(res) {
    var vk = res.vk;
    var triggerName = res.name || ('VK ' + vk);
    var mods = [];
    var seen = {};
    var raw = (res && res.mods) || [];
    for (var i = 0; i < raw.length; i++) {
      var g = MOD_NORMALIZE[raw[i]];
      if (g == null) g = raw[i];
      if (g === vk || seen[g]) continue;
      seen[g] = true;
      mods.push(g);
    }
    mods.sort(function (a, b) {
      var ia = MOD_ORDER.indexOf(a); if (ia < 0) ia = 99;
      var ib = MOD_ORDER.indexOf(b); if (ib < 0) ib = 99;
      return ia - ib;
    });
    var parts = [];
    for (var j = 0; j < mods.length; j++) parts.push(MOD_LABEL[mods[j]] || ('VK ' + mods[j]));
    parts.push(triggerName);
    return { vk: vk, name: parts.join(' + '), mods: mods };
  }

  // Shared press-to-capture flow for a hotkey button. `apply(res)` persists it.
  function wireCapture(btnId, statusId, prompt, apply) {
    var btn = S.$(btnId);
    if (!btn) return;
    btn.addEventListener('click', function () {
      var card = btn.closest('.card');
      var status = S.$(statusId);
      btn.disabled = true;
      if (card) card.classList.add('capturing');
      if (status) status.textContent = prompt;
      S.api.invoke('hotkey:capture').then(function (res) {
        if (res && typeof res.vk === 'number') { apply(res); }
        else { S.toast('No key captured'); }
      }).catch(function () {
        S.toast('Change cancelled');
      }).then(function () {
        btn.disabled = false;
        if (card) card.classList.remove('capturing');
        if (status) status.innerHTML = '&nbsp;';
      });
    });
  }

  function wireHotkey() {
    S.bindToggle('autostop-enabled', function (v) { S.persist({ autoStop: { enabled: v } }); });
    S.bindToggle('pad-enabled', function (v) { S.persist({ pad: { enabled: v } }); });
    S.bindToggle('pad-nohistory', function (v) { S.persist({ pad: { excludeFromClipboardHistory: v } }); });

    wireCapture('padhotkey-capture', 'padhotkey-status', 'Press a key or combo for the drop pad…', function (res) {
      var hk = composeHotkey(res);
      S.persist({ padHotkey: hk });
      var nm = S.$('padhotkey-name');
      if (nm) nm.textContent = hk.name;
      S.toast('Drop pad key set to ' + hk.name);
    });
    var sil = S.$('autostop-silence');
    if (sil) {
      sil.addEventListener('input', function () {
        var o = S.$('autostop-silence-out');
        if (o) o.textContent = (parseInt(this.value, 10) / 1000).toFixed(1) + ' s';
      });
      sil.addEventListener('change', function () { S.persist({ autoStop: { silenceMs: parseInt(this.value, 10) } }); });
    }

    var btn = S.$('hotkey-capture');
    if (!btn) return;
    btn.addEventListener('click', function () {
      var card = btn.closest('.card');
      var status = S.$('hotkey-status');
      btn.disabled = true;
      if (card) card.classList.add('capturing');
      if (status) status.textContent = 'Press a key or combo, e.g. Alt+T…';
      S.api.invoke('hotkey:capture').then(function (res) {
        if (res && typeof res.vk === 'number') {
          var hk = composeHotkey(res);
          S.persist({ hotkey: hk });
          var nm = S.$('hotkey-name');
          if (nm) nm.textContent = hk.name;
          S.toast('Hotkey set to ' + hk.name);
        } else {
          S.toast('No key captured');
        }
      }).catch(function () {
        S.toast('Hotkey change cancelled');
      }).then(function () {
        btn.disabled = false;
        if (card) card.classList.remove('capturing');
        if (status) status.innerHTML = '&nbsp;';
      });
    });
  }


  S.renderHotkey = renderHotkey;
  S.IS_MAC = IS_MAC;
  S.MOD_NORMALIZE = MOD_NORMALIZE;
  S.MOD_LABEL = MOD_LABEL;
  S.MOD_ORDER = MOD_ORDER;
  S.composeHotkey = composeHotkey;
  S.wireCapture = wireCapture;
  S.wireHotkey = wireHotkey;
})(window.SayAnythingSettings);
