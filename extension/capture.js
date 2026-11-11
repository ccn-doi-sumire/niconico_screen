// Runs inside the Google Meet page (MAIN world, document_start).
// Picks up chat messages and reactions and hands them to bridge.js, which sends them to the
// desktop overlay. Meet changes its markup without notice: everything that depends on what the
// page looks like is in the "chat" and "reactions (page)" sections below.
//
// Debugging: in DevTools on the Meet tab run
//   localStorage.setItem('meetCommentOverlay.debug', '1')   // then reload: logs what is detected
//   __meetCommentOverlay.dump()                              // prints what the page currently shows
(() => {
  if (window.__meetCommentOverlay) return;

  const TAG = 'meet-comment-overlay';
  const startedAt = Date.now();
  const store = (() => {
    try {
      return window.localStorage;
    } catch (e) {
      return null;
    }
  })();
  const flag = (name, fallback) => {
    try {
      const v = store && store.getItem('meetCommentOverlay.' + name);
      return v === null || v === undefined ? fallback : v === '1';
    } catch (e) {
      return fallback;
    }
  };
  const settings = {
    debug: flag('debug', false),
    chat: flag('chat', true),
    reactions: flag('reactions', true),
    pageReactions: flag('pageReactions', true), // fallback: reactions found in the page markup
  };
  const log = (...args) => {
    if (settings.debug) console.log('%c[MeetCommentOverlay]', 'color:#1a73e8', ...args);
  };

  const state = {
    paused: (() => {
      try {
        return sessionStorage.getItem('meetCommentOverlay.paused') === '1';
      } catch (e) {
        return false;
      }
    })(),
    connected: null, // null = unknown, true/false after the overlay answered
    overlayPaused: false,
    error: '',
    sent: { comments: 0, reactions: 0 },
    lastDataChannelReaction: 0,
    channelLabels: new Set(),
  };

  // ---------------------------------------------------------------- transport

  const queue = [];
  let flushQueued = false;

  function emit(evt) {
    if (state.paused) return;
    queue.push(evt);
    if (!flushQueued) {
      flushQueued = true;
      queueMicrotask(flush);
    }
  }

  function flush() {
    flushQueued = false;
    const events = queue.splice(0);
    if (!events.length) return;
    for (const e of events) {
      if (e.type === 'comment') state.sent.comments++;
      else state.sent.reactions++;
    }
    log('send', events);
    window.postMessage({ source: TAG, kind: 'events', events }, location.origin);
    renderChip();
  }

  function ping() {
    window.postMessage({ source: TAG, kind: 'ping' }, location.origin);
  }

  window.addEventListener('message', (e) => {
    if (e.source !== window || !e.data || e.data.source !== TAG + ':bridge') return;
    if (e.data.kind !== 'status') return;
    state.connected = !!e.data.ok;
    state.overlayPaused = !!e.data.paused;
    state.error = e.data.ok ? '' : e.data.error || '';
    renderChip();
  });

  // ---------------------------------------------------------------- helpers

  const EMOJI_SEQ = /\p{Extended_Pictographic}(?:️|\p{Emoji_Modifier}|‍\p{Extended_Pictographic}️?)*/gu;

  /** Emoji sequences in `text`, ignoring symbols such as ©, ® and ™ that are also "pictographic". */
  function emojisIn(text) {
    const out = [];
    for (const m of String(text || '').matchAll(EMOJI_SEQ)) {
      if (m[0].codePointAt(0) >= 0x2600) out.push(m[0]);
    }
    return out;
  }

  /** The emoji when `text` is exactly one emoji (spaces allowed), otherwise null. */
  function singleEmoji(text) {
    const t = String(text || '').trim();
    if (!t || t.length > 16) return null;
    const found = emojisIn(t);
    return found.length === 1 && found[0] === t.replace(/\s+/g, '') ? found[0] : null;
  }

  // Meet's emoji images: https://fonts.gstatic.com/s/e/notoemoji/<ver>/1f44f/512.webp, .../emoji_u1f44f.png
  const EMOJI_URL = [/\/notoemoji\/[^/]+\/([0-9a-f]{2,6}(?:[_-][0-9a-f]{2,6})*)\//i, /emoji_u([0-9a-f]{2,6}(?:[_-][0-9a-f]{2,6})*)\./i];

  function emojiFromUrl(url) {
    for (const re of EMOJI_URL) {
      const m = re.exec(url || '');
      if (!m) continue;
      try {
        return String.fromCodePoint(...m[1].split(/[_-]/).map((h) => parseInt(h, 16)));
      } catch (e) {
        return null;
      }
    }
    return null;
  }

  function isIconFont(el) {
    try {
      const fam = (getComputedStyle(el).fontFamily || '').toLowerCase();
      return fam.includes('material') || fam.includes('icon') || fam.includes('symbols');
    } catch (e) {
      return false;
    }
  }

  const SKIP_TEXT = 'button, [role="button"], [aria-hidden="true"], style, script, template';

  /** Visible text of `el` in reading order, with emoji images turned back into emoji. */
  function textOf(el) {
    const parts = [];
    const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT | NodeFilter.SHOW_ELEMENT);
    for (let n = walker.nextNode(); n; n = walker.nextNode()) {
      if (n.nodeType === Node.ELEMENT_NODE) {
        if (n.tagName === 'IMG' && !n.closest(SKIP_TEXT)) {
          const e = singleEmoji(n.getAttribute('alt')) || emojiFromUrl(n.getAttribute('src'));
          if (e) parts.push(e);
        }
        continue;
      }
      const p = n.parentElement;
      if (!p || p.closest(SKIP_TEXT) || isIconFont(p)) continue;
      const t = n.nodeValue.trim();
      if (t) parts.push(t);
    }
    return parts.join(' ').replace(/\s+/g, ' ').trim();
  }

  // ---------------------------------------------------------------- chat (page)
  // Meet tags each chat message with data-message-id, but only draws messages while the chat
  // panel is open. Sender and time sit in a header above a group of messages.

  const TIME = /^(?:(午前|午後)\s*)?(\d{1,2})[:：.](\d{2})(?:\s*([AaPp])\.?\s*[Mm]\.?)?$/;
  const seenMessages = new Set();

  function parseTime(text, now) {
    const m = TIME.exec(String(text || '').trim());
    if (!m) return null;
    let h = Number(m[2]);
    const min = Number(m[3]);
    if (m[1] || m[4]) {
      if (h < 1 || h > 12) return null;
      h = (h % 12) + (m[1] === '午後' || /p/i.test(m[4] || '') ? 12 : 0);
    }
    if (h > 23 || min > 59) return null;
    const d = new Date(now);
    d.setHours(h, min, 0, 0);
    let at = d.getTime();
    if (at - now > 60000) at -= 24 * 60 * 60 * 1000;
    return at;
  }

  function chatHeader(msg) {
    let el = msg.parentElement;
    for (let depth = 0; el && depth < 6; depth++, el = el.parentElement) {
      const tagged = el.getAttribute('data-sender-name');
      const labels = [];
      const walker = document.createTreeWalker(el, NodeFilter.SHOW_ELEMENT);
      for (let e = walker.nextNode(); e && labels.length < 4; e = walker.nextNode()) {
        if (e.childElementCount > 0 || e.closest('[data-message-id]') || e.closest(SKIP_TEXT)) continue;
        const t = (e.textContent || '').trim();
        if (t && t.length <= 80 && !isIconFont(e)) labels.push(t);
      }
      if (!tagged && !labels.length) continue;
      const time = labels.find((t) => TIME.test(t)) || null;
      const sender = tagged || labels.find((t) => !TIME.test(t)) || '';
      return { sender, time };
    }
    return { sender: '', time: null };
  }

  function topLevelMessages() {
    const out = [];
    for (const el of document.querySelectorAll('[data-message-id]')) {
      // A message nested in another tagged element is the same message drawn twice.
      if (el.parentElement && el.parentElement.closest('[data-message-id]')) continue;
      out.push(el);
    }
    return out;
  }

  function scanChat() {
    if (!settings.chat) return;
    const fresh = [];
    for (const el of topLevelMessages()) {
      const id = el.getAttribute('data-message-id');
      if (!id || seenMessages.has(id)) continue;
      const text = textOf(el);
      if (!text) continue; // not filled in yet; the next mutation will bring us back
      seenMessages.add(id);
      fresh.push({ id, text, ...chatHeader(el) });
    }
    if (!fresh.length) return;

    // Opening the panel redraws the whole history. Only flow what was written in the last few
    // minutes; without a readable time, treat a large batch as history.
    const now = Date.now();
    const recent = [];
    let untimed = 0;
    for (const m of fresh) {
      const at = parseTime(m.time, now);
      if (at === null) untimed++;
      if (at === null || now - at < 3 * 60 * 1000) recent.push(Object.assign(m, { at }));
    }
    const out = untimed > 3 ? recent.filter((m) => m.at !== null) : recent;
    log('chat', { found: fresh, flowing: out });
    for (const m of out) emit({ type: 'comment', text: m.text, author: m.sender || '', source: 'panel' });
  }

  // Meet with Google Chat-based chat draws the panel in a chat.google.com iframe (see
  // chat-frame.js). Meet itself still shows a notification for each new message:
  // [data-key="notification-N"] > ... [role=button] > (avatar img, sender, text, reply icon).
  const seenNotifications = new Map(); // data-key -> text already sent

  function leafTexts(el) {
    const out = [];
    const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
    for (let n = walker.nextNode(); n; n = walker.nextNode()) {
      const p = n.parentElement;
      if (!p || p.closest('[aria-hidden="true"], style, script') || isIconFont(p)) continue;
      const t = n.nodeValue.trim();
      if (t) out.push(t);
    }
    return out;
  }

  const skippedNotifications = new Set();

  function scanNotifications() {
    const notes = document.querySelectorAll('[data-key^="notification-"]');
    for (const note of notes) {
      // Chat notifications carry a "reply" (keyboard_return) icon; join/leave/hand notices do not.
      const icons = [...note.querySelectorAll('i, [class*="symbols"], [class*="icon"]')].map((i) => (i.textContent || '').trim());
      const box = note.querySelector('[role="button"]') || note;
      const texts = leafTexts(box);
      if (!icons.includes('keyboard_return') || texts.length < 2) {
        // Not recognised as a chat message: report what it looks like (GET /diag on the overlay).
        const key = note.getAttribute('data-key');
        if (texts.length && !skippedNotifications.has(key) && skippedNotifications.size < 8) {
          skippedNotifications.add(key);
          const report = { reason: 'notification-skipped', icons, texts: texts.slice(0, 6), dom: outline(note, 9, { left: 60 }) };
          window.postMessage({ source: TAG, kind: 'events', events: [{ type: 'diag', report }] }, location.origin);
        }
        continue;
      }
      const sender = texts[0];
      const text = texts.slice(1).join(' ');
      const key = note.getAttribute('data-key');
      if (seenNotifications.get(key) === text) continue;
      seenNotifications.set(key, text);
      if (seenNotifications.size > 200) seenNotifications.delete(seenNotifications.keys().next().value);
      log('chat (notification)', sender, text);
      emit({ type: 'comment', text, author: sender, source: 'notification' });
    }
  }

  let chatTimer = 0;
  let lastChatScan = 0;
  function scheduleChatScan() {
    if (chatTimer) return;
    const wait = Math.max(0, 120 - (Date.now() - lastChatScan));
    chatTimer = setTimeout(() => {
      chatTimer = 0;
      lastChatScan = Date.now();
      try {
        scanChat();
      } catch (e) {
        log('chat scan failed', e);
      }
      try {
        if (settings.chat) scanNotifications();
      } catch (e) {
        log('notification scan failed', e);
      }
    }, wait);
  }

  // ---------------------------------------------------------------- reactions (shared)

  const recentReactions = []; // { emoji, at, source }

  function emitReaction(emoji, source, count) {
    if (!settings.reactions || !emoji) return;
    const now = Date.now();
    while (recentReactions.length && now - recentReactions[0].at > 3000) recentReactions.shift();
    // The same reaction can show up through both sources, or twice in the page (stream + tile).
    const sameSourceGap = source === 'page' ? 700 : 0;
    const dup = recentReactions.find(
      (r) => r.emoji === emoji && ((r.source !== source && now - r.at < 1500) || (r.source === source && now - r.at < sameSourceGap))
    );
    if (dup) {
      log('reaction skipped (duplicate)', emoji, source);
      return;
    }
    recentReactions.push({ emoji, at: now, source });
    log('reaction', emoji, source, count || 1);
    emit(count > 1 ? { type: 'reaction', emoji, count } : { type: 'reaction', emoji });
  }

  // ---------------------------------------------------------------- reactions (data channel)
  // Meet sends reactions over an RTCDataChannel labelled "reactions" as (often gzipped) protobuf.
  // We do not need the schema: the emoji travels as a UTF-8 string, so we decode the bytes,
  // inflate any gzip blocks found inside, and look for emoji.

  const decoder = new TextDecoder('utf-8', { fatal: false });
  const tapped = new WeakSet();
  const reactionChannels = new WeakSet();

  function channelLabel(ch) {
    try {
      return String(ch.label || '');
    } catch (e) {
      return '';
    }
  }

  function tap(ch) {
    if (!ch || tapped.has(ch)) return;
    tapped.add(ch);
    const label = channelLabel(ch);
    if (!state.channelLabels.has(label)) {
      state.channelLabels.add(label);
      log('data channel', JSON.stringify(label));
    }
    if (!/reaction/i.test(label)) return;
    reactionChannels.add(ch);
    ch.addEventListener('message', (e) => {
      handleReactionPayload(e.data, 'in').catch((err) => log('reaction decode failed', err));
    });
  }

  function toBytes(data) {
    if (data instanceof ArrayBuffer) return Promise.resolve(new Uint8Array(data.slice(0)));
    if (ArrayBuffer.isView(data)) return Promise.resolve(new Uint8Array(data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength)));
    if (typeof Blob !== 'undefined' && data instanceof Blob) return data.arrayBuffer().then((b) => new Uint8Array(b));
    if (typeof data === 'string') return Promise.resolve(new TextEncoder().encode(data));
    return Promise.resolve(null);
  }

  function readVarint(b, i) {
    let x = 0;
    let shift = 0;
    for (;;) {
      if (i >= b.length || shift > 63) return null;
      const byte = b[i++];
      x += (byte & 0x7f) * 2 ** shift;
      shift += 7;
      if (!(byte & 0x80)) return [x, i];
    }
  }

  /** Length-delimited fields of a protobuf message, or null if `b` is not one. */
  function protoChunks(b) {
    const out = [];
    let i = 0;
    while (i < b.length) {
      const key = readVarint(b, i);
      if (!key || key[0] < 8) return null;
      i = key[1];
      const wire = key[0] & 7;
      if (wire === 0) {
        const v = readVarint(b, i);
        if (!v) return null;
        i = v[1];
      } else if (wire === 1) i += 8;
      else if (wire === 5) i += 4;
      else if (wire === 2) {
        const len = readVarint(b, i);
        if (!len || len[1] + len[0] > b.length) return null;
        out.push(b.subarray(len[1], len[1] + len[0]));
        i = len[1] + len[0];
      } else return null;
    }
    return i === b.length ? out : null;
  }

  function findGzip(b, depth, out) {
    if (depth > 6 || b.length < 18) return out;
    if (b[0] === 0x1f && b[1] === 0x8b && b[2] === 0x08) {
      out.push(b);
      return out;
    }
    const chunks = protoChunks(b);
    if (chunks) {
      for (const c of chunks) findGzip(c, depth + 1, out);
    } else if (depth === 0) {
      // Not protobuf at the top: look for a gzip header anywhere.
      for (let i = 1; i < b.length - 18; i++) {
        if (b[i] === 0x1f && b[i + 1] === 0x8b && b[i + 2] === 0x08) {
          out.push(b.subarray(i));
          break;
        }
      }
    }
    return out;
  }

  async function gunzip(bytes) {
    if (typeof DecompressionStream === 'undefined') return null;
    const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip'));
    const reader = stream.getReader();
    const parts = [];
    let total = 0;
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        parts.push(value);
        total += value.length;
        if (total > 1 << 20) break;
      }
    } catch (e) {
      // trailing bytes after the gzip stream: keep what was inflated
    }
    if (!total) return null;
    const out = new Uint8Array(total);
    let o = 0;
    for (const p of parts) {
      out.set(p, o);
      o += p.length;
    }
    return out;
  }

  /** Fields of a protobuf message as { no, wire, value } (value: number or bytes), or null. */
  function protoFields(b) {
    const out = [];
    let i = 0;
    while (i < b.length) {
      const key = readVarint(b, i);
      if (!key || key[0] < 8) return null;
      i = key[1];
      const no = Math.floor(key[0] / 8);
      const wire = key[0] & 7;
      if (wire === 0) {
        const v = readVarint(b, i);
        if (!v) return null;
        out.push({ no, wire, value: v[0] });
        i = v[1];
      } else if (wire === 1) i += 8;
      else if (wire === 5) i += 4;
      else if (wire === 2) {
        const len = readVarint(b, i);
        if (!len || len[1] + len[0] > b.length) return null;
        out.push({ no, wire, value: b.subarray(len[1], len[1] + len[0]) });
        i = len[1] + len[0];
      } else return null;
    }
    return i === b.length ? out : null;
  }

  /**
   * Reactions in a message. Meet's reaction block is { 1: "👏", 2: count }: when someone taps
   * quickly the server merges taps and sends count 2, 3, ... Gzipped parts are inflated first.
   */
  async function reactionEntries(bytes, depth, out) {
    if (depth > 8 || bytes.length < 2) return out;
    if (bytes[0] === 0x1f && bytes[1] === 0x8b) {
      const inflated = await gunzip(bytes);
      if (inflated) await reactionEntries(inflated, depth + 1, out);
      return out;
    }
    const fields = protoFields(bytes);
    if (!fields) return out;
    const emojiFields = fields
      .filter((f) => f.wire === 2 && f.value.length <= 40)
      .map((f) => singleEmoji(decoder.decode(f.value)))
      .filter(Boolean);
    if (emojiFields.length > 1) return out; // a list of emoji (e.g. the picker), not a reaction
    const ownCount = () => {
      const c = fields.find((g) => g.wire === 0 && g.no === 2);
      return c ? Math.max(1, Math.min(50, c.value)) : null;
    };
    if (emojiFields.length === 1) {
      out.push({ emoji: emojiFields[0], count: ownCount() }); // null: the count sits one level up
      return out; // this block is one reaction
    }
    for (const f of fields) {
      if (f.wire !== 2) continue;
      const before = out.length;
      await reactionEntries(f.value, depth + 1, out);
      // Live layout: { 1: { 1: "👏" }, 2: count, 4: device, 6: user } - the count is a sibling
      // of the block that holds the emoji.
      if (out.length === before + 1 && out[before].count === null && f.no === 1) out[before].count = ownCount();
    }
    return out;
  }

  async function textsIn(bytes, depth, out) {
    out.push(decoder.decode(bytes));
    if (depth >= 3) return out;
    for (const gz of findGzip(bytes, 0, [])) {
      const inflated = await gunzip(gz);
      if (inflated) await textsIn(inflated, depth + 1, out);
    }
    return out;
  }

  // A few raw messages, sent to the overlay once for diagnosis (see GET /diag on the overlay).

  function printable(text) {
    return text.replace(/[\x00-\x1f\x7f\ufffd]/g, (c) => (c === '\ufffd' ? '?' : '\\x' + c.charCodeAt(0).toString(16).padStart(2, '0'))).slice(0, 500);
  }

  // Timeline of what the data channel carried and what Meet itself drew, sent to the overlay
  // 10 s after reaction activity starts (GET /diag), to compare the two.
  const timeline = [];
  let timelineReports = 0;
  let timelineTimer = 0;

  function note(entry) {
    if (timelineReports >= 3) return;
    entry.t = Math.round(performance.now());
    timeline.push(entry);
    if (timelineTimer) return;
    timelineTimer = setTimeout(() => {
      timelineTimer = 0;
      timelineReports++;
      const items = timeline.splice(0);
      const sum = (dir) => items.filter((i) => i.dir === dir).reduce((n, i) => n + (i.count || 1), 0);
      const report = {
        reason: 'reaction-timeline',
        totals: { in: sum('in'), out: sum('out'), dom: sum('dom'), emitted: sum('emit') },
        hidden: document.hidden,
        items: items.slice(0, 150),
      };
      log('reaction timeline', report);
      window.postMessage({ source: TAG, kind: 'events', events: [{ type: 'diag', report }] }, location.origin);
    }, 10000);
  }

  function recordPayload(direction, bytes, texts, found) {
    note({ dir: direction, raw: true, count: 0, bytes: bytes.length, emoji: found.join(''), tail: printable(texts[texts.length - 1]).slice(0, 150) });
  }

  // Every reaction Meet draws: <img aria-label="👏"> about 43 px wide, with a name label next to it.
  function noteDomReactions(node) {
    if (timelineReports >= 3 || !node.querySelectorAll) return;
    const imgs = node.tagName === 'IMG' ? [node] : node.querySelectorAll('img[aria-label]');
    for (const img of imgs) {
      const emoji = singleEmoji(img.getAttribute('aria-label'));
      if (!emoji || img.closest(NOT_A_REACTION)) continue;
      const w = img.getBoundingClientRect().width;
      if (w && w < 30) continue;
      const holder = img.closest('span') || img.parentElement;
      note({ dir: 'dom', emoji, who: ((holder && holder.textContent) || '').trim().slice(0, 12), w: Math.round(w) });
    }
  }

  async function handleReactionPayload(data, direction) {
    const bytes = await toBytes(data);
    if (!bytes || !bytes.length) return;
    const texts = await textsIn(bytes, 0, []);
    const found = texts.flatMap(emojisIn);
    recordPayload(direction, bytes, texts, found);
    // A message with many different emoji is a list (e.g. the reaction picker's set), not a reaction.
    if (new Set(found).size > 4) return;
    const counts = new Map();
    const entries = await reactionEntries(bytes, 0, []);
    if (entries.length) {
      for (const r of entries) counts.set(r.emoji, (counts.get(r.emoji) || 0) + (r.count || 1));
    } else {
      // Unknown layout: fall back to counting the emoji found anywhere in the message.
      for (const e of found) counts.set(e, (counts.get(e) || 0) + 1);
    }
    log('reactions channel', direction, bytes.length + ' bytes', Object.fromEntries(counts));
    if (!counts.size || counts.size > 4) return;
    const now = Date.now();
    state.lastDataChannelReaction = now;
    for (const [emoji, total] of counts) {
      // The server does not echo our own reactions back (only a short acknowledgement), so
      // incoming and outgoing messages are simply both counted.
      const n = Math.min(total, 50);
      note({ dir: direction, emoji, count: total });
      if (n > 0) {
        note({ dir: 'emit', emoji, count: n });
        emitReaction(emoji, 'channel', n);
      }
    }
    armReactionMeasure();
  }

  function hookWebRTC() {
    const PC = window.RTCPeerConnection;
    const DC = window.RTCDataChannel;
    if (!PC || !PC.prototype) return;

    const create = PC.prototype.createDataChannel;
    if (typeof create === 'function') {
      PC.prototype.createDataChannel = function (...args) {
        const ch = create.apply(this, args);
        try {
          tap(ch);
        } catch (e) {}
        return ch;
      };
    }

    // Channels opened by the other side arrive as "datachannel" events.
    const Wrapped = new Proxy(PC, {
      construct(target, args, newTarget) {
        const pc = Reflect.construct(target, args, newTarget);
        try {
          pc.addEventListener('datachannel', (e) => tap(e.channel));
        } catch (e) {}
        return pc;
      },
    });
    window.RTCPeerConnection = Wrapped;
    if (window.webkitRTCPeerConnection === PC) window.webkitRTCPeerConnection = Wrapped;

    // Your own reactions go out through send(); the server may not echo them back.
    if (DC && DC.prototype && typeof DC.prototype.send === 'function') {
      const send = DC.prototype.send;
      DC.prototype.send = function (data) {
        try {
          tap(this);
          if (reactionChannels.has(this)) {
            handleReactionPayload(data, 'out').catch((err) => log('reaction decode failed', err));
          }
        } catch (e) {}
        return send.call(this, data);
      };
    }
  }

  // ---------------------------------------------------------------- reactions (page)
  // Fallback when the data channel yields nothing: emoji images that appear outside buttons,
  // menus and the chat. Off while the data channel is producing reactions.

  const NOT_A_REACTION = [
    'button', '[role="button"]', '[role="menu"]', '[role="menuitem"]', '[role="menuitemradio"]',
    '[role="toolbar"]', '[role="listbox"]', '[role="option"]', '[role="dialog"]', '[role="tooltip"]',
    '[role="textbox"]', '[contenteditable="true"]', 'textarea', 'input', '[data-message-id]', '#meet-comment-overlay-chip',
  ].join(',');

  function checkAddedForReactions(node) {
    if (!settings.reactions || !settings.pageReactions) return;
    if (Date.now() - startedAt < 8000) return; // Meet preloads images while it starts
    if (Date.now() - state.lastDataChannelReaction < 10 * 60 * 1000) return;
    const imgs = node.tagName === 'IMG' ? [node] : node.getElementsByTagName ? node.getElementsByTagName('img') : [];
    for (let i = 0; i < imgs.length && i < 20; i++) {
      const img = imgs[i];
      const emoji =
        singleEmoji(img.getAttribute('alt')) ||
        singleEmoji(img.getAttribute('aria-label')) ||
        singleEmoji(img.getAttribute('data-emoji')) ||
        emojiFromUrl(img.getAttribute('src') || '');
      if (!emoji) continue;
      const box = img.getBoundingClientRect();
      if (box.width && box.width < 24) continue; // the small badge on a participant tile
      if (img.closest(NOT_A_REACTION)) {
        log('emoji image ignored (control)', emoji, img);
        continue;
      }
      emitReaction(emoji, 'page');
    }
  }

  // ---------------------------------------------------------------- status chip

  let chip = null; // the toggle button next to Meet's chat button (bottom right)
  let chipIcon = null;
  let chipDot = null;
  const SVG = 'http://www.w3.org/2000/svg';

  function inMeeting() {
    return /^\/(?:meet\/)?[a-z]{3}-[a-z]{4}-[a-z]{3}(?:$|[/?])/.test(location.pathname);
  }

  function svg(tag, attrs) {
    const el = document.createElementNS(SVG, tag);
    for (const k in attrs) el.setAttribute(k, attrs[k]);
    return el;
  }

  // A screen with a speech bubble on it; a slash is added while hidden.
  function buildIcon() {
    const icon = svg('svg', { viewBox: '0 0 24 24', width: '24', height: '24', fill: 'none', stroke: 'currentColor', 'stroke-width': '1.7', 'stroke-linecap': 'round', 'stroke-linejoin': 'round' });
    icon.append(
      svg('rect', { x: '2.5', y: '4', width: '19', height: '13', rx: '2' }),
      svg('path', { d: 'M8.5 20.5h7M12 17v3.5' }),
      svg('path', { d: 'M7.5 7.5h9v5h-5l-2.2 1.9v-1.9H7.5z', fill: 'currentColor', stroke: 'none' }),
      svg('path', { d: 'M3 2.5l18 19', 'data-slash': '1', 'stroke-width': '2' })
    );
    return icon;
  }

  function setPaused(value) {
    state.paused = value;
    try {
      sessionStorage.setItem('meetCommentOverlay.paused', value ? '1' : '0');
    } catch (e) {}
    // background.js also drops events from the chat frame while hidden
    window.postMessage({ source: TAG, kind: 'pause', value }, location.origin);
    renderChip();
  }

  let chipMode = ''; // 'pill': inside Meet's bottom-right group; 'floating': fixed, as a fallback
  let chipHover = false;
  let nativeColor = '#e3e3e3';
  let pillReported = false;

  /** Meet's round buttons in the bottom-right corner, left to right. */
  function cornerButtons() {
    const W = window.innerWidth;
    const H = window.innerHeight;
    const out = [];
    for (const el of document.querySelectorAll('button, [role="button"]')) {
      if (el === chip || el.parentElement.closest('button, [role="button"]')) continue;
      const rect = el.getBoundingClientRect();
      if (rect.width < 24 || rect.width > 80 || rect.height < 24 || rect.bottom < H - 110 || rect.top > H || rect.left < W * 0.62) continue;
      out.push({ el, rect });
    }
    return out.sort((x, y) => x.rect.left - y.rect.left);
  }

  /** The rounded group that holds chat, activities, ...: what the two rightmost buttons share. */
  function findPill(buttons) {
    if (buttons.length < 2) return null;
    const last = buttons[buttons.length - 1].el;
    const other = buttons[buttons.length - 2].el;
    let p = last.parentElement;
    while (p && !p.contains(other)) p = p.parentElement;
    if (!p || p === document.body || p === document.documentElement) return null;
    const r = p.getBoundingClientRect();
    if (r.width > 460 || r.height > 96 || r.left < window.innerWidth * 0.5) return null; // not a small group
    return p;
  }

  /** Puts the button first in Meet's bottom-right group; floats next to it when there is none. */
  function placeChip() {
    const buttons = cornerButtons();
    const pill = findPill(buttons);
    if (pill) {
      const first = buttons.find((b) => pill.contains(b.el));
      const second = buttons.find((b) => b !== first && pill.contains(b.el));
      let item = first.el; // the group's own child that holds the first button
      while (item.parentElement !== pill) item = item.parentElement;
      const itemRect = item.getBoundingClientRect();
      const inset = Math.max(0, first.rect.left - itemRect.left); // space the wrapper adds around a button
      const cssGap = parseFloat(getComputedStyle(pill).columnGap) || 0;
      const spacing = second ? Math.max(0, second.rect.left - first.rect.right) : 0; // button to button
      nativeColor = getComputedStyle(first.el).color || nativeColor;
      if (chipMode !== 'pill') {
        chipMode = 'pill';
        chip.style.position = 'relative';
        chip.style.left = chip.style.top = chip.style.right = chip.style.bottom = 'auto';
        chip.style.zIndex = 'auto';
        chip.style.display = 'inline-flex';
        chip.style.flex = '0 0 auto';
        chip.style.alignSelf = 'center';
        chip.style.verticalAlign = 'middle';
      }
      chip.style.width = Math.round(first.rect.width) + 'px';
      chip.style.height = Math.round(first.rect.height) + 'px';
      chip.style.marginLeft = Math.round(inset + (parseFloat(getComputedStyle(item).marginLeft) || 0)) + 'px';
      chip.style.marginRight = Math.max(0, Math.round(spacing - cssGap - inset)) + 'px';
      if (chip.parentElement !== pill || pill.firstElementChild !== chip) pill.insertBefore(chip, pill.firstElementChild);
      if (!pillReported) {
        pillReported = true;
        const r = pill.getBoundingClientRect();
        const report = {
          reason: 'pill',
          rect: [Math.round(r.left), Math.round(r.top), Math.round(r.width), Math.round(r.height)],
          display: getComputedStyle(pill).display,
          gap: cssGap,
          inset,
          spacing,
          button: [Math.round(first.rect.width), Math.round(first.rect.height)],
          dom: outline(pill, 4, { left: 40 }),
        };
        window.postMessage({ source: TAG, kind: 'events', events: [{ type: 'diag', report }] }, location.origin);
      }
      return;
    }
    if (chipMode !== 'floating') {
      chipMode = 'floating';
      chip.style.position = 'fixed';
      chip.style.zIndex = '2147483646';
      chip.style.display = 'flex';
      chip.style.width = chip.style.height = '48px';
      chip.style.margin = '0';
    }
    if (chip.parentElement !== document.body) document.body.appendChild(chip);
    const anchor = buttons[0];
    if (anchor) {
      chip.style.left = Math.max(8, Math.round(anchor.rect.left - 48 - 14)) + 'px';
      chip.style.top = Math.round(anchor.rect.top + anchor.rect.height / 2 - 24) + 'px';
      chip.style.right = chip.style.bottom = 'auto';
    } else {
      chip.style.left = chip.style.top = 'auto';
      chip.style.right = '16px';
      chip.style.bottom = '96px';
    }
  }

  function ensureChip() {
    if (!document.body) return;
    if (!inMeeting()) {
      if (chip) chip.remove();
      return;
    }
    if (!chip) {
      chip = document.createElement('button');
      chip.id = 'meet-comment-overlay-chip';
      chip.type = 'button';
      chip.style.cssText = [
        'padding:0', 'border:0', 'border-radius:50%', 'align-items:center', 'justify-content:center',
        'cursor:pointer', 'transition:background-color .15s', 'box-sizing:border-box',
      ].join(';');
      chipIcon = buildIcon();
      chipDot = document.createElement('span');
      chipDot.style.cssText = 'position:absolute;right:6px;top:6px;width:9px;height:9px;border-radius:50%;border:2px solid #202124;display:none';
      chip.append(chipIcon, chipDot);
      chip.addEventListener('click', () => setPaused(!state.paused));
      chip.addEventListener('mouseenter', () => { chipHover = true; renderChip(); });
      chip.addEventListener('mouseleave', () => { chipHover = false; renderChip(); });
      window.addEventListener('resize', () => chip && inMeeting() && placeChip());
      window.postMessage({ source: TAG, kind: 'pause', value: state.paused }, location.origin); // sync after a reload
    }
    placeChip();
    renderChip();
  }

  function renderChip() {
    if (!chip) return;
    const on = !state.paused;
    if (chipMode === 'pill') {
      // Inside Meet's group: a plain icon like its neighbours, tinted while on.
      chip.style.backgroundColor = chipHover ? 'rgba(232, 234, 237, 0.1)' : 'transparent';
      chip.style.color = on ? '#a8c7fa' : nativeColor;
    } else {
      // Floating: a round button like Meet's own toggles, tinted while on.
      chip.style.backgroundColor = on ? '#a8c7fa' : '#333537';
      chip.style.color = on ? '#062e6f' : '#e3e3e3';
    }
    chipIcon.querySelector('[data-slash]').style.display = on ? 'none' : '';
    let status = 'オーバーレイを確認中';
    let dot = '';
    if (state.connected === true) status = state.overlayPaused ? 'オーバーレイ側で一時停止中' : 'コメントを画面に流せます';
    else if (state.connected === false) {
      status = state.error === 'reload' ? '拡張が更新されました。このタブを再読み込みしてください' : 'オーバーレイが起動していません';
      dot = '#ea4335';
    }
    if (state.connected === true && state.overlayPaused) dot = '#fbbc04';
    chipDot.style.display = dot ? 'block' : 'none';
    chipDot.style.backgroundColor = dot;
    const label = (on ? 'コメントを画面に流す: オン（クリックで非表示）' : 'コメントを画面に流す: オフ（クリックで表示）') +
      `\n${status} / コメント ${state.sent.comments}・リアクション ${state.sent.reactions}`;
    chip.title = label;
    chip.setAttribute('aria-label', label.replace('\n', ' '));
    chip.setAttribute('aria-pressed', String(on));
  }

  // ---------------------------------------------------------------- wiring

  function start() {
    const mo = new MutationObserver((records) => {
      let chatChanged = false;
      for (const r of records) {
        if (r.type === 'characterData') {
          chatChanged = true;
          checkForMarker(r.target);
          continue;
        }
        for (const n of r.addedNodes) {
          if (n.nodeType === Node.TEXT_NODE) {
            checkForMarker(n);
            continue;
          }
          if (n.nodeType !== Node.ELEMENT_NODE) continue;
          chatChanged = true;
          checkForMarker(n);
          noteAdded(n);
          noteDomReactions(n);
          try {
            checkAddedForReactions(n);
          } catch (e) {
            log('reaction check failed', e);
          }
        }
      }
      if (chatChanged) scheduleChatScan();
    });
    mo.observe(document.documentElement, { childList: true, subtree: true, characterData: true });

    const tick = () => {
      ensureChip();
      if (inMeeting()) ping();
    };
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', tick, { once: true });
    else tick();
    setInterval(tick, 5000);
    setInterval(() => {
      if (!chip || !inMeeting()) return;
      placeChip(); // Meet redraws its toolbar now and then; put the button back if it was dropped
      renderChip();
    }, 1000);
  }

  // ---------------------------------------------------------------- self-diagnosis
  // Send a chat message containing "#nicotest": the page structure around where it shows up is
  // sent to the overlay (which logs it), so a changed Meet layout can be fixed without DevTools.

  const MARKER = '#nicotest';
  let lastDiagnosis = 0;

  function describe(el) {
    const attrs = {};
    for (const a of el.attributes || []) {
      if (/^(data-|aria-|role$|jsname$|jscontroller$|id$|class$|dir$|tabindex$)/.test(a.name)) attrs[a.name] = String(a.value).slice(0, 80);
    }
    const out = { tag: el.tagName.toLowerCase(), attrs };
    if (el.childElementCount === 0) out.text = (el.textContent || '').trim().slice(0, 60);
    if (el.shadowRoot) out.shadowRoot = true;
    return out;
  }

  function outline(el, depth, budget) {
    const node = describe(el);
    if (depth > 0 && el.childElementCount && budget.left > 0) {
      node.children = [];
      for (const c of el.children) {
        if (budget.left-- <= 0) break;
        node.children.push(outline(c, depth - 1, budget));
      }
    }
    return node;
  }

  function checkForMarker(node) {
    try {
      if (Date.now() - lastDiagnosis < 3000) return;
      const text = node.nodeType === Node.TEXT_NODE ? node.nodeValue : node.textContent;
      if (!text || text.indexOf(MARKER) < 0) return;
      const el = node.nodeType === Node.TEXT_NODE ? node.parentElement : node;
      if (!el || el.closest('textarea, input, [contenteditable="true"], [role="textbox"]')) return; // the box being typed in
      // The deepest element that holds the marker text.
      let target = el;
      for (let found = true; found; ) {
        found = false;
        for (const c of target.children) {
          if ((c.textContent || '').indexOf(MARKER) >= 0) {
            target = c;
            found = true;
            break;
          }
        }
      }
      lastDiagnosis = Date.now();
      const chain = [];
      for (let p = target, i = 0; p && i < 16; p = p.parentElement, i++) chain.push(describe(p));
      let group = target;
      for (let i = 0; i < 6 && group.parentElement; i++) group = group.parentElement;
      const sample = topLevelMessages().slice(-2).map((m) => ({ text: textOf(m), header: chatHeader(m), outline: outline(m, 4, { left: 40 }) }));
      const report = {
        reason: 'marker',
        url: location.pathname,
        ancestors: chain,
        around: outline(group, 7, { left: 120 }),
        dataMessageIds: topLevelMessages().length,
        sampleMessages: sample,
        iframes: [...document.querySelectorAll('iframe')].map((f) => (f.getAttribute('src') || '').replace(/[?#].*$/, '').slice(0, 120)),
        settings,
        sent: state.sent,
      };
      log('diagnosis', report);
      window.postMessage({ source: TAG, kind: 'events', events: [{ type: 'diag', report }] }, location.origin);
    } catch (e) {
      log('diagnosis failed', e);
    }
  }

  // Measures how Meet animates its own reaction (size, path, opacity over time) so the overlay
  // can match it. Armed right after a reaction arrives; reports the first few to the overlay.
  let measureArmedUntil = 0;
  let measuring = false;
  let measurementsSent = 0;

  const recentVisuals = []; // elements with an image added in the last moments: Meet may draw the
  //                            reaction before or after our decoding of the data channel finishes.

  function noteAdded(node) {
    if (measurementsSent >= 3 || !node.querySelector) return;
    if (Date.now() < measureArmedUntil) {
      considerForMeasure(node, false);
      return;
    }
    if (node.matches('img, canvas, svg') || node.querySelector('img, canvas, svg')) {
      recentVisuals.push({ node, at: Date.now() });
      while (recentVisuals.length > 30) recentVisuals.shift();
    }
  }

  function armReactionMeasure() {
    if (measurementsSent >= 3 || measuring) return;
    const now = Date.now();
    for (const c of recentVisuals) {
      if (now - c.at < 800 && c.node.isConnected) considerForMeasure(c.node, true);
      if (measuring) return;
    }
    measureArmedUntil = now + 1500;
  }

  function effectiveOpacity(el) {
    let o = 1;
    for (let p = el, i = 0; p && i < 8; p = p.parentElement, i++) {
      const v = parseFloat(getComputedStyle(p).opacity);
      if (Number.isFinite(v)) o *= v;
    }
    return Math.round(o * 100) / 100;
  }

  function considerForMeasure(node, force) {
    if (measuring || (!force && Date.now() > measureArmedUntil) || !node.querySelector) return;
    if (node.closest(NOT_A_REACTION) || node.closest('#meet-comment-overlay-chip')) return;
    const visual = node.matches('img, canvas, svg') ? node : node.querySelector('img, canvas, svg');
    if (!visual || visual.closest(NOT_A_REACTION)) return;
    measuring = true;
    measureArmedUntil = 0;
    const samples = [];
    const t0 = performance.now();
    const timer = setInterval(() => {
      const t = Math.round(performance.now() - t0);
      if (!visual.isConnected || t > 12000) {
        clearInterval(timer);
        measuring = false;
        measurementsSent++;
        const report = {
          reason: 'reaction-measure',
          viewport: [window.innerWidth, window.innerHeight],
          visual: describe(visual),
          dom: outline(node, 5, { left: 40 }),
          columns: ['ms', 'left', 'top', 'width', 'height', 'opacity'],
          samples,
        };
        log('reaction measured', report);
        window.postMessage({ source: TAG, kind: 'events', events: [{ type: 'diag', report }] }, location.origin);
        return;
      }
      const r = visual.getBoundingClientRect();
      samples.push([t, Math.round(r.left), Math.round(r.top), Math.round(r.width), Math.round(r.height), effectiveOpacity(visual)]);
    }, 100);
  }

  // ---------------------------------------------------------------- debugging aid

  function dump() {
    const msgs = topLevelMessages().slice(-5).map((el) => ({
      id: el.getAttribute('data-message-id'),
      text: textOf(el),
      header: chatHeader(el),
      el,
    }));
    const emojiImgs = [...document.getElementsByTagName('img')]
      .map((img) => ({ emoji: singleEmoji(img.getAttribute('alt')) || emojiFromUrl(img.getAttribute('src') || ''), img }))
      .filter((x) => x.emoji)
      .map((x) => ({ emoji: x.emoji, control: !!x.img.closest(NOT_A_REACTION), src: x.img.getAttribute('src'), el: x.img }));
    const report = {
      settings,
      paused: state.paused,
      connected: state.connected,
      sent: state.sent,
      dataChannels: [...state.channelLabels],
      lastDataChannelReaction: state.lastDataChannelReaction ? new Date(state.lastDataChannelReaction).toLocaleTimeString() : null,
      chatMessagesInPage: topLevelMessages().length,
      lastMessages: msgs,
      emojiImages: emojiImgs.slice(0, 30),
    };
    console.log(report);
    return report;
  }

  window.__meetCommentOverlay = {
    dump,
    settings,
    test(text) {
      emit({ type: 'comment', text: text || 'テストコメント' });
      emit({ type: 'reaction', emoji: '👏' });
    },
    // exposed for tests
    _internals: { emojisIn, singleEmoji, emojiFromUrl, parseTime, protoChunks, textsIn, handleReactionPayload, textOf, chatHeader },
  };

  try {
    hookWebRTC();
  } catch (e) {
    log('WebRTC hook failed', e);
  }
  start();
  log('started', settings);
})();
