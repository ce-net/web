// ce-cast config — the ONE place the UI learns where the media relay lives.
//
// The app is hosted on the CE hub (https://ce-net.com/apps/cast-<id>/ or a subdomain),
// which is a DIFFERENT origin from the media relay. So the relay base is NEVER
// location.origin — it is configurable and defaults to the public relay.
//
// Override precedence (highest first):
//   1. ?relay=https://host         (query param; persisted for next time)
//   2. localStorage ce_cast_relay  (sticky, set by #1 or the settings field)
//   3. CE_CAST_DEFAULT_RELAY       (build-time default below)
//
// Self-hosting your own relay? Just open the app with ?relay=https://your-relay once.

(function () {
  const CE_CAST_DEFAULT_RELAY = 'https://cast.ce-net.com';
  const clean = (s) => String(s || '').replace(/\/+$/, '');

  const q = new URLSearchParams(location.search).get('relay');
  if (q) localStorage.setItem('ce_cast_relay', clean(q));

  window.CE_CAST = {
    relayBase() { return clean(localStorage.getItem('ce_cast_relay') || CE_CAST_DEFAULT_RELAY); },
    setRelay(url) { localStorage.setItem('ce_cast_relay', clean(url)); },
    // Basic-auth header for the relay. The publish key is the "cast-ingest" secret DELIVERED by
    // ce-auth to this device (window.CE_AUTH), held in memory for the session — never pasted, never
    // stored. authHeader() is sync, so it uses the already-cached key; pages call
    // CE_AUTH.getPublishKey() to fetch+cache it before publishing.
    // The publish key is the vault secret `ce-cast-publish`, delivered same-origin by secrets.js
    // (window.CE_VAULT.refreshKey) into localStorage.ce_cast_key — the same slot the old pages used.
    // Falls back to a ce-auth-delivered key if present. Held in localStorage, never rendered.
    authHeader() { const k = (localStorage.getItem('ce_cast_key') || (window.CE_AUTH && window.CE_AUTH.cachedKey && window.CE_AUTH.cachedKey()) || '').trim(); return k ? { Authorization: 'Basic ' + btoa('leif:' + k) } : {}; },
  };
})();
