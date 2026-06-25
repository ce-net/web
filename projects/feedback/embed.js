/* CE Feedback — drop-in widget. Shadow-DOM isolated, no dependencies, no emojis.
 *
 * Usage (auto): add this to any page:
 *   <script src="https://feedback.ce-net.com/embed.js"
 *           data-target="my-project" data-host="https://feedback.ce-net.com"></script>
 * A floating "Feedback" button appears bottom-right; clicking opens a panel.
 *
 * Usage (manual):
 *   import "https://feedback.ce-net.com/embed.js";
 *   CEFeedback.mount({ target:"my-project", host:"https://feedback.ce-net.com", el: someContainer });
 *
 * MESH-NATIVE EMBED MODEL
 * -----------------------
 * A feedback board is a CE mesh app: each board page talks ONLY to its OWN node
 * (the in-browser bridge window.__ceNode, else a same-origin "/ce" reverse proxy)
 * over /mesh/* + the per-app gossipsub db — never to ce-net.com/db, /rt, or any
 * other origin. That same-origin invariant cannot hold if a third-party host page
 * reaches across origins to the board's data plane. So the widget does NOT carry
 * its own db/realtime client; it mounts the already-mesh-native board page
 * (index.html) inside an ISOLATED iframe pointed at the board's own origin. The
 * board runs mesh-native inside that frame (same-origin to its node); the host
 * page only ever paints a floating button + a frame. No cross-origin data, no
 * WebSocket, no ce-net.com/db|/rt anywhere in this file.
 */
(function () {
  "use strict";
  if (window.CEFeedback && window.CEFeedback.__ready) return;

  function cleanTarget(t){ return String(t||"").toLowerCase().replace(/[^a-z0-9_-]/g,"").slice(0,48) || "global"; }

  var CSS = [
    ":host{all:initial}",
    "*{box-sizing:border-box;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif}",
    ".launch{position:fixed;right:18px;bottom:18px;z-index:2147483000;display:inline-flex;align-items:center;gap:8px;",
    "  border:0;border-radius:999px;padding:11px 16px;cursor:pointer;font-weight:700;font-size:14px;color:#021018;",
    "  background:linear-gradient(118deg,#2f6bff,#37c6ff 56%,#7af0e6);box-shadow:0 8px 26px rgba(3,8,20,.45);transition:transform .15s}",
    ".launch:hover{transform:translateY(-2px)}",
    ".launch svg{width:16px;height:16px}",
    ".panel{position:fixed;right:18px;bottom:74px;z-index:2147483000;width:min(380px,calc(100vw - 32px));height:min(640px,calc(100vh - 110px));",
    "  display:none;background:#070d18;border:1px solid rgba(116,176,255,.16);",
    "  border-radius:16px;box-shadow:0 18px 60px rgba(3,8,20,.6);overflow:hidden}",
    ".panel.open{display:block}",
    ".frame{width:100%;height:100%;border:0;display:block;background:#070d18}"
  ].join("");

  var CHAT_SVG = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15a2 2 0 0 1-2 2H8l-4 4V5a2 2 0 0 1 2-2h13a2 2 0 0 1 2 2z"/></svg>';

  function Widget(opts){
    var self = this;
    // The board's own origin. When the script tag carries no data-host, fall back
    // to the origin the script was loaded from, then to the current origin. The
    // board page reached here runs mesh-native and same-origin to its OWN node.
    this.host = (opts.host || originGuess()).replace(/\/+$/,"");
    this.target = cleanTarget(opts.target);
    this.loaded = false;

    var holder = document.createElement("div");
    var root = holder.attachShadow ? holder.attachShadow({ mode: "open" }) : holder;
    this.root = root;
    var style = document.createElement("style"); style.textContent = CSS; root.appendChild(style);

    var launch = document.createElement("button"); launch.className = "launch";
    launch.innerHTML = CHAT_SVG + "<span>Feedback</span>";
    root.appendChild(launch);

    var panel = document.createElement("div"); panel.className = "panel"; root.appendChild(panel);
    this.panel = panel;

    launch.addEventListener("click", function(){ self.toggle(); });

    (opts.el || document.body).appendChild(holder);
    this.holder = holder;
  }

  // Build the iframe lazily on first open so a closed widget costs nothing.
  Widget.prototype.ensureFrame = function(){
    if (this.loaded) return;
    this.loaded = true;
    var frame = document.createElement("iframe");
    frame.className = "frame";
    frame.setAttribute("title", "Feedback");
    // Sandbox: allow the board's scripts + same-origin (to its OWN node) only.
    frame.setAttribute("sandbox", "allow-scripts allow-same-origin allow-forms allow-popups");
    frame.setAttribute("loading", "lazy");
    frame.setAttribute("referrerpolicy", "no-referrer");
    frame.src = this.boardURL();
    this.panel.appendChild(frame);
    this.frame = frame;
  };

  Widget.prototype.boardURL = function(){
    var u = this.host + "/apps/feedback/";
    return u + "?target=" + encodeURIComponent(this.target) + "&embed=1";
  };

  Widget.prototype.toggle = function(force){
    var open = typeof force === "boolean" ? force : !this.panel.classList.contains("open");
    if (open) this.ensureFrame();
    this.panel.classList.toggle("open", open);
  };

  Widget.prototype.destroy = function(){
    if (this.holder && this.holder.parentNode) this.holder.parentNode.removeChild(this.holder);
  };

  function originGuess(){
    // Prefer the host the script tag was loaded from; else current origin.
    try {
      var s = document.currentScript;
      if (s && s.src){ var u = new URL(s.src); return u.origin; }
    } catch(_){}
    return location.origin;
  }

  function readScriptConfig(){
    try {
      var s = document.currentScript;
      if (!s) return null;
      var target = s.getAttribute("data-target") || s.getAttribute("data-project");
      var host = s.getAttribute("data-host");
      var auto = s.getAttribute("data-auto");
      if (target == null && auto == null) return null; // manual mode: caller will mount()
      return { target: target || "global", host: host || originGuess() };
    } catch(_){ return null; }
  }

  var API = {
    __ready: true,
    instances: [],
    mount: function(opts){ var w = new Widget(opts || {}); API.instances.push(w); return w; },
    destroyAll: function(){ API.instances.forEach(function(w){ w.destroy(); }); API.instances = []; }
  };
  window.CEFeedback = API;

  // Auto-mount if the script tag carries data-target / data-auto.
  var cfg = readScriptConfig();
  if (cfg){
    if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", function(){ API.mount(cfg); });
    else API.mount(cfg);
  }
})();
