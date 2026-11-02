'use strict';

/*
 * Electron check for the Settings window as a whole: loads the page without a
 * preload (so it runs on its built-in demo bridge), clicks through every tab,
 * exercises a few controls, and fails on ANY uncaught error or console error.
 * Guards the split of the settings scripts (core/general/hotkey/models/...).
 *
 * Run: npx electron test/settings-tabs-check.js   (exits 0 pass / 1 fail)
 */

const { app, BrowserWindow } = require('electron');
const path = require('path');

app.disableHardwareAcceleration();

let ok = true;
function check(cond, label) { console.log((cond ? '  ok  - ' : '  FAIL- ') + label); if (!cond) ok = false; }

app.whenReady().then(async function () {
  const errors = [];
  const win = new BrowserWindow({ show: false, width: 900, height: 700, webPreferences: { offscreen: true, sandbox: true, contextIsolation: true } });
  win.webContents.on('console-message', function (e) {
    const level = e && e.level;
    const text = String((e && e.message) || arguments[2] || '');
    if (level === 'error' || level === 3 || /Uncaught/.test(text)) errors.push(text);
  });
  try {
    await win.loadFile(path.join(__dirname, '..', 'src', 'renderer', 'settings', 'index.html'));
    await new Promise(function (r) { setTimeout(r, 600); });

    const res = await win.webContents.executeJavaScript([
      '(async function(){',
      '  var wait = function(ms){ return new Promise(function(r){ setTimeout(r, ms); }); };',
      '  var out = { tabs: [], ns: Object.keys(window.SayAnythingSettings || {}).length };',
      '  var tabs = document.querySelectorAll(".tab");',
      '  for (var i = 0; i < tabs.length; i++) {',
      '    tabs[i].click(); await wait(80);',
      '    var name = tabs[i].getAttribute("data-tab");',
      '    var page = document.querySelector(".page.is-active, .page:not([hidden])");',
      '    out.tabs.push([name, tabs[i].classList.contains("is-active")]);',
      '  }',
      '  out.models = document.querySelectorAll("#model-list .model-card").length;',
      '  out.history = document.querySelectorAll("#history-list > *").length;',
      '  var input = document.getElementById("dict-input");',
      '  var before = document.querySelectorAll("#dict-chips .chip").length;',
      '  input.value = "Zyxwordtest"; document.getElementById("dict-add").click(); await wait(80);',
      '  out.chipAdded = document.querySelectorAll("#dict-chips .chip").length === before + 1;',
      '  out.chipText = document.getElementById("dict-chips").textContent.indexOf("Zyxwordtest") !== -1;',
      '  return out;',
      '})()',
    ].join('\n'), true);

    check(res.ns >= 30, 'settings namespace populated (' + res.ns + ' members)');
    check(res.tabs.length === 7 && res.tabs.every(function (t) { return t[1]; }), 'every tab activates on click (' + res.tabs.map(function (t) { return t[0]; }).join(', ') + ')');
    check(res.models > 0, 'model list renders (' + res.models + ' cards)');
    check(res.history > 0, 'history list renders (' + res.history + ' rows)');
    check(res.chipAdded && res.chipText, 'dictionary: adding a word renders a chip');
    await new Promise(function (r) { setTimeout(r, 200); });
    check(errors.length === 0, 'no console errors or uncaught exceptions' + (errors.length ? ' (' + errors[0].slice(0, 160) + ')' : ''));
  } catch (e) {
    ok = false;
    console.error('settings-tabs-check error:', e && e.message);
  }
  console.log(ok ? '\nsettings-tabs-check: PASS' : '\nsettings-tabs-check: FAIL');
  app.exit(ok ? 0 : 1);
});
