/* api.js — thin client over the ce-hub git JSON API (see PLAN/hub-git-contract.md).
 * The UI is served from the same origin as the API (hub.ce-net.com), so all paths
 * are origin-relative. Only the routes defined in the contract are used here. */
(function (global) {
  "use strict";

  // Same-origin by default. Override with ?api=https://host for local testing.
  var API_BASE = (function () {
    try {
      var p = new URLSearchParams(location.search).get("api");
      return p ? p.replace(/\/$/, "") : "";
    } catch (_) { return ""; }
  })();

  function url(path) { return API_BASE + path; }

  function enc(s) { return encodeURIComponent(s); }
  // Path segments that may contain slashes (the *path glob) must keep their slashes.
  function encPath(p) {
    return String(p || "").split("/").map(enc).join("/");
  }

  async function jget(path, opts) {
    var res = await fetch(url(path), Object.assign({ headers: { accept: "application/json" } }, opts || {}));
    if (!res.ok) {
      var txt = await res.text().catch(function () { return ""; });
      var err = new Error("HTTP " + res.status + (txt ? ": " + txt.slice(0, 200) : ""));
      err.status = res.status;
      throw err;
    }
    var ct = res.headers.get("content-type") || "";
    if (ct.indexOf("application/json") >= 0) return res.json();
    return res.text();
  }

  // Raw fetch for blob bytes (returns the Response so the caller can read text/blob/headers).
  async function rawget(path) {
    var res = await fetch(url(path));
    if (!res.ok) {
      var err = new Error("HTTP " + res.status);
      err.status = res.status;
      throw err;
    }
    return res;
  }

  var Api = {
    base: API_BASE,
    cloneUrl: function (owner, repo) {
      var origin = API_BASE || location.origin;
      return origin + "/git/" + owner + "/" + repo + ".git";
    },

    // ---- repo registry ----
    listRepos: function (q, page) {
      var qs = [];
      if (q) qs.push("q=" + enc(q));
      if (page) qs.push("page=" + enc(page));
      return jget("/repos" + (qs.length ? "?" + qs.join("&") : ""));
    },
    getRepo: function (owner, repo) {
      return jget("/repos/" + enc(owner) + "/" + enc(repo));
    },

    // ---- read API ----
    tree: function (owner, repo, ref, path) {
      return jget("/repos/" + enc(owner) + "/" + enc(repo) + "/tree/" + enc(ref) + "/" + encPath(path || ""));
    },
    // returns the raw Response (bytes + content-type)
    blobRaw: function (owner, repo, ref, path) {
      return rawget("/repos/" + enc(owner) + "/" + enc(repo) + "/blob/" + enc(ref) + "/" + encPath(path || ""));
    },
    blobUrl: function (owner, repo, ref, path) {
      return url("/repos/" + enc(owner) + "/" + enc(repo) + "/blob/" + enc(ref) + "/" + encPath(path || ""));
    },
    commits: function (owner, repo, ref, after, limit) {
      var qs = [];
      if (after) qs.push("after=" + enc(after));
      if (limit) qs.push("limit=" + enc(limit));
      return jget("/repos/" + enc(owner) + "/" + enc(repo) + "/commits/" + enc(ref) + (qs.length ? "?" + qs.join("&") : ""));
    },
    commit: function (owner, repo, sha) {
      return jget("/repos/" + enc(owner) + "/" + enc(repo) + "/commit/" + enc(sha));
    },
    compare: function (owner, repo, base, head) {
      return jget("/repos/" + enc(owner) + "/" + enc(repo) + "/compare/" + enc(base) + "/" + enc(head));
    },
    releases: function (owner, repo) {
      return jget("/repos/" + enc(owner) + "/" + enc(repo) + "/releases");
    },
    instances: function (owner, repo) {
      return jget("/repos/" + enc(owner) + "/" + enc(repo) + "/instances");
    },

    // ---- pull requests ----
    pulls: function (owner, repo) {
      return jget("/repos/" + enc(owner) + "/" + enc(repo) + "/pulls");
    },
    pull: function (owner, repo, n) {
      return jget("/repos/" + enc(owner) + "/" + enc(repo) + "/pulls/" + enc(n));
    },

    // ---- signed mutations (see sign.js) ----
    // The body string MUST be exactly what was hashed for the signature.
    signedPost: async function (path, bodyStr, headers) {
      var res = await fetch(url(path), {
        method: "POST",
        headers: Object.assign({ "content-type": "application/json" }, headers || {}),
        body: bodyStr
      });
      var txt = await res.text().catch(function () { return ""; });
      if (!res.ok) {
        var err = new Error("HTTP " + res.status + (txt ? ": " + txt.slice(0, 300) : ""));
        err.status = res.status;
        throw err;
      }
      try { return JSON.parse(txt); } catch (_) { return txt; }
    },

    createPullPath: function (owner, repo) { return "/repos/" + enc(owner) + "/" + enc(repo) + "/pulls"; },
    commentPath: function (owner, repo, n) { return "/repos/" + enc(owner) + "/" + enc(repo) + "/pulls/" + enc(n) + "/comments"; },
    mergePath: function (owner, repo, n) { return "/repos/" + enc(owner) + "/" + enc(repo) + "/pulls/" + enc(n) + "/merge"; },

    // ---- realtime PR room (existing /rt rooms) ----
    // Returns an EventSource if the server exposes SSE for the room, else null.
    rtRoom: function (owner, repo, n) {
      var room = "repo:" + owner + "/" + repo + ":pr:" + n;
      return "/rt/ce-hub/" + enc(room);
    }
  };

  global.Api = Api;
})(window);
