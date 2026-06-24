/* highlight.js — tiny, dependency-free syntax highlighter.
 * Not a full lexer; a pragmatic regex tokenizer good enough for code browsing.
 * Supports a broad "c-like" family plus python/shell/markup heuristics.
 * Exposes window.Highlighter.highlight(code, lang) -> escaped HTML with <span class="tk-*">. */
(function (global) {
  "use strict";

  function esc(s) {
    return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  }

  var KEYWORDS = {
    clike: "abstract async await break case catch class const continue default delete do else enum export extends false final finally for fn function if impl import in instanceof interface let loop match mod move mut new null pub return self static struct super switch this throw trait true try type typeof use var void while where yield as ref dyn unsafe crate extern macro_rules return",
    python: "and as assert async await break class continue def del elif else except False finally for from global if import in is lambda None nonlocal not or pass raise return True try while with yield self",
    shell: "if then else elif fi for in do done while case esac function return export local readonly set unset echo cd exit source"
  };

  function langFamily(lang) {
    lang = (lang || "").toLowerCase();
    if (/^(py|python)$/.test(lang)) return "python";
    if (/^(sh|bash|zsh|shell)$/.test(lang)) return "shell";
    if (/^(md|markdown)$/.test(lang)) return "markup";
    if (/^(json)$/.test(lang)) return "json";
    if (/^(html|xml|svg)$/.test(lang)) return "html";
    if (/^(css|scss)$/.test(lang)) return "css";
    return "clike";
  }

  function langFromName(name) {
    var m = /\.([a-z0-9]+)$/i.exec(name || "");
    var ext = m ? m[1].toLowerCase() : "";
    var map = {
      rs: "rust", js: "js", mjs: "js", ts: "ts", tsx: "ts", jsx: "js", go: "go",
      c: "c", h: "c", cpp: "cpp", cc: "cpp", hpp: "cpp", java: "java", kt: "kotlin",
      py: "python", rb: "ruby", php: "php", sh: "shell", bash: "shell", zsh: "shell",
      json: "json", toml: "toml", yaml: "yaml", yml: "yaml", md: "markdown",
      html: "html", htm: "html", xml: "xml", svg: "svg", css: "css", scss: "css",
      sql: "sql", lua: "lua", swift: "swift"
    };
    return map[ext] || "";
  }

  // Generic tokenizer for the c-like / json / shell / python families.
  function highlightGeneric(code, fam) {
    var kw = KEYWORDS[fam] || KEYWORDS.clike;
    var kwSet = {};
    kw.split(/\s+/).forEach(function (w) { kwSet[w] = 1; });

    var out = "";
    var i = 0, n = code.length;
    var lineCommentTok = fam === "python" || fam === "shell" ? "#" : "//";

    function push(cls, text) {
      out += '<span class="tk-' + cls + '">' + esc(text) + "</span>";
    }

    while (i < n) {
      var c = code[i];

      // line comment
      if (code.startsWith(lineCommentTok, i)) {
        var j = code.indexOf("\n", i); if (j < 0) j = n;
        push("com", code.slice(i, j)); i = j; continue;
      }
      // block comment /* */ (c-like only)
      if (fam !== "python" && fam !== "shell" && code.startsWith("/*", i)) {
        var k = code.indexOf("*/", i + 2); k = k < 0 ? n : k + 2;
        push("com", code.slice(i, k)); i = k; continue;
      }
      // strings " ' `
      if (c === '"' || c === "'" || c === "`") {
        var q = c, s = i + 1, str = c;
        while (s < n) {
          if (code[s] === "\\") { str += code.slice(s, s + 2); s += 2; continue; }
          str += code[s];
          if (code[s] === q) { s++; break; }
          s++;
        }
        push("str", str); i = s; continue;
      }
      // numbers
      if (/[0-9]/.test(c) || (c === "." && /[0-9]/.test(code[i + 1] || ""))) {
        var m = /^(0x[0-9a-fA-F_]+|0b[01_]+|[0-9][0-9_]*\.?[0-9_]*([eE][-+]?[0-9]+)?[a-zA-Z]*)/.exec(code.slice(i));
        if (m) { push("num", m[0]); i += m[0].length; continue; }
      }
      // identifiers / keywords / function calls
      if (/[A-Za-z_$@]/.test(c)) {
        var im = /^[A-Za-z_$@][A-Za-z0-9_$]*/.exec(code.slice(i));
        var word = im[0];
        var rest = code.slice(i + word.length).replace(/^\s*/, "");
        if (kwSet[word]) push("key", word);
        else if (rest[0] === "(") push("fn", word);
        else if (/^[A-Z]/.test(word)) push("ty", word);
        else out += esc(word);
        i += word.length; continue;
      }
      // punctuation
      if (/[{}()\[\];,.:<>=+\-*/%&|!?^~]/.test(c)) { push("pun", c); i++; continue; }

      out += esc(c); i++;
    }
    return out;
  }

  // Minimal markup highlighter (html/xml/svg).
  function highlightMarkup(code) {
    return esc(code)
      .replace(/(&lt;\/?[a-zA-Z][\w:-]*)/g, '<span class="tk-key">$1</span>')
      .replace(/([a-zA-Z-]+)(=)(&quot;.*?&quot;|".*?")/g,
        '<span class="tk-attr">$1</span>$2<span class="tk-str">$3</span>')
      .replace(/(&gt;)/g, '<span class="tk-key">$1</span>')
      .replace(/(&lt;!--[\s\S]*?--&gt;)/g, '<span class="tk-com">$1</span>');
  }

  function highlightCss(code) {
    return esc(code)
      .replace(/(\/\*[\s\S]*?\*\/)/g, '<span class="tk-com">$1</span>')
      .replace(/([.#]?[-\w]+)(\s*\{)/g, '<span class="tk-ty">$1</span>$2')
      .replace(/([-\w]+)(\s*:)/g, '<span class="tk-attr">$1</span>$2')
      .replace(/(:[^;{]+)(;)/g, '<span class="tk-str">$1</span>$2');
  }

  var Highlighter = {
    langFromName: langFromName,
    highlight: function (code, lang) {
      try {
        var fam = langFamily(lang);
        if (fam === "html") return highlightMarkup(code);
        if (fam === "css") return highlightCss(code);
        if (fam === "markup") return esc(code);
        return highlightGeneric(code, fam);
      } catch (_) {
        return esc(code);
      }
    },
    escape: esc
  };

  global.Highlighter = Highlighter;
})(window);
