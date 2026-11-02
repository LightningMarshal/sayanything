'use strict';

/**
 * `electron . --smoke`: headless self-test (no windows). Prints one JSON line
 * per check (settings, helper, whisper binaries, whisper server) and a summary
 * line, then exits 0 when nothing failed. Used by CI on Windows.
 *
 * @param {object} d  app, fs, config, settingsStore, helper, binaries, server, models
 * @returns {Promise<void>}
 */
function runSmoke(d) {
  const app = d.app;
  const fs = d.fs || require('fs');
  const config = d.config;
  const settingsStore = d.settingsStore;
  const helper = d.helper;
  const binaries = d.binaries;
  const server = d.server;
  const models = d.models;

  const results = [];
  function emit(o) { try { process.stdout.write(JSON.stringify(o) + '\n'); } catch (e) { /* ignore */ } }
  function record(name, ok, detail) {
    const line = { check: name, ok: !!ok };
    if (detail !== undefined) line.detail = detail;
    results.push(line);
    emit(line);
  }
  function skip(name, detail) {
    const line = { check: name, ok: true, skipped: true };
    if (detail !== undefined) line.detail = detail;
    results.push(line);
    emit(line);
  }

  let settings = null;

  return Promise.resolve()
    // 1. settings load
    .then(function () {
      try {
        settings = settingsStore && settingsStore.get ? settingsStore.get() : null;
        record('settings', !!settings, settings ? { userData: config && config.USER_DATA } : null);
      } catch (e) {
        record('settings', false, String(e && e.message || e));
      }
    })
    // 2. helper: compile-if-missing + spawn + ping
    .then(function () {
      if (!helper || !helper.start) { record('helper', false, 'helper module missing'); return; }
      return helper.start()
        .then(function () { return helper.ping(); })
        .then(function (pong) { record('helper', pong === true, { ping: pong }); })
        .catch(function (e) { record('helper', false, String(e && e.message || e)); });
    })
    // 3. whisper binaries present (unpack if needed)
    .then(function () {
      if (!binaries || !binaries.ensure) { record('binaries', false, 'binaries module missing'); return false; }
      return binaries.ensure()
        .then(function () {
          const ready = binaries.isReady ? binaries.isReady() : true;
          record('binaries', ready);
          return ready;
        })
        .catch(function (e) { record('binaries', false, String(e && e.message || e)); return false; });
    })
    // 4. server boot + /inference reachability (skip gracefully if no model)
    .then(function (binOk) {
      const model = (settings && settings.model) || 'small.en';
      const port = (settings && settings.whisperPort) || (config && config.DEFAULT_PORT) || 8737;
      let modelPath = null;
      try { modelPath = models && models.pathFor ? models.pathFor(model) : null; } catch (e) { /* ignore */ }

      if (!modelPath || !fs.existsSync(modelPath)) {
        skip('server', 'model "' + model + '" not downloaded — run `node scripts/setup.js` (skipping server boot)');
        return;
      }
      if (!binOk) {
        skip('server', 'whisper binaries missing — run `node scripts/setup.js`');
        return;
      }
      if (!server || !server.start) { record('server', false, 'server module missing'); return; }
      return server.start(model, port)
        .then(function (st) {
          const ok = !!(st && st.running && st.port);
          record('server', ok, { model: st && st.model, port: st && st.port });
        })
        .catch(function (e) { record('server', false, String(e && e.message || e)); });
    })
    // summary + exit
    .then(function () {
      const failed = results.filter(function (r) { return !r.ok; }).length;
      const skipped = results.filter(function (r) { return r.skipped; }).length;
      const passed = results.length - failed - skipped;
      emit({ summary: true, total: results.length, passed: passed, failed: failed, skipped: skipped, ok: failed === 0 });

      try { if (helper && helper.stop) helper.stop(); } catch (e) { /* ignore */ }
      const stopServer = (server && server.stop) ? server.stop() : Promise.resolve();
      return Promise.resolve(stopServer).catch(function () {}).then(function () {
        app.exit(failed === 0 ? 0 : 1);
      });
    })
    .catch(function (err) {
      emit({ summary: true, ok: false, error: String(err && err.message || err) });
      app.exit(1);
    });
}

module.exports = { runSmoke: runSmoke };
