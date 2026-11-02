// HoverTranslate background service worker.
// Does the network requests (content scripts can't call the API directly
// because of page CORS rules) and handles the on/off toolbar button.

const ENDPOINT = 'https://translate.googleapis.com/translate_a/single';
const MAX_CACHE = 2000;
const cache = new Map();

async function translate(text) {
  if (cache.has(text)) return cache.get(text);

  const url = `${ENDPOINT}?client=gtx&sl=de&tl=en&dt=t&dt=bd&q=${encodeURIComponent(text)}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const data = await res.json();

  // data[0] = [[translatedChunk, originalChunk, ...], ...]
  // data[1] = dictionary entries (present for real German words), or null
  const translation = Array.isArray(data?.[0])
    ? data[0].map((seg) => (Array.isArray(seg) && typeof seg[0] === 'string' ? seg[0] : '')).join('').trim()
    : '';
  const hasDictionary = Array.isArray(data?.[1]) && data[1].length > 0;

  const result = { translation, hasDictionary };
  cache.set(text, result);
  if (cache.size > MAX_CACHE) cache.delete(cache.keys().next().value);
  return result;
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.type !== 'translate' || typeof msg.text !== 'string') return;
  translate(msg.text.slice(0, 200))
    .then((r) => sendResponse({ ok: true, ...r }))
    .catch((err) => sendResponse({ ok: false, error: String(err?.message || err) }));
  return true; // keep the channel open for the async response
});

// ---- On/off toggle via the toolbar icon ----

async function isEnabled() {
  const { enabled = true } = await chrome.storage.local.get('enabled');
  return enabled !== false;
}

async function refreshBadge() {
  const enabled = await isEnabled();
  await chrome.action.setBadgeBackgroundColor({ color: '#6b7280' });
  await chrome.action.setBadgeText({ text: enabled ? '' : 'OFF' });
  await chrome.action.setTitle({
    title: enabled ? 'HoverTranslate: ON (click to turn off)' : 'HoverTranslate: OFF (click to turn on)',
  });
}

chrome.action.onClicked.addListener(async () => {
  await chrome.storage.local.set({ enabled: !(await isEnabled()) });
  await refreshBadge();
});

chrome.runtime.onInstalled.addListener(refreshBadge);
chrome.runtime.onStartup.addListener(refreshBadge);
