'use strict';

/*
 * Electron check: every renderer page loads with its real preload under the
 * strict CSP (no 'unsafe-inline') without a single CSP violation, and the
 * overlay shows dictated text as text, never markup.
 *
 * Run: npx electron test/csp-check.js   (exits 0 pass / 1 fail)
 */

const { app, BrowserWindow } = require('electron');
const path = require('path');

app.disableHardwareAcceleration();

const ROOT = path.join(__dirname, '..', 'src');
const PAGES = ['overlay', 'pad', 'settings', 'welcome'];
let ok = true;
function check(cond, label) { console.log((cond ? '  ok  - ' : '  FAIL- ') + label); if (!cond) ok = false; }

async function load(name) {
  const win = new BrowserWindow({
    show: false, width: 800, height: 600,
    webPreferences: {
      offscreen: true, sandbox: true, contextIsolation: true, nodeIntegration: false,
      preload: path.join(ROOT, 'preload', name + '.js'),
    },
  });
  const violations = [];
  win.webContents.on('console-message', function (e) {
    const text = (e && e.message) || arguments[2] || '';
    if (/Content Security Policy|Refused to/i.test(String(text))) violations.push(String(text));
  });
  await win.loadFile(path.join(ROOT, 'renderer', name, 'index.html'));
  await new Promise(function (r) { setTimeout(r, 800); });
  return { win: win, violations: violations };
}

app.whenReady().then(async function () {
  try {
    // Load every page before destroying any: creating + loading a window right
    // after destroying another fails with ERR_FAILED on some Electron builds.
    const loaded = {};
    for (const name of PAGES) loaded[name] = await load(name);
    for (const name of PAGES) {
      const r = loaded[name];
      check(r.violations.length === 0, name + ': no CSP violations' + (r.violations.length ? ' (' + r.violations[0].slice(0, 120) + ')' : ''));
      if (name === 'overlay') {
        const res = await r.win.webContents.executeJavaScript([
          '(function(){',
          '  var o = window.__sayanythingOverlay;',
          '  o.applyState("success", { text: "<img src=x onerror=alert(1)> hi" });',
          '  var pill = document.getElementById("pill");',
          '  return { imgs: pill.querySelectorAll("img").length, text: pill.textContent };',
          '})()',
        ].join('\n'), true);
        check(res.imgs === 0, 'overlay: dictated markup is not rendered as HTML');
        check(res.text.indexOf('<img') !== -1, 'overlay: dictated text shown literally');
        await new Promise(function (r2) { setTimeout(r2, 300); });
        check(r.violations.length === 0, 'overlay: still no CSP violations after showing text');
      }
    }
    for (const name of PAGES) loaded[name].win.destroy();
  } catch (e) {
    ok = false;
    console.error('csp-check error:', e && e.message);
  }
  console.log(ok ? '\ncsp-check: PASS' : '\ncsp-check: FAIL');
  app.exit(ok ? 0 : 1);
});
