'use strict';

/**
 * Static security rules for the renderer pages (WS-13). Plain node, no Electron.
 *
 *  - Every page has a Content-Security-Policy with default-src 'none', and no
 *    'unsafe-inline' or 'unsafe-eval' anywhere (scripts or styles).
 *  - No inline <script> bodies, inline event handlers (onclick=...) or inline
 *    style attributes in the HTML (the CSP would block them anyway; this keeps
 *    the pages honest so the CSP never needs loosening).
 *  - In renderer JS, innerHTML is only ever assigned one fixed string literal:
 *    anything dynamic (dictated text, model names, error messages) goes through
 *    textContent / DOM nodes, so it can never become markup.
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const RENDERER = path.join(__dirname, '..', 'src', 'renderer');
let passed = 0;
let failed = 0;
function ok(cond, label) {
  try { assert.ok(cond); passed++; } catch (e) { failed++; console.error('FAIL: ' + label); }
}

const pages = fs.readdirSync(RENDERER).map(function (d) { return path.join(RENDERER, d, 'index.html'); })
  .filter(function (p) { return fs.existsSync(p); });
ok(pages.length >= 4, 'found the renderer pages (' + pages.length + ')');

for (const p of pages) {
  const name = path.relative(RENDERER, p);
  const html = fs.readFileSync(p, 'utf8');
  const m = html.match(/http-equiv="Content-Security-Policy"\s+content="([^"]*)"/i);
  ok(!!m, name + ': has a CSP meta tag');
  const csp = m ? m[1] : '';
  ok(/default-src 'none'/.test(csp), name + ": CSP default-src 'none'");
  ok(csp.indexOf("'unsafe-inline'") === -1, name + ": CSP has no 'unsafe-inline'");
  ok(csp.indexOf("'unsafe-eval'") === -1, name + ": CSP has no 'unsafe-eval'");
  ok(!/\sstyle\s*=/i.test(html), name + ': no inline style attributes');
  ok(!/\son[a-z]+\s*=/i.test(html), name + ': no inline event handlers');
  const scripts = html.match(/<script\b[^>]*>([\s\S]*?)<\/script>/gi) || [];
  ok(scripts.every(function (s) { return /\ssrc=/.test(s) && /<script\b[^>]*>\s*<\/script>/i.test(s); }), name + ': only external scripts, no inline script bodies');
}

function walk(dir) {
  return fs.readdirSync(dir).reduce(function (acc, f) {
    const full = path.join(dir, f);
    if (fs.statSync(full).isDirectory()) return acc.concat(walk(full));
    return /\.js$/.test(f) ? acc.concat([full]) : acc;
  }, []);
}
for (const f of walk(RENDERER)) {
  const src = fs.readFileSync(f, 'utf8');
  const re = /\.(innerHTML|outerHTML)\s*=\s*/g;
  const literal = /^(?:'[^'\\\n]*'|"[^"\\\n]*")\s*;/;
  let mm;
  while ((mm = re.exec(src)) !== null) {
    const rest = src.slice(re.lastIndex);
    const line = src.slice(0, mm.index).split('\n').length;
    ok(literal.test(rest),
      path.relative(RENDERER, f) + ':' + line + ': ' + mm[1] + ' gets a single string literal (got: ' + rest.slice(0, 60).replace(/\n/g, ' ') + ')');
  }
  ok(!/insertAdjacentHTML|document\.write\s*\(/.test(src), path.relative(RENDERER, f) + ': no insertAdjacentHTML / document.write');
  ok(!/\beval\s*\(|new Function\s*\(/.test(src), path.relative(RENDERER, f) + ': no eval / new Function');
}

console.log('renderer-security-test: ' + passed + ' passed, ' + failed + ' failed');
process.exit(failed > 0 ? 1 : 0);
