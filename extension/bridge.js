// Runs in the extension's isolated world. capture.js (page world) cannot use chrome.* APIs,
// so it posts events here and this script hands them to the service worker.
(() => {
  const TAG = 'meet-comment-overlay';

  function reply(payload) {
    window.postMessage(Object.assign({ source: TAG + ':bridge' }, payload), location.origin);
  }

  window.addEventListener('message', (e) => {
    if (e.source !== window || e.origin !== location.origin) return;
    const d = e.data;
    if (!d || d.source !== TAG) return;
    if (d.kind === 'pause') {
      try {
        chrome.runtime.sendMessage({ type: TAG, kind: 'pause', value: !!d.value }, () => void chrome.runtime.lastError);
      } catch (err) {}
      return;
    }
    if (d.kind !== 'events' && d.kind !== 'ping') return;
    try {
      chrome.runtime.sendMessage({ type: TAG, kind: d.kind, events: d.events }, (res) => {
        const err = chrome.runtime.lastError;
        reply({
          kind: 'status',
          ok: !err && !!(res && res.ok),
          paused: !!(res && res.paused),
          error: err ? err.message : res && res.error,
        });
      });
    } catch (err) {
      // The extension was reloaded or removed; this tab needs a reload.
      reply({ kind: 'status', ok: false, error: 'reload', detail: String(err) });
    }
  });
})();
