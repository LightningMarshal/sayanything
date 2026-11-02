'use strict';

/**
 * Helper self-test. Run manually:  node test/helper-selftest.js
 *
 * Exercises the real native helper end to end. Two platform paths:
 *
 *  - Windows: drives src/main/helper.js (compiles SayAnythingHelper.exe via
 *    native/build.cmd if missing), then ping / paste / type / foreground / copy.
 *
 *  - macOS: spawns bin/helper/SayAnythingHelper directly (building it via
 *    native/build-mac.sh if missing) and speaks the JSON-lines protocol itself,
 *    so the test does not depend on the JS config/helper layer being ported yet.
 *    It verifies: ready, ping/pong, a perms event, a clipboard round-trip
 *    (read back with pbpaste unless CI=1), foreground returns an exe string,
 *    paste into nothing returns ok (or the clean "accessibility not granted"
 *    error when Accessibility is not granted), and a clean quit.
 *
 * The watch + captured round-trip needs a real human keypress, so it is
 * manual-only and NOT asserted here.
 *
 * Exits 0 on success, non-zero on failure. Not part of `npm test`.
 */

const RESULTS = [];
let failed = false;

function check(name, ok, extra) {
  RESULTS.push({ name: name, ok: ok, extra: extra });
  if (!ok) failed = true;
  const tag = ok ? 'PASS' : 'FAIL';
  console.log(tag + '  ' + name + (extra ? '  (' + extra + ')' : ''));
}

function fail(msg) {
  failed = true;
  console.log('FAIL  ' + msg);
}

function summarizeAndExit() {
  const passed = RESULTS.filter(function (r) { return r.ok; }).length;
  console.log('---');
  console.log('helper-selftest: ' + passed + '/' + RESULTS.length + ' checks passed');
  setTimeout(function () { process.exit(failed ? 1 : 0); }, 300);
}

// =====================================================================
// macOS: drive the Swift helper binary directly over JSON-lines stdio.
// =====================================================================

async function runDarwin() {
  const cp = require('child_process');
  const fs = require('fs');
  const path = require('path');

  const BIN = path.join(__dirname, '..', 'bin', 'helper', 'SayAnythingHelper');
  const BUILD = path.join(__dirname, '..', 'native', 'build-mac.sh');

  // Build on demand (dev checkout) if the binary is missing.
  if (!fs.existsSync(BIN)) {
    if (!fs.existsSync(BUILD)) {
      check('helper binary present', false, 'missing ' + BIN + ' and ' + BUILD);
      return;
    }
    try {
      cp.execFileSync('/bin/bash', [BUILD], { stdio: 'ignore' });
    } catch (e) {
      check('build-mac.sh', false, e && e.message);
      return;
    }
  }
  check('helper binary present', fs.existsSync(BIN), BIN);
  if (!fs.existsSync(BIN)) return;

  const child = cp.spawn(BIN, [], { stdio: ['pipe', 'pipe', 'pipe'] });

  // ---- minimal JSON-lines client ----
  let buf = '';
  let readyFired = false;
  let onReady = null;
  let lastPerms = null;          // {listen, ax}
  let permsSeen = false;
  const q = { pong: [], copied: [], pasted: [], typed: [], foreground: [] };

  function routeResult(kind, obj) {
    const p = q[kind].shift();
    if (p) { clearTimeout(p.timer); p.resolve(obj); }
  }

  child.stdout.setEncoding('utf8');
  child.stdout.on('data', function (chunk) {
    buf += chunk;
    let idx;
    while ((idx = buf.indexOf('\n')) >= 0) {
      let line = buf.slice(0, idx);
      buf = buf.slice(idx + 1);
      if (line.length && line.charCodeAt(line.length - 1) === 13) line = line.slice(0, -1);
      if (!line.length) continue;
      let obj;
      try { obj = JSON.parse(line); } catch (e) { continue; }
      if (!obj || typeof obj.evt !== 'string') continue;
      switch (obj.evt) {
        case 'ready': readyFired = true; if (onReady) { onReady(); onReady = null; } break;
        case 'perms': permsSeen = true; lastPerms = { listen: !!obj.listen, ax: !!obj.ax }; break;
        case 'pong': routeResult('pong', true); break;
        case 'copied': routeResult('copied', { ok: !!obj.ok, err: obj.err == null ? null : String(obj.err) }); break;
        case 'pasted': routeResult('pasted', { ok: !!obj.ok, err: obj.err == null ? null : String(obj.err) }); break;
        case 'typed': routeResult('typed', { ok: !!obj.ok, err: obj.err == null ? null : String(obj.err) }); break;
        case 'foreground': routeResult('foreground', { exe: obj.exe || '', title: obj.title || '' }); break;
        default: break;
      }
    }
  });

  let stderrText = '';
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', function (d) { stderrText += d; });

  let exited = false;
  let exitInfo = null;
  child.on('exit', function (code, signal) { exited = true; exitInfo = { code: code, signal: signal }; });

  function send(obj) {
    try { child.stdin.write(JSON.stringify(obj) + '\n'); return true; }
    catch (e) { return false; }
  }
  function request(kind, obj, timeoutMs) {
    return new Promise(function (resolve, reject) {
      const pending = { resolve: resolve, reject: reject, timer: null };
      pending.timer = setTimeout(function () {
        const i = q[kind].indexOf(pending);
        if (i >= 0) q[kind].splice(i, 1);
        reject(new Error('timeout waiting for ' + kind));
      }, timeoutMs);
      q[kind].push(pending);
      if (!send(obj)) { clearTimeout(pending.timer); reject(new Error('helper not writable')); }
    });
  }
  function waitReady(timeoutMs) {
    return new Promise(function (resolve, reject) {
      if (readyFired) { resolve(); return; }
      const t = setTimeout(function () { reject(new Error('ready timeout')); }, timeoutMs);
      onReady = function () { clearTimeout(t); resolve(); };
    });
  }
  const delay = function (ms) { return new Promise(function (r) { setTimeout(r, ms); }); };

  // 1. ready
  try {
    await waitReady(15000);
    check('start -> ready', true);
  } catch (e) {
    check('start -> ready', false, e && e.message);
    try { child.kill(); } catch (e2) { /* ignore */ }
    return;
  }

  // 2. ping / pong
  try {
    const pong = await request('pong', { cmd: 'ping' }, 2000);
    check('ping -> pong', pong === true, 'pong=' + pong);
  } catch (e) {
    check('ping -> pong', false, e && e.message);
  }

  // 3. perms event arrives (emitted right after ready; give it a beat)
  if (!permsSeen) { await delay(200); }
  check('perms event arrives', permsSeen,
    lastPerms ? ('listen=' + lastPerms.listen + ' ax=' + lastPerms.ax) : 'none');

  // 4. clipboard round-trip
  try {
    const sentinel = 'sayanything-selftest-clip-' + process.pid;
    const res = await request('copied', { cmd: 'clipboard', text: sentinel }, 5000);
    if (process.env.CI) {
      check('clipboard -> ok (read-back skipped in CI)', res && res.ok === true, res && res.err ? res.err : '');
    } else {
      let clip = '';
      try { clip = cp.execFileSync('pbpaste', [], { encoding: 'utf8' }); } catch (e) { clip = '(read failed)'; }
      check('clipboard -> pbpaste round-trip', res && res.ok === true && clip.indexOf(sentinel) !== -1,
        res && res.err ? res.err : ('clip=' + clip.slice(0, 40)));
    }
  } catch (e) {
    check('clipboard -> pbpaste round-trip', false, e && e.message);
  }

  // 5. foreground returns an exe string
  try {
    const fg = await request('foreground', { cmd: 'foreground' }, 2000);
    const ok = fg && typeof fg.exe === 'string' && typeof fg.title === 'string';
    check('foreground -> {exe,title}', ok, ok ? ('exe=' + (fg.exe || '<none>')) : '');
  } catch (e) {
    check('foreground -> {exe,title}', false, e && e.message);
  }

  // 6. paste into nothing: ok when AX granted, else the clean AX error.
  try {
    const res = await request('pasted', { cmd: 'paste', text: 'SayAnything selftest ', restoreMs: 60 }, 6000);
    const axGranted = lastPerms ? lastPerms.ax : false;
    let ok;
    let detail;
    if (axGranted) {
      ok = res && res.ok === true;
      detail = res && res.err ? res.err : 'ok (AX granted)';
    } else {
      ok = res && res.ok === false && res.err === 'accessibility not granted';
      detail = res ? ('ok=' + res.ok + ' err=' + res.err) : 'no reply';
    }
    check('paste -> ok or clean AX err', ok, detail);
  } catch (e) {
    check('paste -> ok or clean AX err', false, e && e.message);
  }

  // 7. quit exits cleanly
  try {
    send({ cmd: 'quit' });
    try { child.stdin.end(); } catch (e) { /* ignore */ }
    const deadline = Date.now() + 3000;
    while (!exited && Date.now() < deadline) { await delay(50); }
    if (!exited) { try { child.kill(); } catch (e) { /* ignore */ } }
    check('quit -> exit', exited, exitInfo ? ('code=' + exitInfo.code + ' signal=' + exitInfo.signal) : 'did not exit');
  } catch (e) {
    check('quit -> exit', false, e && e.message);
  }

  if (stderrText.trim()) console.log('helper stderr: ' + stderrText.trim().slice(0, 200));
}

// =====================================================================
// Windows: drive src/main/helper.js (unchanged behavior).
// =====================================================================

async function runWindows() {
  const helper = require('../src/main/helper');

  // 1. start (compiles if the exe is missing)
  try {
    await helper.start();
    check('start -> ready', true);
  } catch (e) {
    check('start -> ready', false, e && e.message);
    return; // nothing else can run
  }

  // 2. ping / pong
  try {
    const pong = await helper.ping();
    check('ping -> pong', pong === true, 'pong=' + pong);
  } catch (e) {
    check('ping -> pong', false, e && e.message);
  }

  // 3. paste round-trip (restore clipboard quickly)
  try {
    const res = await helper.paste('SayAnything selftest ', 120);
    check('paste -> ok', res && res.ok === true, res && res.err ? res.err : '');
  } catch (e) {
    check('paste -> ok', false, e && e.message);
  }

  // 4. type empty string (no-op, must still succeed)
  try {
    const res = await helper.type('');
    check('type("") -> ok', res && res.ok === true, res && res.err ? res.err : '');
  } catch (e) {
    check('type("") -> ok', false, e && e.message);
  }

  // 5. foreground query
  try {
    const fg = await helper.foreground();
    const ok = fg && typeof fg.exe === 'string' && typeof fg.title === 'string';
    check('foreground -> {exe,title}', ok, ok ? ('exe=' + (fg.exe || '<none>')) : '');
  } catch (e) {
    check('foreground -> {exe,title}', false, e && e.message);
  }

  // 6. copy (drop-pad auto-copy): the command must report ok. The clipboard
  //    READ-BACK is asserted only outside CI — headless CI runners often have no
  //    usable clipboard session, which would flake this check (the helper itself
  //    is fine). Locally it verifies the bytes actually landed on the clipboard.
  try {
    const cp = require('child_process');
    const sentinel = 'sayanything-selftest-clip-' + process.pid;
    const res = await helper.copy(sentinel);
    if (process.env.CI) {
      check('copy -> ok (clipboard read-back skipped in CI)', res && res.ok === true, res && res.err ? res.err : '');
    } else {
      let clip = '';
      try { clip = cp.execFileSync('powershell', ['-NoProfile', '-Command', 'Get-Clipboard -Raw'], { encoding: 'utf8' }).trim(); }
      catch (e) { clip = '(read failed)'; }
      check('copy -> clipboard set', res && res.ok === true && clip.indexOf(sentinel) !== -1,
        res && res.err ? res.err : ('clip=' + clip.slice(0, 32)));
    }
  } catch (e) {
    check('copy -> clipboard set', false, e && e.message);
  }

  // 7. WS-2: a noHistory copy carries the three Windows opt-out formats, and
  // 8. WS-3: a paste restores rich clipboard content (HTML), not just text.
  //    Both read the clipboard through PowerShell (STA). If the runner has no
  //    usable clipboard session the read fails and the check is reported as
  //    SKIPPED rather than flaking; on a desktop it is a real assertion.
  await clipboardFormatChecks(helper);

  try { helper.stop(); } catch (e) { /* ignore */ }
}

function psClipboard(script) {
  const cp = require('child_process');
  const pre = 'Add-Type -AssemblyName System.Windows.Forms; ';
  return cp.execFileSync('powershell', ['-NoProfile', '-STA', '-Command', pre + script],
    { encoding: 'utf8', timeout: 15000 }).trim();
}

function skip(name, why) {
  console.log('SKIP ' + name + (why ? ' (' + why + ')' : ''));
}

async function clipboardFormatChecks(helper) {
  const listFormats = '[System.Windows.Forms.Clipboard]::GetDataObject().GetFormats() -join "|"';

  // 7. noHistory copy -> opt-out formats present
  const name7 = 'copy(noHistory) -> clipboard-history opt-out formats present';
  try {
    const res = await helper.copy('sayanything-selftest-private-' + process.pid, { noHistory: true });
    let fmts = null;
    try { fmts = psClipboard(listFormats); } catch (e) { fmts = null; }
    if (fmts === null) { skip(name7, 'clipboard not readable on this runner'); }
    else {
      const need = ['ExcludeClipboardContentFromMonitorProcessing', 'CanIncludeInClipboardHistory', 'CanUploadToCloudClipboard'];
      const have = fmts.split('|');
      const missing = need.filter(function (f) { return have.indexOf(f) === -1; });
      check(name7, res && res.ok === true && missing.length === 0, missing.length ? ('missing: ' + missing.join(',')) : '');
    }
  } catch (e) {
    check(name7, false, e && e.message);
  }

  // 7b. plain copy (pad setting off / history click) -> no opt-out formats
  const name7b = 'copy() -> ordinary clipboard entry (no opt-out formats)';
  try {
    const res = await helper.copy('sayanything-selftest-public-' + process.pid);
    let fmts = null;
    try { fmts = psClipboard(listFormats); } catch (e) { fmts = null; }
    if (fmts === null) { skip(name7b, 'clipboard not readable on this runner'); }
    else {
      check(name7b, res && res.ok === true && fmts.indexOf('CanIncludeInClipboardHistory') === -1, 'formats=' + fmts);
    }
  } catch (e) {
    check(name7b, false, e && e.message);
  }

  // 8. paste restores HTML + text the user had copied
  const name8 = 'paste -> restores rich (HTML) clipboard content afterwards';
  try {
    let seeded = true;
    try {
      psClipboard('$d = New-Object System.Windows.Forms.DataObject; ' +
        '$d.SetData([System.Windows.Forms.DataFormats]::Html, "Version:0.9\r\nStartHTML:0\r\nEndHTML:0\r\nStartFragment:0\r\nEndFragment:0\r\n<b>rich-selftest</b>"); ' +
        '$d.SetData([System.Windows.Forms.DataFormats]::UnicodeText, "rich-selftest"); ' +
        '[System.Windows.Forms.Clipboard]::SetDataObject($d, $true)');
    } catch (e) { seeded = false; }
    if (!seeded) { skip(name8, 'clipboard not writable on this runner'); }
    else {
      const res = await helper.paste('SayAnything restore test ', 60);
      await new Promise(function (r) { setTimeout(r, 200); });
      let fmts = null;
      let text = null;
      try {
        fmts = psClipboard(listFormats);
        text = psClipboard('[System.Windows.Forms.Clipboard]::GetText()');
      } catch (e) { fmts = null; }
      if (fmts === null) { skip(name8, 'clipboard not readable on this runner'); }
      else {
        const ok = res && res.ok === true && fmts.split('|').indexOf('HTML Format') !== -1 && text === 'rich-selftest';
        check(name8, ok, 'formats=' + fmts + ' text=' + JSON.stringify(text));
      }
    }
  } catch (e) {
    check(name8, false, e && e.message);
  }
}

// --- MANUAL ONLY: watch + captured round-trip -------------------------
// Requires a physical keypress; left disabled so the suite stays headless.
// To try it by hand (either platform), arm capture and press a key within 8s.

const runner = (process.platform === 'darwin') ? runDarwin : runWindows;

runner()
  .catch(function (e) {
    fail('unexpected error: ' + (e && e.stack ? e.stack : e));
  })
  .then(summarizeAndExit);
