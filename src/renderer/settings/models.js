'use strict';

/**
 * Model tab: whisper model list, downloads and progress.
 * Part of the Settings window (src/renderer/settings/*.js): plain scripts that
 * share window.SayAnythingSettings (S); see settings.js for load order.
 */

(function (S) {
  'use strict';

  // -------------------------------------------------------------------------
  // Model manager
  // -------------------------------------------------------------------------

  function loadModels() {
    S.api.invoke('models:list').then(function (list) {
      renderModels(Array.isArray(list) ? list : []);
    }).catch(function () {
      renderModels([]);
    });
  }

  function renderModels(list) {
    lastModelList = list; // kept so a mid-download progress event can rebuild
    var wrap = S.$('model-list');
    if (!wrap) return;
    if (!list.length) {
      wrap.innerHTML = '<div class="empty">No models available.</div>';
      return;
    }
    wrap.innerHTML = '';
    for (var i = 0; i < list.length; i++) {
      wrap.appendChild(modelCard(list[i]));
    }
  }


  function modelCard(m) {
    var isEn = /\.en$/.test(m.name);
    var card = document.createElement('div');
    card.className = 'model-card' + (m.active ? ' active' : '') + (m.recommended ? ' recommended' : '');
    card.setAttribute('data-model', m.name);

    var main = document.createElement('div');
    main.className = 'model-main';
    main.appendChild(S.el('span', 'model-name', m.name));
    if (m.recommended) main.appendChild(S.el('span', 'model-rec', 'Recommended'));
    main.appendChild(S.el('span', 'model-badge' + (isEn ? ' en' : ''), isEn ? 'English' : 'Multilingual'));

    var meta = document.createElement('div');
    meta.className = 'model-meta';
    meta.textContent = S.fmtSize(m.sizeMB)
      + (m.note ? ' · ' + m.note : '')
      + (m.downloaded ? ' · downloaded' : ' · not downloaded')
      + (m.verified === false ? ' · not hash-verified (size-checked only)' : '');

    var side = document.createElement('div');
    side.className = 'model-side';

    if (S.downloading[m.name]) {
      var cancel = S.button('ghost', 'Cancel', function () {
        S.api.invoke('models:cancel', m.name).catch(S.noop);
        delete S.downloading[m.name];
        loadModels();
      });
      side.appendChild(cancel);
    } else if (m.downloaded) {
      if (m.active) {
        var tag = document.createElement('span');
        tag.className = 'model-active-tag';
        tag.innerHTML = '<span class="dot ok"></span>Active';
        side.appendChild(tag);
      } else {
        var label = document.createElement('label');
        label.className = 'model-radio';
        var radio = document.createElement('input');
        radio.type = 'radio';
        radio.name = 'activeModel';
        radio.addEventListener('change', function () { setActiveModel(m.name); });
        label.appendChild(radio);
        label.appendChild(document.createTextNode('Set active'));
        side.appendChild(label);
      }
    } else {
      var dl = S.button('primary', 'Download', function () { startDownload(m.name); });
      side.appendChild(dl);
    }

    card.appendChild(main);
    card.appendChild(meta);
    card.appendChild(side);

    if (S.downloading[m.name]) card.appendChild(progressEls());
    return card;
  }

  function progressEls() {
    var frag = document.createDocumentFragment();
    var bar = document.createElement('div');
    bar.className = 'progress';
    bar.innerHTML = '<i></i>';
    var label = document.createElement('div');
    label.className = 'progress-label';
    label.textContent = 'Starting…';
    frag.appendChild(bar);
    frag.appendChild(label);
    return frag;
  }


  function startDownload(name) {
    S.downloading[name] = true;
    S.api.invoke('models:download', name).catch(function (err) {
      // Cancel() clears downloading[name] before this rejection lands; the main
      // side also rejects cancelled downloads with a "cancelled" message. Either
      // signal means the user stopped it on purpose — don't cry "failed".
      var msg = String((err && err.message) || '');
      var cancelled = !S.downloading[name] || /cancel/i.test(msg);
      delete S.downloading[name];
      if (!cancelled) S.toast('Download failed — check your connection');
      loadModels();
    });
    loadModels(); // re-render this card into progress mode
  }

  function setActiveModel(name) {
    S.persist({ model: name });
    S.api.invoke('whisper:restart').catch(S.noop);
    S.toast('Switched to ' + name);
    setTimeout(loadModels, 200);
  }

  function onModelProgress(p) {
    if (!p || !p.name) return;
    S.downloading[p.name] = true;
    var card = S.qs('.model-card[data-model="' + p.name + '"]');
    if (!card || !S.qs('.progress', card)) {
      renderModels(lastModelList);
      card = S.qs('.model-card[data-model="' + p.name + '"]');
      if (!card) return;
    }
    var bar = S.qs('.progress > i', card);
    var label = S.qs('.progress-label', card);
    var pct = typeof p.pct === 'number' ? Math.max(0, Math.min(100, p.pct)) : 0;
    if (bar) bar.style.width = pct + '%';
    if (label) {
      var txt = Math.round(pct) + '%';
      if (p.total) txt += ' · ' + S.fmtSize((p.bytes || 0) / (1024 * 1024)) + ' / ' + S.fmtSize(p.total / (1024 * 1024));
      label.textContent = txt;
    }
    if (pct >= 100 || (p.total > 0 && p.bytes >= p.total)) {
      delete S.downloading[p.name];
      setTimeout(loadModels, 400);
    }
  }

  // the last model list (set by renderModels) so a mid-download progress event can rebuild
  var lastModelList = [];


  S.loadModels = loadModels;
  S.renderModels = renderModels;
  S.modelCard = modelCard;
  S.progressEls = progressEls;
  S.startDownload = startDownload;
  S.setActiveModel = setActiveModel;
  S.onModelProgress = onModelProgress;
  S.lastModelList = lastModelList;
})(window.SayAnythingSettings);
