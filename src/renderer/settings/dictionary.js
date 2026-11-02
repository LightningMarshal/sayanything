'use strict';

/**
 * Dictionary tab: custom words passed to whisper as a prompt.
 * Part of the Settings window (src/renderer/settings/*.js): plain scripts that
 * share window.SayAnythingSettings (S); see settings.js for load order.
 */

(function (S) {
  'use strict';

  // -------------------------------------------------------------------------
  // Dictionary
  // -------------------------------------------------------------------------

  function renderDictionary() {
    if (!S.settings) return;
    var wrap = S.$('dict-chips');
    if (!wrap) return;
    var words = S.settings.dictionary || [];
    wrap.innerHTML = '';
    if (!words.length) {
      wrap.innerHTML = '<span class="empty">No custom words yet.</span>';
      return;
    }
    for (var i = 0; i < words.length; i++) {
      (function (word) {
        var chip = document.createElement('span');
        chip.className = 'chip';
        var text = document.createElement('span');
        text.textContent = word;
        var x = document.createElement('button');
        x.setAttribute('aria-label', 'Remove ' + word);
        x.innerHTML = '&times;';
        x.addEventListener('click', function () { removeWord(word); });
        chip.appendChild(text);
        chip.appendChild(x);
        wrap.appendChild(chip);
      })(words[i]);
    }
  }

  function addWord() {
    var input = S.$('dict-input');
    if (!input) return;
    var w = input.value.trim();
    if (!w) return;
    var words = (S.settings.dictionary || []).slice();
    var exists = words.some(function (x) { return x.toLowerCase() === w.toLowerCase(); });
    if (!exists) {
      words.push(w);
      S.settings.dictionary = words;
      S.persist({ dictionary: words });
      renderDictionary();
    }
    input.value = '';
    input.focus();
  }

  function removeWord(word) {
    var words = (S.settings.dictionary || []).filter(function (x) { return x !== word; });
    S.settings.dictionary = words;
    S.persist({ dictionary: words });
    renderDictionary();
  }

  function wireDictionary() {
    var add = S.$('dict-add');
    var input = S.$('dict-input');
    if (add) add.addEventListener('click', addWord);
    if (input) input.addEventListener('keydown', function (e) {
      if (e.key === 'Enter') { e.preventDefault(); addWord(); }
    });
  }


  S.renderDictionary = renderDictionary;
  S.addWord = addWord;
  S.removeWord = removeWord;
  S.wireDictionary = wireDictionary;
})(window.SayAnythingSettings);
