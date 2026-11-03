'use strict';

/*
 * Start a throwaway session bus for tests (dbus-daemon --session --nofork).
 * Resolves { address, stop() }, or null when dbus-daemon is not installed
 * (callers decide whether that is a skip or a failure).
 */

const { spawn, spawnSync } = require('child_process');

function hasDbusDaemon() {
  if (process.platform !== 'linux') return false;
  const r = spawnSync('dbus-daemon', ['--version'], { stdio: 'ignore' });
  return r.status === 0;
}

function startPrivateBus() {
  if (!hasDbusDaemon()) return Promise.resolve(null);
  return new Promise(function (resolve, reject) {
    const child = spawn('dbus-daemon', ['--session', '--nofork', '--nopidfile', '--print-address=1'], {
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    let out = '';
    const timer = setTimeout(function () { try { child.kill(); } catch (e) { /* ignore */ } reject(new Error('dbus-daemon did not print an address')); }, 5000);
    child.on('error', function (e) { clearTimeout(timer); reject(e); });
    child.stdout.on('data', function (d) {
      out += String(d);
      const nl = out.indexOf('\n');
      if (nl === -1) return;
      clearTimeout(timer);
      resolve({
        address: out.slice(0, nl).trim(),
        stop: function () { try { child.kill(); } catch (e) { /* ignore */ } },
      });
    });
  });
}

module.exports = { startPrivateBus: startPrivateBus, hasDbusDaemon: hasDbusDaemon };
