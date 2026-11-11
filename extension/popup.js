// Settings popup. Size, speed and NG words are stored in chrome.storage.local and applied by
// background.js to every comment; the screen choice is sent straight to the desktop overlay.
const BASE = 'http://127.0.0.1:39393';
const DEFAULTS = { size: 'normal', speed: 'normal', ngWords: [] };
const SIZES = { small: 0.75, normal: 1, large: 1.3, xlarge: 1.7 };
const SPEEDS = { slow: 9, normal: 6, fast: 4 };
const MAX_WORDS = 100;
const MAX_WORD_LENGTH = 200;

const $ = (id) => document.getElementById(id);

// The footer text is only used for problems and for the "unsaved changes" notice.
function say(text, isError) {
  $('message').textContent = text;
  $('message').classList.toggle('err', !!isError);
}

// ---------- unsaved changes
// Chrome closes a popup the moment it loses focus and offers no way to ask first. So changes
// that were not saved are kept as a draft and are still there when the popup is opened again.

let saved = Object.assign({}, DEFAULTS);

function isDirty() {
  return $('size').value !== saved.size || $('speed').value !== saved.speed || parseWords($('ng').value).join('\n') !== (saved.ngWords || []).join('\n');
}

function refresh() {
  const dirty = isDirty();
  $('save').disabled = !dirty;
  say(dirty ? '未保存の変更があります' : '');
  if (dirty) chrome.storage.local.set({ draft: { size: $('size').value, speed: $('speed').value, ng: $('ng').value } });
  else chrome.storage.local.remove('draft');
}

async function call(path, body) {
  const init = body === undefined
    ? { cache: 'no-store' }
    : { method: 'POST', headers: { 'Content-Type': 'text/plain' }, body: JSON.stringify(body) };
  init.signal = AbortSignal.timeout(3000);
  const res = await fetch(BASE + path, init);
  if (!res.ok) throw new Error('HTTP ' + res.status);
  return res.json();
}

// ---------- NG words

function parseWords(text) {
  const seen = new Set();
  const out = [];
  for (const line of text.split('\n')) {
    const word = line.trim().slice(0, MAX_WORD_LENGTH);
    const key = word.normalize('NFKC').toLowerCase();
    if (!word || seen.has(key)) continue;
    seen.add(key);
    out.push(word);
  }
  return out;
}

// ---------- screens

function renderScreens(data) {
  const list = $('screens');
  list.textContent = '';
  const options = data.screens.map((s) => ({ index: s.index, name: s.name + (s.main ? '（メイン）' : ''), detail: s.width + '×' + s.height }));
  if (data.allowAll && data.screens.length > 1) options.push({ index: -1, name: 'すべての画面', detail: '' });
  for (const o of options) {
    const label = document.createElement('label');
    label.className = 'screen';
    const radio = document.createElement('input');
    radio.type = 'radio';
    radio.name = 'screen';
    radio.checked = o.index === data.current;
    radio.addEventListener('change', async () => {
      try {
        renderScreens(await call('/screen', { index: o.index }));
        refresh();
      } catch (e) {
        say('画面を変更できませんでした: ' + e.message, true);
      }
    });
    const name = document.createElement('span');
    name.textContent = o.name;
    const detail = document.createElement('small');
    detail.textContent = o.detail;
    label.append(radio, name, detail);
    list.appendChild(label);
  }
  $('screen-section').hidden = false;
}

// ---------- wiring

$('reset').addEventListener('click', () => {
  $('size').value = DEFAULTS.size;
  $('speed').value = DEFAULTS.speed;
  refresh();
});

$('size').addEventListener('change', refresh);
$('speed').addEventListener('change', refresh);
$('ng').addEventListener('input', refresh);

$('test').addEventListener('click', async () => {
  try {
    await call('/event', [
      { type: 'comment', text: 'テストコメント ' + new Date().toLocaleTimeString('ja-JP'), fontScale: SIZES[$('size').value], seconds: SPEEDS[$('speed').value] },
      { type: 'reaction', emoji: '👏', count: 3 },
    ]);
    refresh();
  } catch (e) {
    say('オーバーレイに送信できませんでした', true);
  }
});

$('save').addEventListener('click', async () => {
  const words = parseWords($('ng').value);
  if (words.length > MAX_WORDS) {
    say(`NGワードは ${MAX_WORDS} 件までです（現在 ${words.length} 件）`, true);
    return;
  }
  try {
    saved = { size: $('size').value, speed: $('speed').value, ngWords: words };
    await chrome.storage.local.set(saved);
    $('ng').value = words.join('\n');
    refresh();
  } catch (e) {
    say('保存できませんでした: ' + e.message, true);
  }
});

chrome.storage.local.get(Object.assign({ draft: null }, DEFAULTS)).then((cfg) => {
  saved = {
    size: SIZES[cfg.size] ? cfg.size : DEFAULTS.size,
    speed: SPEEDS[cfg.speed] ? cfg.speed : DEFAULTS.speed,
    ngWords: cfg.ngWords || [],
  };
  const draft = cfg.draft; // changes left unsaved when the popup was closed last time
  $('size').value = draft && SIZES[draft.size] ? draft.size : saved.size;
  $('speed').value = draft && SPEEDS[draft.speed] ? draft.speed : saved.speed;
  $('ng').value = draft && typeof draft.ng === 'string' ? draft.ng : saved.ngWords.join('\n');
  refresh();
});

// ---------- status line: on/off as set with the button at the bottom right of Meet

let overlayRunning = null; // null while checking
let paused = false;

// The button as it looks at the bottom right of Meet while off (screen + speech bubble, struck through).
function offIcon() {
  const NS = 'http://www.w3.org/2000/svg';
  const make = (tag, attrs) => {
    const el = document.createElementNS(NS, tag);
    for (const k in attrs) el.setAttribute(k, attrs[k]);
    return el;
  };
  const svg = make('svg', { viewBox: '0 0 24 24', width: '16', height: '16', fill: 'none', stroke: 'currentColor', 'stroke-width': '1.7', 'stroke-linecap': 'round', 'stroke-linejoin': 'round', 'aria-hidden': 'true' });
  svg.append(
    make('rect', { x: '2.5', y: '4', width: '19', height: '13', rx: '2' }),
    make('path', { d: 'M8.5 20.5h7M12 17v3.5' }),
    make('path', { d: 'M7.5 7.5h9v5h-5l-2.2 1.9v-1.9H7.5z', fill: 'currentColor', stroke: 'none' }),
    make('path', { d: 'M3 2.5l18 19', 'stroke-width': '2' })
  );
  const badge = document.createElement('span');
  badge.className = 'meet-button';
  badge.appendChild(svg);
  return badge;
}

function showStatus() {
  const el = $('status');
  if (overlayRunning === false) {
    el.textContent = 'オーバーレイが起動していません（start-mac.command / start-windows.bat）';
    el.className = 'off';
  } else if (paused) {
    el.replaceChildren('表示オフ（Meet右下の ', offIcon(), ' でオン）');
    el.className = 'paused';
  } else if (overlayRunning) {
    el.textContent = '表示オン';
    el.className = 'ok';
  }
}

chrome.storage.local.get({ paused: false }).then((v) => {
  paused = !!v.paused;
  showStatus();
});
chrome.storage.onChanged.addListener((changes) => {
  if (!changes.paused) return;
  paused = !!changes.paused.newValue;
  showStatus();
});

call('/screens')
  .then((data) => {
    overlayRunning = true;
    showStatus();
    renderScreens(data);
  })
  .catch(() => {
    overlayRunning = false;
    showStatus();
  });
