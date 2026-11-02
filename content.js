// HoverTranslate content script: rest the mouse on a German word and an
// English translation tooltip appears above it.
(() => {
  if (window.__hoverTranslateLoaded) return;
  window.__hoverTranslateLoaded = true;

  const HOVER_DELAY = 400; // ms the mouse must rest on a word
  const LOADING_DELAY = 250; // only show "…" if the lookup is slow
  const LETTER = /[\p{L}\p{M}]/u;
  const HYPHEN = /[-\u2010\u2011]/; // hyphen, Unicode hyphen, non-breaking hyphen

  let enabled = true;
  let hoverTimer = null;
  let loadingTimer = null;
  let lastX = 0;
  let lastY = 0;
  let current = null; // { word, rect, node, start }
  let requestId = 0;
  const cache = new Map();

  const alive = () => {
    try {
      return !!chrome.runtime?.id;
    } catch {
      return false;
    }
  };

  try {
    chrome.storage.local.get('enabled', (r) => {
      enabled = r?.enabled !== false;
    });
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area === 'local' && 'enabled' in changes) {
        enabled = changes.enabled.newValue !== false;
        if (!enabled) hide();
      }
    });
  } catch {
    /* extension context gone */
  }

  // ---------- Tooltip (isolated in a shadow root so page CSS can't touch it) ----------

  let host, tip, deEl, enEl;

  function ensureTooltip() {
    if (host && host.isConnected) return;
    host = document.createElement('hover-translate-tip');
    host.style.cssText =
      'all:initial;position:fixed;top:0;left:0;width:0;height:0;z-index:2147483647;pointer-events:none;';
    const root = host.attachShadow({ mode: 'closed' });
    root.innerHTML = `
      <style>
        .tip {
          position: fixed; top: 0; left: 0;
          box-sizing: border-box; max-width: 320px;
          padding: 6px 10px; border-radius: 6px;
          background: #1f2328; color: #fff;
          font: 14px/1.35 "Segoe UI", system-ui, -apple-system, sans-serif;
          box-shadow: 0 4px 14px rgba(0,0,0,.28);
          opacity: 0; visibility: hidden; transform: translateY(3px);
          transition: opacity .12s ease, transform .12s ease, visibility 0s linear .12s;
          white-space: normal; overflow-wrap: anywhere; text-align: left;
        }
        .tip.show {
          opacity: 1; visibility: visible; transform: none;
          transition: opacity .12s ease, transform .12s ease;
        }
        .de { font-size: 12px; color: #9ca3af; margin-bottom: 1px; }
        .en { font-weight: 600; }
        .tip.muted .en { font-weight: 400; font-style: italic; color: #d1d5db; }
      </style>
      <div class="tip" role="tooltip"><div class="de"></div><div class="en"></div></div>`;
    tip = root.querySelector('.tip');
    deEl = root.querySelector('.de');
    enEl = root.querySelector('.en');
    document.documentElement.appendChild(host);
  }

  function show(hit, english, muted = false) {
    ensureTooltip();
    deEl.textContent = hit.word;
    enEl.textContent = english;
    tip.classList.toggle('muted', muted);
    position(hit.rect);
    tip.classList.add('show');
  }

  function position(rect) {
    const gap = 8;
    const margin = 4;
    const w = tip.offsetWidth;
    const h = tip.offsetHeight;
    let top = rect.top - h - gap;
    if (top < margin) top = rect.bottom + gap; // no room above → go below
    let left = rect.left + rect.width / 2 - w / 2;
    left = Math.max(margin, Math.min(left, window.innerWidth - w - margin));
    tip.style.top = `${Math.round(top)}px`;
    tip.style.left = `${Math.round(left)}px`;
  }

  function hide() {
    clearTimeout(loadingTimer);
    requestId++;
    current = null;
    if (tip) tip.classList.remove('show');
  }

  // ---------- Finding the word under the mouse ----------

  function caretAt(x, y) {
    if (document.caretRangeFromPoint) {
      const r = document.caretRangeFromPoint(x, y);
      return r && { node: r.startContainer, offset: r.startOffset };
    }
    if (document.caretPositionFromPoint) {
      const p = document.caretPositionFromPoint(x, y);
      return p && { node: p.offsetNode, offset: p.offset };
    }
    return null;
  }

  function wordAtPoint(x, y) {
    const caret = caretAt(x, y);
    if (!caret || !caret.node || caret.node.nodeType !== Node.TEXT_NODE) return null;
    const node = caret.node;
    const text = node.data;

    const isWordChar = (k) => {
      if (k < 0 || k >= text.length) return false;
      const c = text[k];
      if (LETTER.test(c)) return true;
      // keep hyphenated compounds like "E-Mail" together
      return HYPHEN.test(c) && LETTER.test(text[k - 1] || '') && LETTER.test(text[k + 1] || '');
    };

    let i = caret.offset;
    if (!isWordChar(i)) {
      if (isWordChar(i - 1)) i -= 1;
      else return null;
    }
    let start = i;
    let end = i + 1;
    while (isWordChar(start - 1)) start--;
    while (isWordChar(end)) end++;

    const word = text.slice(start, end);
    if (word.length < 2) return null;

    // Make sure the pointer is really on the word, not in empty space beside it.
    const range = document.createRange();
    range.setStart(node, start);
    range.setEnd(node, end);
    const rect = Array.from(range.getClientRects()).find((r) => inRect(x, y, r, 1));
    if (!rect) return null;

    return { word, rect, node, start };
  }

  function inRect(x, y, r, pad) {
    return x >= r.left - pad && x <= r.right + pad && y >= r.top - pad && y <= r.bottom + pad;
  }

  // ---------- Translation ----------

  function requestTranslation(text) {
    return new Promise((resolve, reject) => {
      try {
        chrome.runtime.sendMessage({ type: 'translate', text }, (res) => {
          if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
          else resolve(res || { ok: false });
        });
      } catch (e) {
        reject(e);
      }
    });
  }

  function looksGerman(word, res) {
    if (!res.translation) return false;
    // Unchanged output with no dictionary entry means Google didn't treat it
    // as German (e.g. an English word on an English page) → stay quiet.
    return res.translation.toLowerCase() !== word.toLowerCase() || res.hasDictionary;
  }

  function onHover() {
    if (!enabled || document.hidden) return;
    if (!alive()) {
      enabled = false;
      hide();
      return;
    }

    const hit = wordAtPoint(lastX, lastY);
    if (!hit) return hide();
    if (current && current.node === hit.node && current.start === hit.start) return; // same word

    hide();
    current = hit;
    const id = ++requestId;
    const key = hit.word;

    const render = (res) => {
      if (id !== requestId) return; // mouse moved on
      clearTimeout(loadingTimer);
      if (!res.ok) return show(hit, 'Translation unavailable (offline?)', true);
      if (looksGerman(key, res)) show(hit, res.translation);
      else if (tip) tip.classList.remove('show');
    };

    if (cache.has(key)) return render(cache.get(key));

    loadingTimer = setTimeout(() => {
      if (id === requestId) show(hit, 'Translating…', true);
    }, LOADING_DELAY);

    requestTranslation(key)
      .then((res) => {
        if (res.ok) {
          cache.set(key, res);
          if (cache.size > 1000) cache.delete(cache.keys().next().value);
        }
        render(res);
      })
      .catch(() => render({ ok: false }));
  }

  // ---------- Events ----------

  document.addEventListener(
    'mousemove',
    (e) => {
      if (!enabled) return;
      lastX = e.clientX;
      lastY = e.clientY;
      if (current && !inRect(lastX, lastY, current.rect, 3)) hide();
      clearTimeout(hoverTimer);
      if (e.buttons) return; // selecting / dragging
      hoverTimer = setTimeout(onHover, HOVER_DELAY);
    },
    { passive: true }
  );

  const cancel = () => {
    clearTimeout(hoverTimer);
    hide();
  };
  document.addEventListener('mousedown', cancel, true);
  document.addEventListener('keydown', cancel, true);
  window.addEventListener('scroll', cancel, { capture: true, passive: true });
  window.addEventListener('blur', cancel);
  window.addEventListener('resize', cancel);
  document.addEventListener('mouseout', (e) => {
    if (!e.relatedTarget) cancel(); // pointer left the page
  });
})();
