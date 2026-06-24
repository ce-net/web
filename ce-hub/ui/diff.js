/* diff.js — render a unified diff into the dark ce-net diff view.
 * Handles two response shapes from /commit/:sha and /compare/:base/:head:
 *   1) { files: [ { path, old_path?, additions, deletions, patch } ], ... }
 *   2) { diff: "<raw unified diff text>" }  or a bare string.
 * Falls back to parsing raw unified-diff text per-file. */
(function (global) {
  "use strict";

  function esc(s) {
    return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  }

  // Parse a single file's unified patch body (the part after the @@ hunks begin,
  // or including ---/+++ headers) into rows.
  function renderHunks(patch) {
    var lines = String(patch).split("\n");
    var rows = "";
    var oldNo = 0, newNo = 0;
    for (var i = 0; i < lines.length; i++) {
      var ln = lines[i];
      if (/^diff --git /.test(ln) || /^index /.test(ln) ||
          /^--- /.test(ln) || /^\+\+\+ /.test(ln) ||
          /^new file/.test(ln) || /^deleted file/.test(ln) ||
          /^similarity /.test(ln) || /^rename /.test(ln) ||
          /^old mode/.test(ln) || /^new mode/.test(ln)) {
        continue;
      }
      var hm = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@(.*)$/.exec(ln);
      if (hm) {
        oldNo = parseInt(hm[1], 10);
        newNo = parseInt(hm[2], 10);
        rows += '<tr class="hdr"><td class="gut"></td><td class="gut"></td><td class="txt">' + esc(ln) + "</td></tr>";
        continue;
      }
      var cls = "", lg = "", rg = "";
      if (ln[0] === "+") { cls = "add"; rg = newNo++; }
      else if (ln[0] === "-") { cls = "del"; lg = oldNo++; }
      else if (ln[0] === "\\") { rows += '<tr><td class="gut"></td><td class="gut"></td><td class="txt faint">' + esc(ln) + "</td></tr>"; continue; }
      else { lg = oldNo++; rg = newNo++; }
      rows += '<tr class="' + cls + '"><td class="gut">' + lg + '</td><td class="gut">' + rg +
        '</td><td class="txt">' + esc(ln) + "</td></tr>";
    }
    return '<div class="hunk"><table>' + rows + "</table></div>";
  }

  function fileBlock(path, oldPath, adds, dels, patch) {
    var title = oldPath && oldPath !== path ? esc(oldPath) + " → " + esc(path) : esc(path);
    var stat = "";
    if (adds != null || dels != null) {
      stat = '<span class="stat"><span class="add">+' + (adds || 0) + '</span> <span class="del">-' + (dels || 0) + "</span></span>";
    }
    return '<div class="fh"><span class="path mono">' + title + "</span>" + stat + "</div>" + renderHunks(patch || "");
  }

  // Split a raw unified diff string into per-file chunks.
  function splitRaw(raw) {
    var parts = [];
    var lines = raw.split("\n");
    var cur = null;
    function startFile(path) { cur = { path: path, patch: "" }; parts.push(cur); }
    for (var i = 0; i < lines.length; i++) {
      var ln = lines[i];
      var dm = /^diff --git a\/(.+?) b\/(.+)$/.exec(ln);
      if (dm) { startFile(dm[2]); cur.patch += ln + "\n"; continue; }
      if (!cur) { startFile("(diff)"); }
      var pm = /^\+\+\+ b\/(.+)$/.exec(ln);
      if (pm && cur) cur.path = pm[1];
      cur.patch += ln + "\n";
    }
    return parts;
  }

  function countStat(patch) {
    var a = 0, d = 0;
    String(patch).split("\n").forEach(function (l) {
      if (/^\+[^+]/.test(l) || l === "+") a++;
      else if (/^-[^-]/.test(l) || l === "-") d++;
    });
    return { a: a, d: d };
  }

  var Diff = {
    /* data: response from /commit or /compare. Returns an HTML string. */
    render: function (data) {
      var files = null;
      if (data && Array.isArray(data.files)) files = data.files;

      if (files) {
        if (!files.length) return '<div class="empty">No file changes.</div>';
        var html = '<div class="diff">';
        files.forEach(function (f) {
          html += fileBlock(f.path || f.new_path || f.filename, f.old_path || f.previous_filename,
            f.additions != null ? f.additions : (f.patch ? countStat(f.patch).a : null),
            f.deletions != null ? f.deletions : (f.patch ? countStat(f.patch).d : null),
            f.patch || f.diff || "");
        });
        return html + "</div>";
      }

      var raw = typeof data === "string" ? data : (data && (data.diff || data.patch));
      if (raw) {
        var chunks = splitRaw(raw);
        if (!chunks.length) return '<div class="empty">No file changes.</div>';
        var out = '<div class="diff">';
        chunks.forEach(function (c) {
          var st = countStat(c.patch);
          out += fileBlock(c.path, null, st.a, st.d, c.patch);
        });
        return out + "</div>";
      }

      return '<div class="empty">No diff available.</div>';
    }
  };

  global.Diff = Diff;
})(window);
