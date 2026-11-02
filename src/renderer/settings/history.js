'use strict';

/**
 * History tab: opt-in, encrypted transcription history.
 * Part of the Settings window (src/renderer/settings/*.js): plain scripts that
 * share window.SayAnythingSettings (S); see settings.js for load order.
 */

(function (S) {
  'use strict';

  // -------------------------------------------------------------------------
  // History
  // -------------------------------------------------------------------------

  function loadHistory() {
    S.api.invoke('history:list').then(function (items) {
      renderHistory(Array.isArray(items) ? items : []);
    }).catch(function () { renderHistory([]); });
  }

  function renderHistory(items) {
    var wrap = S.$('history-list');
    if (!wrap) return;
    if (!items.length) {
      wrap.innerHTML = '<div class="empty">No transcriptions yet.</div>';
      return;
    }
    wrap.innerHTML = '';
    for (var i = 0; i < items.length; i++) {
      wrap.appendChild(historyRow(items[i]));
    }
  }

  function historyRow(item) {
    var row = document.createElement('div');
    row.className = 'history-item';
    row.title = 'Click to copy';

    var text = document.createElement('div');
    text.className = 'history-text';
    text.textContent = item.text;

    var meta = document.createElement('div');
    meta.className = 'history-meta';
    var when = S.relTime(item.at);
    meta.textContent = item.app ? (when + ' · ' + item.app) : when;

    var del = document.createElement('button');
    del.className = 'history-del';
    del.setAttribute('aria-label', 'Delete');
    del.innerHTML = '&times;';
    del.addEventListener('click', function (e) {
      e.stopPropagation();
      S.api.invoke('history:remove', item.id).catch(S.noop);
      loadHistory();
    });

    row.addEventListener('click', function () { S.copyText(item.text); });
    row.appendChild(text);
    row.appendChild(meta);
    row.appendChild(del);
    return row;
  }

  function wireHistoryControls() {
    var clear = S.$('history-clear');
    if (clear) clear.addEventListener('click', function () {
      S.api.invoke('history:clear').catch(S.noop);
      loadHistory();
    });
  }


  S.loadHistory = loadHistory;
  S.renderHistory = renderHistory;
  S.historyRow = historyRow;
  S.wireHistoryControls = wireHistoryControls;
})(window.SayAnythingSettings);
