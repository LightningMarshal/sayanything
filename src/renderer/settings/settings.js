'use strict';

/**
 * Settings window entry point: tabs, snapshot, init. Loads last.
 * Part of the Settings window (src/renderer/settings/*.js): plain scripts that
 * share window.SayAnythingSettings (S); see settings.js for load order.
 */

(function (S) {
  'use strict';

  // -------------------------------------------------------------------------
  // tabs
  // -------------------------------------------------------------------------

  function initTabs() {
    var tabs = document.querySelectorAll('.tab');
    for (var i = 0; i < tabs.length; i++) {
      (function (tab) {
        tab.addEventListener('click', function () { activateTab(tab.getAttribute('data-tab')); });
      })(tabs[i]);
    }
  }

  function activateTab(name) {
    var tabs = document.querySelectorAll('.tab');
    for (var i = 0; i < tabs.length; i++) {
      tabs[i].classList.toggle('is-active', tabs[i].getAttribute('data-tab') === name);
    }
    var pages = document.querySelectorAll('.page');
    for (var j = 0; j < pages.length; j++) {
      pages[j].classList.toggle('is-active', pages[j].id === 'tab-' + name);
    }
    // refresh live data for the section being shown
    if (name === 'model') S.loadModels();
    else if (name === 'history') S.loadHistory();
    else if (name === 'about') S.loadAbout();
    else if (name === 'general') S.refreshMics();
    else if (name === 'rewrite') S.loadOllamaModels();
  }

  // -------------------------------------------------------------------------
  // init
  // -------------------------------------------------------------------------

  function applySnapshot(s) {
    if (!s) return;
    S.settings = s;
    S.renderGeneral();
    S.renderHotkey();
    S.renderDictionary();
    S.renderRewrite();
  }

  function init() {
    S.buildLanguageOptions();
    initTabs();
    S.wireGeneral();
    S.wireHotkey();
    S.wireDictionary();
    S.wireRewrite();
    S.wireHistoryControls();
    S.wireAbout();

    S.api.invoke('settings:get').then(function (s) {
      applySnapshot(s);
      S.refreshMics();
      S.loadModels();
    }).catch(function () {
      // still render an empty shell
    });

    // live events from main
    S.api.on('settings:changed', function (p) { if (p && p.settings) applySnapshot(p.settings); });
    S.api.on('whisper:status', function (s) { if (s) S.renderWhisperStatus(s); });
    S.api.on('models:progress', function (p) { S.onModelProgress(p); });

    if (navigator.mediaDevices) {
      try { navigator.mediaDevices.addEventListener('devicechange', S.refreshMics); } catch (e) { /* older */ }
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }


})(window.SayAnythingSettings);
