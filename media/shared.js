/* Shared plumbing for the one-webview StarBit panel.
   - acquires the VS Code API exactly once
   - namespaces each deck's messages with `via`
   - flips between the terminal deck and the Claude deck */
(function () {
  const api = acquireVsCodeApi();
  const handlers = {};
  let deck = document.body.dataset.deck === 'claude' ? 'claude' : 'term';

  function showDeck(name, notify) {
    deck = name === 'claude' ? 'claude' : 'term';
    document.querySelectorAll('.deck').forEach((d) => d.classList.toggle('active', d.dataset.deck === deck));
    document.querySelectorAll('.switch-key').forEach((k) => k.classList.toggle('on', k.dataset.deck === deck));
    if (notify !== false) api.postMessage({ type: 'deck', deck });
    window.dispatchEvent(new CustomEvent('starbit:deck', { detail: deck }));
  }

  window.StarBit = {
    /** A postMessage facade that stamps every message with the deck name. */
    client(via) {
      return { postMessage: (m) => api.postMessage({ ...m, via }) };
    },
    /** Register an inbound handler. Messages without `via` reach every handler.
        A channel can have several (the Claude deck's terminal rail listens on 'term' too). */
    on(via, fn) {
      (handlers[via] = handlers[via] || []).push(fn);
    },
    showDeck,
    /** A dropped `file:` URI → a local path ('' if it will not decode). Handles file:///C:/x on Windows. */
    fileUriPath(uri) {
      try {
        return decodeURIComponent(String(uri).replace(/^file:\/\/[^/]*/, '')).replace(/^\/(?=[A-Za-z]:)/, '');
      } catch {
        return '';
      }
    },
    get deck() {
      return deck;
    }
  };

  window.addEventListener('message', (event) => {
    const msg = event.data;
    if (!msg || typeof msg !== 'object') return;
    if (msg.type === 'showDeck') return showDeck(msg.deck, false);
    if (msg.via) {
      for (const h of handlers[msg.via] || []) h(msg);
      return;
    }
    for (const k in handlers) for (const h of handlers[k]) h(msg);
  });

  document.querySelectorAll('.switch-key').forEach((k) => {
    k.addEventListener('click', () => showDeck(k.dataset.deck));
  });

  showDeck(deck, false);
})();
