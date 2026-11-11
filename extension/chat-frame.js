// Runs inside the chat.google.com iframe that Meet (with Google Chat-based in-call chat) uses for
// its chat panel. Only active when that iframe sits inside meet.google.com.
//
// Self-diagnosis: a message containing "#nicotest" sends the structure around it to the overlay
// (GET http://127.0.0.1:39393/diag), so the selectors below can be fixed when Chat changes.
(() => {
  if (window.top === window) return;
  const ancestors = location.ancestorOrigins ? Array.from(location.ancestorOrigins) : [];
  if (!ancestors.includes('https://meet.google.com')) return;

  const TAG = 'meet-comment-overlay';
  const startedAt = Date.now();

  function send(events) {
    try {
      chrome.runtime.sendMessage({ type: TAG, kind: 'events', events }, () => void chrome.runtime.lastError);
    } catch (e) {
      // extension reloaded; the Meet tab needs a reload
    }
  }

  function isIconFont(el) {
    try {
      const fam = (getComputedStyle(el).fontFamily || '').toLowerCase();
      return fam.includes('material') || fam.includes('icon') || fam.includes('symbols');
    } catch (e) {
      return false;
    }
  }

  function textOf(el) {
    const parts = [];
    const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT | NodeFilter.SHOW_ELEMENT);
    for (let n = walker.nextNode(); n; n = walker.nextNode()) {
      if (n.nodeType === Node.ELEMENT_NODE) {
        if (n.tagName === 'IMG' && !n.closest('button, [role="button"]')) {
          const alt = (n.getAttribute('alt') || n.getAttribute('aria-label') || '').trim();
          if (alt && alt.length <= 16 && /\p{Extended_Pictographic}/u.test(alt)) parts.push(alt);
        }
        continue;
      }
      const p = n.parentElement;
      if (!p || p.closest('button, [role="button"], [aria-hidden="true"], style, script') || isIconFont(p)) continue;
      const t = n.nodeValue.trim();
      if (t) parts.push(t);
    }
    return parts.join(' ').replace(/\s+/g, ' ').trim();
  }

  // ---------------------------------------------------------------- messages
  // Google Chat markup (seen in Meet, Nov 2026):
  //   c-wiz[data-topic-id][data-local-sort-time-msec]      one thread, with its time
  //     div[role=group][data-id][data-user-id]             one message
  //       div[jsname=bgckF][id="<message id>/qJTHM"]       the message text
  const MESSAGE = '[data-id][data-user-id]';
  // Only the id suffix identifies the message body; jsname="bgckF" is also used for other text
  // (it produced the sender's name instead of the message).
  const TEXT = ['[id$="/qJTHM"]'];
  const RECENT_MS = 20 * 1000;
  const seen = new Set();
  let rejectedReports = 0;

  function messageText(el) {
    for (const sel of TEXT) {
      const t = el.querySelector(sel);
      if (t && t.closest(MESSAGE) === el) return textOf(t);
    }
    return '';
  }

  function sentAt(el) {
    const topic = el.closest('[data-local-sort-time-msec]');
    const v = topic ? Number(topic.getAttribute('data-local-sort-time-msec')) : NaN;
    return Number.isFinite(v) && v > 0 ? v : null;
  }

  function scan() {
    // Go by the text elements themselves (id "<message id>/qJTHM"): each one is exactly one
    // message, however Chat groups messages from the same sender.
    const fresh = [];
    const texts = document.querySelectorAll(TEXT.join(','));
    for (const t of texts) {
      const id = t.id || '';
      if (!id || seen.has(id) || t.closest('[contenteditable="true"], [role="textbox"]')) continue;
      const text = textOf(t);
      if (!text) continue; // still being drawn; the next change brings us back
      seen.add(id);
      fresh.push({ id, text, at: sentAt(t) });
    }
    if (!fresh.length) return;
    const now = Date.now();
    // Only messages written just now flow; anything older is history that Chat draws late
    // (opening the panel, scrolling, re-rendering). This also holds for the very first message:
    // Meet may only load this frame when it arrives. Without a readable time, a single message
    // at the very end of the list counts as new once the frame has settled.
    const settled = now - startedAt > 2000;
    const lastId = texts.length ? texts[texts.length - 1].id : null;
    const batch = fresh.filter((m) => (m.at !== null ? Math.abs(now - m.at) < RECENT_MS : settled && fresh.length === 1 && m.id === lastId));
    if (batch.length < fresh.length && rejectedReports < 5) {
      rejectedReports++;
      send([{ type: 'diag', report: { reason: 'chat-frame-rejected', now, sinceStart: now - startedAt, fresh: fresh.filter((m) => !batch.includes(m)).slice(0, 8).map((m) => ({ text: m.text.slice(0, 30), at: m.at, age: m.at === null ? null : now - m.at })) } }]);
    }
    if (batch.length) send(batch.map((m) => ({ type: 'comment', text: m.text, source: 'chat-frame' })));
  }

  // ---------------------------------------------------------------- diagnosis

  const MARKER = '#nicotest';
  let lastDiagnosis = 0;

  function describe(el) {
    const attrs = {};
    for (const a of el.attributes || []) {
      if (/^(data-|aria-|role$|jsname$|jscontroller$|jsmodel$|id$|class$|dir$|tabindex$)/.test(a.name)) attrs[a.name] = String(a.value).slice(0, 80);
    }
    const out = { tag: el.tagName.toLowerCase(), attrs };
    if (el.childElementCount === 0) out.text = (el.textContent || '').trim().slice(0, 60);
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
    if (Date.now() - lastDiagnosis < 3000) return;
    const text = node.nodeType === Node.TEXT_NODE ? node.nodeValue : node.textContent;
    if (!text || text.indexOf(MARKER) < 0) return;
    const el = node.nodeType === Node.TEXT_NODE ? node.parentElement : node;
    if (!el || el.closest('textarea, input, [contenteditable="true"], [role="textbox"]')) return;
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
    for (let p = target, i = 0; p && i < 20; p = p.parentElement, i++) chain.push(describe(p));
    // The list the message sits in: the nearest ancestor with several similar children.
    let list = target;
    for (let i = 0; i < 14 && list.parentElement; i++) {
      list = list.parentElement;
      if (list.childElementCount >= 3) break;
    }
    const kids = Array.from(list.children);
    const report = {
      reason: 'chat-frame-marker',
      url: location.origin + location.pathname,
      ancestors: chain,
      listChildren: kids.slice(-6).map((k) => outline(k, 6, { left: 60 })),
      messageSelectorHits: document.querySelectorAll(MESSAGE).length,
      textOfMarkerMessage: (() => {
        const m = target.closest(MESSAGE);
        return m ? messageText(m) : null;
      })(),
    };
    send([{ type: 'diag', report }]);
  }

  // ---------------------------------------------------------------- wiring

  let timer = 0;
  new MutationObserver((records) => {
    for (const r of records) {
      if (r.type === 'characterData') checkForMarker(r.target);
      for (const n of r.addedNodes) {
        if (n.nodeType === Node.ELEMENT_NODE || n.nodeType === Node.TEXT_NODE) checkForMarker(n);
      }
    }
    if (!timer) {
      timer = setTimeout(() => {
        timer = 0;
        try {
          scan();
        } catch (e) {}
      }, 150);
    }
  }).observe(document.documentElement, { childList: true, subtree: true, characterData: true });
  send([{ type: 'diag', report: { reason: 'chat-frame-loaded', url: location.origin + location.pathname, messages: document.querySelectorAll(TEXT.join(',')).length, readyState: document.readyState } }]);
  scan();
})();
