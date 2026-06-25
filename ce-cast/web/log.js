// ce-log — ship this tab's console + errors + fetch failures to the CE hub so they can be read
// remotely (e.g. debugging a phone from a laptop). Drop-in: load it FIRST, before any other
// script, so it captures early module-load and fetch errors too.
//
// Where it ships: /db/celog-<app-prefix>/<key>  on the hub. Read it with:
//   curl 'https://ce-net.com/db/celog-<prefix>?prefix=&limit=200'
//
// "Authenticated" for now = an app-scoped namespace + every entry tagged with the vault device
// id, session, and user-agent (so lines are attributable). Hardening note: derive the namespace
// from a SHA-256 of the publish key so only key-holders can find/write it (left as a follow-up;
// the error logs here are low-sensitivity and ephemeral — the hub evicts oldest keys).
(function () {
  var prefix = (location.host.match(/^cast-([0-9a-f]{6,})\./) || location.pathname.match(/\/apps\/cast-([0-9a-f]{6,})\//) || [])[1] || 'unknown';
  var NS = 'celog-' + prefix;
  var HUB = 'https://ce-net.com';
  var session = Math.random().toString(36).slice(2, 8);
  var seq = 0, queue = [], timer = null, flushing = false;

  function deviceId() { try { var d = JSON.parse(localStorage.getItem('ce_vault_device') || 'null'); return d && d.id || '-'; } catch (e) { return '-'; } }
  function fmt(x) {
    try {
      if (typeof x === 'string') return x;
      if (x instanceof Error) return x.name + ': ' + x.message + (x.stack ? '\n' + x.stack : '');
      return JSON.stringify(x);
    } catch (e) { return String(x); }
  }
  function key() { return String(Date.now()) + '-' + session + '-' + String(seq++).padStart(5, '0'); }

  function schedule() { if (!timer) timer = setTimeout(flush, 500); }
  function flush() {
    timer = null;
    if (!queue.length || flushing) return;
    flushing = true;
    var batch = queue.splice(0, 40);
    var body = JSON.stringify({ t: new Date().toISOString(), dev: deviceId(), session: session, ua: navigator.userAgent, url: location.href, lines: batch });
    fetch(HUB + '/db/' + NS + '/' + key(), { method: 'PUT', headers: { 'Content-Type': 'application/json' }, keepalive: true, body: body })
      .catch(function () {})   // never loop on our own failure
      .then(function () { flushing = false; if (queue.length) schedule(); });
  }
  function rec(level, args) {
    try { queue.push({ l: level, ts: Date.now(), m: Array.prototype.map.call(args, fmt).join(' ') }); schedule(); } catch (e) {}
  }

  // console capture
  ['log', 'info', 'warn', 'error', 'debug'].forEach(function (k) {
    var orig = console[k] ? console[k].bind(console) : function () {};
    console[k] = function () { orig.apply(null, arguments); rec(k, arguments); };
  });
  // uncaught errors + promise rejections
  window.addEventListener('error', function (e) { rec('error', ['window.onerror:', e.message, (e.filename || '') + ':' + (e.lineno || 0) + ':' + (e.colno || 0), (e.error && e.error.stack) || '']); });
  window.addEventListener('unhandledrejection', function (e) { rec('error', ['unhandledrejection:', fmt(e.reason)]); });

  // fetch wrapper — this is what reveals the "Load failed" culprit (which URL, what error).
  var of = window.fetch;
  window.fetch = function () {
    var u = arguments[0], url; try { url = (u && u.url) || String(u); } catch (e) { url = '?'; }
    var method = (arguments[1] && arguments[1].method) || 'GET';
    return of.apply(this, arguments).then(function (r) {
      if (!r.ok) rec('warn', ['fetch ' + method + ' ' + url + ' -> ' + r.status]);
      return r;
    }, function (err) {
      rec('error', ['fetch FAILED ' + method + ' ' + url + ' -> ' + fmt(err)]);
      throw err;
    });
  };

  window.CE_LOG = { ns: NS, session: session, note: function (m) { rec('info', [m]); }, flush: flush };
  rec('info', ['ce-log up', location.href, navigator.userAgent]);
  window.addEventListener('pagehide', flush);
})();
