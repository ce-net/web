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
 * The widget talks to the SAME mesh primitives as the standalone board:
 *   - durable: PUT/GET <host>/db/feedback/<key>
 *   - realtime: WS <host>/rt/feedback/t:<target>
 * so embedded posts and the full feedback.ce-net.com board share one thread per target.
 */
(function () {
  "use strict";
  if (window.CEFeedback && window.CEFeedback.__ready) return;

  var APP = "feedback", MAXLEN = 600, REPLY_MAX = 400, RATE_MS = 8000, LIMIT = 120;
  var COLORS = ["#37c6ff","#43e0a0","#ffd166","#ff5d72","#7af0e6","#3b82ff","#ff9d4d","#a78bfa","#7ef0bd","#ff8fa3"];
  var HIDE_THRESHOLD = 4;

  function cleanTarget(t){ return String(t||"").toLowerCase().replace(/[^a-z0-9_-]/g,"").slice(0,48) || "global"; }
  function colorFor(s){ var n=0,i,str=String(s); for(i=0;i<str.length;i++) n+=str.charCodeAt(i); return COLORS[n%COLORS.length]; }
  function invTs(t){ return (9999999999999 - t).toString().padStart(13,"0"); }
  function ago(t){ var s=Math.max(0,(Date.now()-t)/1000);
    if(s<60)return Math.floor(s)+"s"; if(s<3600)return Math.floor(s/60)+"m";
    if(s<86400)return Math.floor(s/3600)+"h"; return Math.floor(s/86400)+"d"; }
  function lid(){ try{ return localStorage.ce_id || (localStorage.ce_id = Math.random().toString(36).slice(2,10)); }
    catch(_){ return "anon-"+Math.random().toString(36).slice(2,8); } }

  var CSS = [
    ":host{all:initial}",
    "*{box-sizing:border-box;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif}",
    ".launch{position:fixed;right:18px;bottom:18px;z-index:2147483000;display:inline-flex;align-items:center;gap:8px;",
    "  border:0;border-radius:999px;padding:11px 16px;cursor:pointer;font-weight:700;font-size:14px;color:#021018;",
    "  background:linear-gradient(118deg,#2f6bff,#37c6ff 56%,#7af0e6);box-shadow:0 8px 26px rgba(3,8,20,.45);transition:transform .15s}",
    ".launch:hover{transform:translateY(-2px)}",
    ".launch svg{width:16px;height:16px}",
    ".panel{position:fixed;right:18px;bottom:74px;z-index:2147483000;width:min(380px,calc(100vw - 32px));max-height:min(640px,calc(100vh - 110px));",
    "  display:none;flex-direction:column;background:#070d18;color:#e9f1fb;border:1px solid rgba(116,176,255,.16);",
    "  border-radius:16px;box-shadow:0 18px 60px rgba(3,8,20,.6);overflow:hidden}",
    ".panel.open{display:flex}",
    ".hd{display:flex;align-items:center;gap:9px;padding:13px 14px;border-bottom:1px solid rgba(116,176,255,.1)}",
    ".hd .ttl{font-weight:700;font-size:15px}",
    ".hd .tg{font-family:ui-monospace,Menlo,monospace;font-size:11px;color:#37c6ff}",
    ".hd .sp{flex:1}",
    ".hd .x{background:transparent;border:0;color:#92a8c6;cursor:pointer;font-size:18px;line-height:1;padding:4px 6px}",
    ".hd .x:hover{color:#e9f1fb}",
    ".body{flex:1;overflow-y:auto;padding:12px 14px;display:flex;flex-direction:column;gap:10px}",
    ".empty{color:#5e768f;font-size:13px;text-align:center;padding:22px 0}",
    ".it{border:1px solid rgba(116,176,255,.08);border-radius:11px;background:#0a1422;padding:10px 11px}",
    ".it.hidden{opacity:.5}",
    ".row{display:flex;gap:9px;align-items:flex-start}",
    ".vote{display:flex;flex-direction:column;align-items:center;gap:1px;flex:none}",
    ".vote button{background:transparent;border:1px solid rgba(116,176,255,.16);border-radius:7px;width:28px;height:26px;cursor:pointer;color:#92a8c6;display:flex;align-items:center;justify-content:center}",
    ".vote button.on{color:#021018;background:linear-gradient(118deg,#2f6bff,#37c6ff 56%,#7af0e6);border:0}",
    ".vote button svg{width:13px;height:13px}",
    ".vote .n{font-family:ui-monospace,Menlo,monospace;font-size:12px;color:#7af0ff;font-weight:600}",
    ".main{flex:1;min-width:0}",
    ".meta{display:flex;align-items:center;gap:7px;margin-bottom:3px}",
    ".av{width:15px;height:15px;border-radius:5px;flex:none}",
    ".who{font-weight:600;font-size:12.5px;overflow-wrap:anywhere}",
    ".when{font-family:ui-monospace,Menlo,monospace;font-size:10.5px;color:#5e768f;margin-left:auto;flex:none}",
    ".txt{font-size:13.5px;line-height:1.5;white-space:pre-wrap;word-break:break-word;overflow-wrap:anywhere}",
    ".acts{display:flex;gap:12px;margin-top:6px}",
    ".acts a{font-family:ui-monospace,Menlo,monospace;font-size:11px;color:#5e768f;cursor:pointer}",
    ".acts a:hover{color:#7af0ff}.acts a.fl:hover{color:#ff5d72}",
    ".note{font-family:ui-monospace,Menlo,monospace;font-size:10.5px;color:#5e768f;font-style:italic}",
    ".reps{margin:8px 0 0 9px;border-left:1px solid rgba(116,176,255,.1);padding-left:10px;display:flex;flex-direction:column;gap:7px}",
    ".rep .txt{font-size:12.5px}",
    ".rbox{margin-top:8px;display:none}.rbox.open{display:block}",
    ".ft{border-top:1px solid rgba(116,176,255,.1);padding:11px 14px;display:flex;flex-direction:column;gap:8px}",
    "input,textarea{width:100%;background:#060b14;color:#e9f1fb;border:1px solid rgba(116,176,255,.16);border-radius:9px;",
    "  font-size:13.5px;padding:9px 10px;outline:none;resize:none;font-family:inherit}",
    "input:focus,textarea:focus{border-color:rgba(55,198,255,.45)}",
    ".frow{display:flex;gap:8px;align-items:center}",
    ".frow .nm{flex:0 0 120px}",
    ".send{flex:1;border:0;border-radius:9px;padding:9px 12px;cursor:pointer;font-weight:700;font-size:13.5px;color:#021018;",
    "  background:linear-gradient(118deg,#2f6bff,#37c6ff 56%,#7af0e6)}",
    ".send:disabled{opacity:.5;cursor:not-allowed}",
    ".send.ghost{flex:none;color:#92a8c6;background:transparent;border:1px solid rgba(116,176,255,.16);font-weight:600;font-size:12px;padding:6px 11px}",
    ".cool{font-family:ui-monospace,Menlo,monospace;font-size:11px;color:#5e768f}"
  ].join("");

  var UP_SVG = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 5v14M6 11l6-6 6 6"/></svg>';
  var CHAT_SVG = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15a2 2 0 0 1-2 2H8l-4 4V5a2 2 0 0 1 2-2h13a2 2 0 0 1 2 2z"/></svg>';

  function Widget(opts){
    var self = this;
    this.host = (opts.host || originGuess()).replace(/\/+$/,"");
    this.target = cleanTarget(opts.target);
    this.room = "t:" + this.target;
    this.id = lid();
    this.myColor = colorFor(this.id);
    this.threads = new Map();
    this.revealed = new Set();
    this.peers = new Map();
    this.last = 0;
    try { this.last = parseInt(localStorage["ce_fb_last_" + this.target] || "0", 10); } catch(_){}
    this.ws = null;

    // ---- shadow root + UI ----
    var holder = document.createElement("div");
    var root = holder.attachShadow ? holder.attachShadow({ mode: "open" }) : holder;
    this.root = root;
    var style = document.createElement("style"); style.textContent = CSS; root.appendChild(style);

    var launch = document.createElement("button"); launch.className = "launch";
    launch.innerHTML = CHAT_SVG + "<span>Feedback</span>";
    root.appendChild(launch);

    var panel = document.createElement("div"); panel.className = "panel"; root.appendChild(panel);
    panel.appendChild(this.buildHeader());
    var body = document.createElement("div"); body.className = "body"; panel.appendChild(body);
    this.bodyEl = body;
    panel.appendChild(this.buildFooter());
    this.panel = panel;

    launch.addEventListener("click", function(){ self.toggle(); });
    this.closeBtn.addEventListener("click", function(){ self.toggle(false); });

    (opts.el || document.body).appendChild(holder);
    this.holder = holder;

    this.hydrate();
    this.connect();
    this._tick = setInterval(function(){ self.refreshTimes(); self.gcPeers(); }, 20000);
  }

  Widget.prototype.buildHeader = function(){
    var hd = document.createElement("div"); hd.className = "hd";
    var ttl = document.createElement("span"); ttl.className = "ttl"; ttl.textContent = "Feedback"; hd.appendChild(ttl);
    if (this.target !== "global"){ var tg = document.createElement("span"); tg.className = "tg"; tg.textContent = this.target; hd.appendChild(tg); }
    var sp = document.createElement("div"); sp.className = "sp"; hd.appendChild(sp);
    var x = document.createElement("button"); x.className = "x"; x.setAttribute("aria-label","Close"); x.textContent = "×"; hd.appendChild(x);
    this.closeBtn = x;
    return hd;
  };

  Widget.prototype.buildFooter = function(){
    var self = this, ft = document.createElement("div"); ft.className = "ft";
    var frow = document.createElement("div"); frow.className = "frow";
    var sw = document.createElement("span"); sw.className = "av"; sw.style.width = "22px"; sw.style.height = "22px"; sw.style.background = this.myColor; frow.appendChild(sw);
    var nm = document.createElement("input"); nm.className = "nm"; nm.maxLength = 20; nm.placeholder = "your name";
    try { nm.value = localStorage.ce_name || ("guest-" + this.id.slice(0,3)); } catch(_){ nm.value = "guest-" + this.id.slice(0,3); }
    nm.addEventListener("input", function(){ try{ localStorage.ce_name = nm.value; }catch(_){}});
    frow.appendChild(nm); ft.appendChild(frow); this.nameEl = nm;

    var ta = document.createElement("textarea"); ta.rows = 2; ta.maxLength = MAXLEN; ta.placeholder = "Share feedback…"; ft.appendChild(ta); this.msgEl = ta;

    var brow = document.createElement("div"); brow.className = "frow";
    var cool = document.createElement("span"); cool.className = "cool"; brow.appendChild(cool); this.coolEl = cool;
    var send = document.createElement("button"); send.className = "send"; send.textContent = "Post"; brow.appendChild(send); this.sendBtn = send;
    ft.appendChild(brow);

    send.addEventListener("click", function(){ self.post(); });
    ta.addEventListener("keydown", function(e){ if((e.metaKey||e.ctrlKey) && e.key === "Enter") self.post(); });
    this._cool = setInterval(function(){ self.refreshCool(); }, 400); this.refreshCool();
    return ft;
  };

  Widget.prototype.toggle = function(force){
    var open = typeof force === "boolean" ? force : !this.panel.classList.contains("open");
    this.panel.classList.toggle("open", open);
  };

  // ---- urls ----
  Widget.prototype.wsURL = function(){ var p = this.host.indexOf("https") === 0 ? "wss" : "ws"; return p + "://" + this.host.replace(/^https?:\/\//,"") + "/rt/" + APP + "/" + this.room; };
  Widget.prototype.dbURL = function(key){ return this.host + "/db/" + APP + (key ? "/" + key.split("/").map(encodeURIComponent).join("/") : ""); };

  // ---- moderation ----
  Widget.prototype.isHidden = function(t){
    if (t.del) return true;
    var flags = Object.keys(t.flags||{}).length, ups = Object.keys(t.up||{}).length;
    return (flags - ups) >= HIDE_THRESHOLD;
  };
  Widget.prototype.score = function(t){ return Object.keys(t.up||{}).length; };

  // ---- state ----
  Widget.prototype.upsert = function(m){
    var t = this.threads.get(m.id);
    if (!t){ t = { id:m.id, by:m.by, name:m.name, col:m.col, body:m.body, t:m.t, up:{}, flags:{}, del:false, replies:new Map() }; this.threads.set(m.id, t); }
    else if (!t.body && m.body){ t.body=m.body; t.by=m.by; t.name=m.name; t.col=m.col; t.t=m.t; }
    return t;
  };
  Widget.prototype.applyUp = function(tid,who,on){ var t=this.threads.get(tid); if(!t)return; t.up=t.up||{}; if(on)t.up[who]=1; else delete t.up[who]; };
  Widget.prototype.applyFlag = function(tid,who,on){ var t=this.threads.get(tid); if(!t)return; t.flags=t.flags||{}; if(on)t.flags[who]=1; else delete t.flags[who]; };
  Widget.prototype.applyDel = function(tid){ var t=this.threads.get(tid); if(t)t.del=true; };
  Widget.prototype.applyReply = function(r){ var t=this.threads.get(r.tid); if(t && !t.replies.has(r.id)) t.replies.set(r.id, r); };

  // ---- render (textContent only = XSS-safe) ----
  Widget.prototype.render = function(){
    var self = this; this.bodyEl.textContent = "";
    var list = Array.from(this.threads.values());
    list.sort(function(a,b){ var d=self.score(b)-self.score(a); return d!==0?d:(b.t||0)-(a.t||0); });
    if (!list.length){ var e=document.createElement("div"); e.className="empty"; e.textContent="No feedback yet. Be the first."; this.bodyEl.appendChild(e); return; }
    list.slice(0, LIMIT).forEach(function(t){ self.bodyEl.appendChild(self.buildItem(t)); });
  };

  Widget.prototype.buildItem = function(t){
    var self = this, el = document.createElement("div"); el.className = "it";
    var hidden = this.isHidden(t) && !this.revealed.has(t.id);
    if (hidden) el.classList.add("hidden");
    var row = document.createElement("div"); row.className = "row";

    var vote = document.createElement("div"); vote.className = "vote";
    var vb = document.createElement("button"); if (t.up && t.up[this.id]) vb.classList.add("on"); vb.innerHTML = UP_SVG;
    vb.addEventListener("click", function(){ self.toggleUp(t.id); });
    vote.appendChild(vb);
    var n = document.createElement("span"); n.className = "n"; n.textContent = String(this.score(t)); vote.appendChild(n);
    row.appendChild(vote);

    var main = document.createElement("div"); main.className = "main";
    var meta = document.createElement("div"); meta.className = "meta";
    var av = document.createElement("span"); av.className = "av"; av.style.background = t.col || colorFor(t.by||t.name); meta.appendChild(av);
    var who = document.createElement("span"); who.className = "who"; who.textContent = t.name || "anon"; meta.appendChild(who);
    var when = document.createElement("span"); when.className = "when"; when.setAttribute("data-t", t.t); when.textContent = ago(t.t); meta.appendChild(when);
    main.appendChild(meta);

    if (hidden){
      var note = document.createElement("div"); note.className = "note"; note.textContent = t.del ? "Hidden by author." : "Hidden by the community."; main.appendChild(note);
      var ra = document.createElement("div"); ra.className = "acts"; var sa = document.createElement("a"); sa.textContent = "Show anyway";
      sa.addEventListener("click", function(){ self.revealed.add(t.id); self.render(); }); ra.appendChild(sa); main.appendChild(ra);
    } else {
      var txt = document.createElement("div"); txt.className = "txt"; txt.textContent = t.body; main.appendChild(txt);
      var acts = document.createElement("div"); acts.className = "acts";
      var cnt = t.replies ? t.replies.size : 0;
      var ra2 = document.createElement("a"); ra2.textContent = cnt ? ("Reply (" + cnt + ")") : "Reply";
      var rbox = document.createElement("div"); rbox.className = "rbox";
      ra2.addEventListener("click", function(){ rbox.classList.toggle("open"); var x=rbox.querySelector("textarea"); if(rbox.classList.contains("open")&&x)x.focus(); });
      acts.appendChild(ra2);
      var fa = document.createElement("a"); fa.className = "fl"; fa.textContent = (t.flags && t.flags[this.id]) ? "Flagged" : "Flag";
      fa.addEventListener("click", function(){ self.flag(t.id); }); acts.appendChild(fa);
      if (t.by === this.id && !t.del){ var da = document.createElement("a"); da.className = "fl"; da.textContent = "Hide mine"; da.addEventListener("click", function(){ self.softDelete(t.id); }); acts.appendChild(da); }
      main.appendChild(acts);

      if (cnt){
        var reps = document.createElement("div"); reps.className = "reps";
        Array.from(t.replies.values()).sort(function(a,b){ return (a.t||0)-(b.t||0); }).forEach(function(r){ reps.appendChild(self.buildReply(r)); });
        main.appendChild(reps);
      }
      var rta = document.createElement("textarea"); rta.rows = 2; rta.maxLength = REPLY_MAX; rta.placeholder = "Write a reply…"; rbox.appendChild(rta);
      var rsend = document.createElement("button"); rsend.className = "send ghost"; rsend.textContent = "Send reply"; rsend.style.marginTop = "6px";
      rsend.addEventListener("click", function(){ if (self.sendReply(t.id, rta.value)) rta.value = ""; }); rbox.appendChild(rsend);
      main.appendChild(rbox);
    }
    row.appendChild(main); el.appendChild(row); return el;
  };

  Widget.prototype.buildReply = function(r){
    var wrap = document.createElement("div"); wrap.className = "rep";
    var meta = document.createElement("div"); meta.className = "meta";
    var av = document.createElement("span"); av.className = "av"; av.style.background = r.col || colorFor(r.by||r.name); meta.appendChild(av);
    var who = document.createElement("span"); who.className = "who"; who.textContent = r.name || "anon"; meta.appendChild(who);
    var when = document.createElement("span"); when.className = "when"; when.setAttribute("data-t", r.t); when.textContent = ago(r.t); meta.appendChild(when);
    wrap.appendChild(meta);
    var txt = document.createElement("div"); txt.className = "txt"; txt.textContent = r.body; wrap.appendChild(txt);
    return wrap;
  };

  Widget.prototype.refreshTimes = function(){ var ws = this.root.querySelectorAll(".when"); for (var i=0;i<ws.length;i++) ws[i].textContent = ago(+ws[i].getAttribute("data-t")); };

  // ---- network ----
  Widget.prototype.send = function(o){ if (this.ws && this.ws.readyState === 1){ try{ this.ws.send(JSON.stringify(o)); }catch(_){} } };
  Widget.prototype.dbPut = function(key,val){ try{ fetch(this.dbURL(key), { method:"PUT", headers:{"content-type":"application/json"}, body:JSON.stringify(val) }); }catch(_){} };

  Widget.prototype.refreshCool = function(){
    var left = RATE_MS - (Date.now() - this.last);
    if (left > 0){ this.sendBtn.disabled = true; this.coolEl.textContent = "wait " + Math.ceil(left/1000) + "s"; }
    else { this.sendBtn.disabled = false; this.coolEl.textContent = ""; }
  };

  Widget.prototype.post = function(){
    var body = this.msgEl.value.trim().slice(0, MAXLEN);
    var name = (this.nameEl.value.trim() || ("guest-" + this.id.slice(0,3))).slice(0,20);
    if (!body) return;
    if (Date.now() - this.last < RATE_MS) return;
    this.last = Date.now();
    try { localStorage["ce_fb_last_" + this.target] = String(this.last); localStorage.ce_name = name; } catch(_){}
    this.refreshCool();
    var tid = this.id + ":" + this.last.toString(36);
    var m = { kind:"fb", target:this.target, id:tid, by:this.id, name:name, col:this.myColor, body:body, t:this.last };
    this.upsert(m); this.render();
    this.msgEl.value = "";
    this.dbPut("fb:" + this.target + ":" + invTs(this.last) + ":" + this.id, m);
    this.send({ t:"fb", kind:m.kind, target:m.target, id:m.id, by:m.by, name:m.name, col:m.col, body:m.body, t:m.t });
  };

  Widget.prototype.sendReply = function(tid, raw){
    var body = String(raw||"").trim().slice(0, REPLY_MAX); if (!body) return false;
    var name = (this.nameEl.value.trim() || ("guest-" + this.id.slice(0,3))).slice(0,20);
    var t = Date.now(), rid = this.id + ":" + t.toString(36);
    var r = { kind:"reply", target:this.target, tid:tid, id:rid, by:this.id, name:name, col:colorFor(this.id), body:body, t:t };
    this.applyReply(r); this.render();
    this.dbPut("rp:" + this.target + ":" + tid + ":" + invTs(t) + ":" + this.id, r);
    this.send({ t:"reply", target:this.target, tid:tid, id:rid, by:this.id, name:name, col:r.col, body:body, t:t });
    return true;
  };

  Widget.prototype.toggleUp = function(tid){
    var t = this.threads.get(tid); if (!t) return;
    var on = !(t.up && t.up[this.id]);
    this.applyUp(tid, this.id, on); this.render();
    this.dbPut("vt:" + this.target + ":" + tid + ":" + this.id, { kind:"vote", target:this.target, tid:tid, by:this.id, on:on, t:Date.now() });
    this.send({ t:"vote", target:this.target, tid:tid, by:this.id, on:on });
  };

  Widget.prototype.flag = function(tid){
    var t = this.threads.get(tid); if (!t) return;
    var on = !(t.flags && t.flags[this.id]);
    this.applyFlag(tid, this.id, on); this.render();
    this.dbPut("fl:" + this.target + ":" + tid + ":" + this.id, { kind:"flag", target:this.target, tid:tid, by:this.id, on:on, t:Date.now() });
    this.send({ t:"flag", target:this.target, tid:tid, by:this.id, on:on });
  };

  Widget.prototype.softDelete = function(tid){
    var t = this.threads.get(tid); if (!t || t.by !== this.id) return;
    this.applyDel(tid); this.render();
    this.dbPut("dl:" + this.target + ":" + tid + ":" + this.id, { kind:"del", target:this.target, tid:tid, by:this.id, t:Date.now() });
    this.send({ t:"del", target:this.target, tid:tid, by:this.id });
  };

  Widget.prototype.hydrate = function(){
    var self = this;
    function list(prefix){
      return fetch(self.dbURL() + "?prefix=" + encodeURIComponent(prefix) + "&limit=1000")
        .then(function(r){ return r.json(); })
        .then(function(j){ return (j.items||[]).map(function(it){ return it.value; }).filter(Boolean); })
        .catch(function(){ return []; });
    }
    var tg = this.target;
    Promise.all([ list("fb:"+tg+":"), list("rp:"+tg+":"), list("vt:"+tg+":"), list("fl:"+tg+":"), list("dl:"+tg+":") ])
      .then(function(res){
        res[0].forEach(function(m){ self.upsert(m); });
        res[1].forEach(function(r){ self.applyReply(r); });
        res[2].forEach(function(v){ self.applyUp(v.tid, v.by, !!v.on); });
        res[3].forEach(function(f){ self.applyFlag(f.tid, f.by, !!f.on); });
        res[4].forEach(function(d){ self.applyDel(d.tid); });
        self.render();
      });
  };

  Widget.prototype.gcPeers = function(){ var now = Date.now(); this.peers.forEach(function(v,k,m){ if (now - v > 6000) m.delete(k); }); };

  Widget.prototype.onFrame = function(m){
    if (!m || typeof m !== "object") return;
    var from = typeof m.by === "string" ? m.by : m.id;
    if (from && from !== this.id) this.peers.set(from, Date.now());
    switch (m.t){
      case "fb":    if (m.id && m.body){ this.upsert(m); this.render(); } break;
      case "reply": if (m.tid && m.id && m.body){ this.applyReply(m); this.render(); } break;
      case "vote":  if (m.tid && m.by){ this.applyUp(m.tid, m.by, !!m.on); this.render(); } break;
      case "flag":  if (m.tid && m.by){ this.applyFlag(m.tid, m.by, !!m.on); this.render(); } break;
      case "del":   if (m.tid){ this.applyDel(m.tid); this.render(); } break;
    }
  };

  Widget.prototype.connect = function(){
    var self = this;
    try { this.ws = new WebSocket(this.wsURL()); } catch(_){ setTimeout(function(){ self.connect(); }, 2500); return; }
    this.ws.onopen = function(){ self.send({ t:"join", id:self.id }); };
    this.ws.onmessage = function(e){ var m; try{ m = JSON.parse(e.data); }catch(_){ return; } self.onFrame(m); };
    this.ws.onclose = function(){ setTimeout(function(){ self.connect(); }, 1800); };
    this.ws.onerror = function(){ try{ self.ws.close(); }catch(_){} };
    if (this._ping) clearInterval(this._ping);
    this._ping = setInterval(function(){ self.send({ t:"ping", id:self.id }); }, 2500);
  };

  Widget.prototype.destroy = function(){
    clearInterval(this._tick); clearInterval(this._cool); clearInterval(this._ping);
    try { this.ws && this.ws.close(); } catch(_){}
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
