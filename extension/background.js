// Forwards events from the Meet tab to the desktop overlay running on this PC.
// The overlay (overlay/mac-overlay.js or overlay/win-overlay.ps1) listens on 127.0.0.1 only.
const OVERLAY_PORT = 39393;
const BASE = `http://127.0.0.1:${OVERLAY_PORT}`;

async function call(kind, events) {
  const init =
    kind === 'events'
      ? { method: 'POST', headers: { 'Content-Type': 'text/plain' }, body: JSON.stringify(events || []) }
      : { method: 'GET', cache: 'no-store' };
  init.signal = AbortSignal.timeout(3000);
  const res = await fetch(BASE + (kind === 'events' ? '/event' : '/ping'), init);
  let body = {};
  try {
    body = await res.json();
  } catch (e) {
    // not JSON; the status code is enough
  }
  return { ok: res.ok, paused: !!body.paused };
}

// The same chat message can be picked up twice: from Meet's new-message notification and from
// the chat panel itself. Drop a comment seen from another source in the last few seconds.
const recentComments = []; // { text, source, at }

// Notifications may cut long messages short ("…"), so a shortened copy counts as the same.
function sameMessage(a, b) {
  if (a === b) return true;
  const cut = (s) => s.replace(/(…|\.\.\.)$/, '').trim();
  const [x, y] = [cut(a), cut(b)];
  if (Math.min(x.length, y.length) < 8) return x === y;
  return x.startsWith(y) || y.startsWith(x);
}

function dropDuplicates(events) {
  const now = Date.now();
  while (recentComments.length && now - recentComments[0].at > 10000) recentComments.shift();
  return (events || []).filter((e) => {
    if (!e || e.type !== 'comment') return true;
    const text = String(e.text || '').replace(/\s+/g, ' ').trim();
    const source = e.source || 'unknown';
    const dup = recentComments.find((c) => c.source !== source && sameMessage(c.text, text));
    if (dup) {
      recentComments.splice(recentComments.indexOf(dup), 1);
      return false;
    }
    recentComments.push({ text, source, at: now });
    return true;
  });
}

// Settings from the popup (chrome.storage.local). Kept in memory; reloaded when they change and
// when the service worker restarts.
const DEFAULTS = { size: 'normal', speed: 'normal', ngWords: [], paused: false };
const SIZES = { small: 0.75, normal: 1, large: 1.3, xlarge: 1.7 };
const SPEEDS = { slow: 9, normal: 6, fast: 4 }; // seconds to cross the screen
let settings = null;

async function loadSettings() {
  if (!settings) settings = Object.assign({}, DEFAULTS, await chrome.storage.local.get(DEFAULTS));
  return settings;
}
chrome.storage.onChanged.addListener(() => {
  settings = null;
});

// Upper/lower case and full/half width are not distinguished.
const normalize = (s) => String(s || '').normalize('NFKC').toLowerCase();

function applySettings(events, cfg) {
  const ng = (cfg.ngWords || []).map(normalize).filter(Boolean);
  const out = [];
  for (const e of events) {
    // Hidden with the button in Meet: nothing flows (diagnosis reports still pass).
    if (cfg.paused && e && (e.type === 'comment' || e.type === 'reaction')) continue;
    if (e && e.type === 'comment') {
      const text = normalize(e.text);
      if (ng.some((w) => text.includes(w))) continue;
      out.push(Object.assign({}, e, { fontScale: SIZES[cfg.size] || 1, seconds: SPEEDS[cfg.speed] || 6 }));
    } else {
      out.push(e);
    }
  }
  return out;
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || msg.type !== 'meet-comment-overlay') return false;
  if (msg.kind === 'pause') {
    chrome.storage.local.set({ paused: !!msg.value });
    return false;
  }
  const events = msg.kind === 'events' ? dropDuplicates(msg.events) : null;
  if (events && !events.length) {
    sendResponse({ ok: true, deduplicated: true });
    return false;
  }
  loadSettings()
    .then((cfg) => {
      const toSend = events ? applySettings(events, cfg) : null;
      if (toSend && !toSend.length) return { ok: true, filtered: true };
      return call(msg.kind, toSend);
    })
    .then(sendResponse)
    .catch((e) => sendResponse({ ok: false, error: String(e && e.message ? e.message : e) }));
  return true; // respond asynchronously
});
