'use strict';

/**
 * Say Anything: README demo GIF (docs tooling, dependency-free).
 *
 * Renders assets/demo.gif: talk, watch the words stream into the pill, catch
 * them in the drop pad, drag the pad onto a text box. The pill and the pad are
 * the REAL renderer pages (src/renderer/overlay, src/renderer/pad) in iframes,
 * driven through their built-in debug hooks (window.__sayanythingOverlay,
 * window.__sayanythingPad), so the GIF always shows the current components.
 * The note.txt window, cursor and captions are props of the scene.
 *
 *     xvfb-run -a npx electron scripts/capture-demo.js --no-sandbox   # Linux CI / headless
 *     npx electron scripts/capture-demo.js                          # desktop
 *
 * Needs ffmpeg on PATH (frames -> palette -> GIF). Frames are captured in real
 * time with their actual timestamps, so pacing matches the timeline below.
 *
 * This window loads only this repo's own local files, with webSecurity off so
 * the scene can reach into the file:// iframes. It never loads anything remote.
 */

const path = require('path');
const fs = require('fs');
const os = require('os');
const { spawnSync } = require('child_process');
const { app, BrowserWindow } = require('electron');

const REPO = path.resolve(__dirname, '..');
const OUT = path.join(REPO, 'assets', 'demo.gif');
const W = 1120;
const H = 600;
const OUT_W = 860;           // README width
const FRAME_MS = 80;         // target capture interval (~12.5 fps)
const TOTAL_MS = 8600;       // one loop

function fileUrl(p) { return 'file://' + path.resolve(p).split(path.sep).join('/'); }
function wait(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }

// The brand mark from the Settings sidebar (src/renderer/settings/index.html).
const MARK = '<svg viewBox="0 0 256 256" width="28" height="28" aria-hidden="true"><defs>' +
  '<linearGradient id="g" x1="28" y1="128" x2="228" y2="128" gradientUnits="userSpaceOnUse">' +
  '<stop offset="0" stop-color="#67E8F9"/><stop offset="0.5" stop-color="#5EEAD4"/><stop offset="1" stop-color="#A78BFA"/>' +
  '</linearGradient></defs><g fill="url(#g)">' +
  '<rect x="28" y="78" width="24" height="100" rx="12"/><rect x="72" y="40" width="24" height="176" rx="12"/>' +
  '<rect x="116" y="66" width="24" height="124" rx="12"/><rect x="160" y="24" width="24" height="208" rx="12"/>' +
  '<rect x="204" y="86" width="24" height="84" rx="12"/></g></svg>';

const CURSOR = '<svg viewBox="0 0 24 24" width="26" height="26"><path d="M4 2 L4 20 L9 15 L12.5 22 L15.5 20.6 L12 13.8 L19 13.8 Z" ' +
  'fill="#E6EAF2" stroke="#0B0E14" stroke-width="1.4" stroke-linejoin="round"/></svg>';

const SENTENCE = 'Add eggs and milk to the list.';

function sceneHtml() {
  const theme = fileUrl(path.join(REPO, 'src', 'renderer', 'shared', 'theme.css'));
  const overlay = fileUrl(path.join(REPO, 'src', 'renderer', 'overlay', 'index.html'));
  const pad = fileUrl(path.join(REPO, 'src', 'renderer', 'pad', 'index.html'));
  return `<!doctype html><html><head><meta charset="utf-8">
<link rel="stylesheet" href="${theme}">
<style>
  html, body { margin: 0; width: ${W}px; height: ${H}px; overflow: hidden; }
  body { background: radial-gradient(120% 130% at 30% 10%, #131a29 0%, #0b0e14 60%); font-family: var(--font); color: var(--text); }
  .brand { position: absolute; left: 34px; top: 26px; display: flex; align-items: center; gap: 12px;
           font-weight: 650; font-size: 22px; letter-spacing: .2px; }
  .note { position: absolute; left: 610px; top: 84px; width: 460px; height: 250px; border-radius: 14px;
          background: var(--ink-800); border: 1px solid var(--border-strong); box-shadow: var(--shadow-lg);
          transition: border-color .3s, box-shadow .3s; }
  .note.hot { border-color: rgba(var(--teal-rgb), .7); box-shadow: var(--shadow-lg), 0 0 0 3px rgba(var(--teal-rgb), .14); }
  .bar { height: 38px; display: flex; align-items: center; gap: 7px; padding: 0 14px; border-bottom: 1px solid var(--border); }
  .bar i { width: 10px; height: 10px; border-radius: 50%; background: #2A3242; display: inline-block; }
  .bar span { margin-left: 8px; font-size: 13px; color: var(--text-muted); }
  .body { padding: 18px 20px; font-size: 18px; color: var(--text-faint); }
  .body.filled { color: var(--text); }
  .caret { display: inline-block; width: 2px; height: 20px; background: var(--cyan); vertical-align: -3px; margin-left: 2px; }
  iframe { position: absolute; border: 0; background: transparent; }
  #ov { left: 200px; top: 420px; width: 320px; height: 72px; }
  #pad { left: 178px; top: 300px; width: 360px; height: 208px; opacity: 0; transition: opacity .25s; }
  #cursor { position: absolute; left: 0; top: 0; opacity: 0; transition: opacity .2s; }
  .tag { position: absolute; left: 0; right: 0; bottom: 30px; text-align: center; font-size: 19px; color: var(--text-muted); }
  .tag b { font-weight: 600; transition: color .3s; color: var(--text-muted); }
  .tag b.on { color: var(--teal); }
</style></head><body>
  <div class="brand">${MARK}<span>Say Anything</span></div>
  <div class="note" id="note"><div class="bar"><i></i><i></i><i></i><span>note.txt</span></div>
    <div class="body" id="noteBody">Type or talk here…</div></div>
  <iframe id="ov" src="${overlay}"></iframe>
  <iframe id="pad" src="${pad}"></iframe>
  <div id="cursor">${CURSOR}</div>
  <div class="tag"><b id="t1">Talk anywhere</b>, <b id="t2">drop anywhere.</b></div>
</body></html>`;
}

// Timeline, driven from the page: returns when the loop has finished.
const DRIVER = `(function () {
  var SENT = ${JSON.stringify(SENTENCE)};
  var ov = document.getElementById('ov').contentWindow;
  var padF = document.getElementById('pad');
  var pad = padF.contentWindow;
  var cur = document.getElementById('cursor');
  var note = document.getElementById('note');
  var body = document.getElementById('noteBody');
  var t1 = document.getElementById('t1'), t2 = document.getElementById('t2');
  var O = ov.__sayanythingOverlay, P = pad.__sayanythingPad;
  if (!O || !P) return Promise.reject(new Error('debug hooks missing'));
  // Transparent iframe pages: let the scene show through.
  [ov, pad].forEach(function (w) { w.document.documentElement.style.background = 'transparent'; w.document.body.style.background = 'transparent'; });
  var t0 = performance.now();
  var levelTimer = null, i = 0;
  function at(ms, fn) { setTimeout(fn, ms); }
  function ease(x) { return x < .5 ? 2 * x * x : 1 - Math.pow(-2 * x + 2, 2) / 2; }
  function move(el, x0, y0, x1, y1, ms, startMs) {
    at(startMs, function () {
      var s = performance.now();
      (function step() {
        var k = Math.min(1, (performance.now() - s) / ms), e = ease(k);
        el.style.left = (x0 + (x1 - x0) * e) + 'px'; el.style.top = (y0 + (y1 - y0) * e) + 'px';
        if (k < 1) requestAnimationFrame(step);
      })();
    });
  }
  t1.classList.add('on');
  at(500, function () {
    O.applyState('listening', { t0: Date.now() });
    levelTimer = setInterval(function () { i++; O.level(0.12 + 0.1 * Math.abs(Math.sin(i * 0.45)) + 0.05 * Math.random()); }, 33);
  });
  var words = SENT.replace(/\\.$/, '').split(' ');
  words.forEach(function (w, k) { at(1000 + k * 330, function () { O.partial(words.slice(0, k + 1).join(' ')); }); });
  at(3500, function () { clearInterval(levelTimer); O.applyState('transcribing', {}); });
  at(4000, function () {
    O.applyState('hidden', {});
    P.show(SENT); padF.style.opacity = '1';
    t1.classList.remove('on'); t2.classList.add('on');
  });
  // cursor comes in, grabs the pad's grip, drags it onto the note
  at(4700, function () { cur.style.left = '420px'; cur.style.top = '470px'; cur.style.opacity = '1'; });
  move(cur, 420, 470, 300, 318, 500, 4700);
  move(cur, 300, 318, 742, 140, 1100, 5400);
  move(padF, 178, 300, 620, 122, 1100, 5400);
  at(5900, function () { note.classList.add('hot'); });
  at(6600, function () {
    padF.style.opacity = '0'; note.classList.remove('hot');
    body.classList.add('filled'); body.textContent = SENT; var c = document.createElement('span'); c.className = 'caret'; body.appendChild(c);
  });
  at(7000, function () { cur.style.opacity = '0'; });
  return new Promise(function (r) { at(${TOTAL_MS}, r); });
})()`;

async function main() {
  const ff = spawnSync('ffmpeg', ['-version'], { stdio: 'ignore' });
  if (ff.status !== 0) throw new Error('ffmpeg not found on PATH');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sa-demo-'));
  const scene = path.join(tmp, 'scene.html');
  fs.writeFileSync(scene, sceneHtml());

  const win = new BrowserWindow({
    width: W, height: H, useContentSize: true, show: false, frame: false, backgroundColor: '#0b0e14',
    webPreferences: { webSecurity: false, sandbox: true, contextIsolation: true },
  });
  await win.loadFile(scene);
  win.showInactive();
  await wait(900); // iframes load, fonts settle

  const frames = [];
  let done = false;
  const run = win.webContents.executeJavaScript(DRIVER, true).then(function () { done = true; });
  run.catch(function (e) { console.error('capture-demo: timeline failed: ' + e.message); done = true; });
  const start = Date.now();
  while (!done) {
    const t = Date.now() - start;
    const img = await win.webContents.capturePage();
    const file = path.join(tmp, 'f' + String(frames.length).padStart(4, '0') + '.png');
    fs.writeFileSync(file, img.toPNG());
    frames.push({ file: file, t: t });
    const next = (frames.length) * FRAME_MS;
    const slack = next - (Date.now() - start);
    if (slack > 0) await wait(slack);
  }
  await run.catch(function () {});

  // concat list with each frame's real duration; the last frame holds a bit.
  const lines = [];
  for (let k = 0; k < frames.length; k++) {
    const dur = k + 1 < frames.length ? (frames[k + 1].t - frames[k].t) / 1000 : 1.2;
    lines.push("file '" + frames[k].file + "'", 'duration ' + dur.toFixed(3));
  }
  lines.push("file '" + frames[frames.length - 1].file + "'");
  const list = path.join(tmp, 'frames.txt');
  fs.writeFileSync(list, lines.join('\n') + '\n');
  const vf = 'scale=' + OUT_W + ':-2:flags=lanczos,split[a][b];[a]palettegen=max_colors=128:stats_mode=diff[p];[b][p]paletteuse=dither=bayer:bayer_scale=4:diff_mode=rectangle';
  const r = spawnSync('ffmpeg', ['-v', 'error', '-y', '-f', 'concat', '-safe', '0', '-i', list, '-vf', vf, '-loop', '0', OUT], { stdio: 'inherit' });
  if (r.status !== 0) throw new Error('ffmpeg failed');
  console.log('capture-demo: wrote ' + path.relative(REPO, OUT) + ' (' + frames.length + ' frames, ' +
    Math.round(fs.statSync(OUT).size / 1024) + ' KB)');
  fs.rmSync(tmp, { recursive: true, force: true });
}

app.disableHardwareAcceleration();
app.whenReady().then(main).then(function () { app.exit(0); }, function (e) {
  console.error('capture-demo: ' + (e && e.stack || e));
  app.exit(1);
});
