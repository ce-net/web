import "./styles/app.css";
import { el, clear, linkify } from "./ui/dom.ts";
import { ChatService, type MeshLike, type ConnectionState } from "./core/service.ts";
import {
  publicChannel,
  privateChannel,
  dmChannel,
  normalizeChannelName,
  isValidChannelName,
  isNodeId,
  type ChannelRef,
} from "./core/topics.ts";
import { HEARTBEAT_INTERVAL_MS, PRESENCE_TTL_MS, type Member } from "./core/presence.ts";
import { type StoredMessage } from "./core/store.ts";
import { shortId, initials, hueFor, clockTime, relativeTime, utf8Len } from "./core/format.ts";
import { MAX_TEXT_LEN } from "./core/protocol.ts";
import { toFriendly } from "./core/errors.ts";
import {
  makeClient,
  meshAdapter,
  fetchIdentity,
  resolveNodeUrl,
} from "./core/sdk-adapter.ts";
import {
  loadChannels,
  saveChannels,
  loadDrafts,
  saveDrafts,
  loadName,
  saveName,
  loadNodeUrl,
  saveNodeUrl,
  type StorageLike,
} from "./core/persist.ts";

/** Default channels every member sees on first load. */
const DEFAULT_CHANNELS = ["general", "random", "mesh"];
/** Quick-pick reaction emojis. */
const QUICK_EMOJI = ["👍", "🎉", "❤️", "😂", "👀", "🚀"];
/** How often we re-publish a typing hint while the user keeps typing. */
const TYPING_THROTTLE_MS = 2500;

const store: StorageLike = safeStorage();

interface AppState {
  selfId: string;
  service: ChatService;
  active: string | null;
  /** Per-channel composer drafts (also persisted). */
  drafts: Map<string, string>;
  /** Open thread root id (in the active channel), or null. */
  thread: string | null;
  connectionError: string | null;
  connection: ConnectionState;
}

const root = document.getElementById("app");
let app: AppState | null = null;
let heartbeatTimer: number | undefined;
let presenceTimer: number | undefined;
let lastTypingSent = 0;

if (root) void boot();

async function boot(): Promise<void> {
  renderLoading();
  const nodeUrl = resolveNodeUrl(loadNodeUrl(store));
  const client = makeClient(nodeUrl);
  try {
    const id = await fetchIdentity(client);
    const name = loadName(store);
    const mesh: MeshLike = meshAdapter(client);
    const service = new ChatService(mesh, id.nodeId, name, {
      onMessages: (cid) => {
        if (app?.active === cid) renderStream();
        renderSidebar();
      },
      onPresence: (cid) => {
        if (app?.active === cid) renderRoster();
        renderSidebar();
      },
      onTyping: (cid) => {
        if (app?.active === cid) renderTyping();
      },
      onUnread: () => renderSidebar(),
      onStreamError: (err) => {
        const f = toFriendly(err);
        if (app) app.connectionError = `${f.message}${f.hint ? " " + f.hint : ""}`;
        renderAll();
      },
      onConnectionChange: (state) => {
        if (!app) return;
        app.connection = state;
        if (state === "live") app.connectionError = null;
        renderAll();
      },
    });

    app = {
      selfId: id.nodeId,
      service,
      active: null,
      drafts: loadDrafts(store),
      thread: null,
      connectionError: null,
      connection: "connecting",
    };

    // Join persisted channels (fall back to defaults on a first run).
    const persisted = loadChannels(store, id.nodeId);
    const toJoin: ChannelRef[] = persisted.length > 0 ? persisted : DEFAULT_CHANNELS.map(publicChannel);
    for (const ref of toJoin) {
      try {
        await service.join(ref);
      } catch (e) {
        console.warn("join failed", ref.id, e);
      }
    }
    persistChannels();
    app.active = service.joined()[0]?.id ?? null;
    if (app.active) service.markRead(app.active);
    service.startStream();
    startTimers();
    renderAll();
  } catch (err) {
    renderConnectError(err, () => void boot());
  }
}

function startTimers(): void {
  stopTimers();
  // Heartbeat into ALL joined channels so peers see us even in background channels.
  heartbeatTimer = window.setInterval(() => {
    void app?.service.heartbeatAll();
  }, HEARTBEAT_INTERVAL_MS);
  void app?.service.heartbeatAll();
  // Repaint presence/typing to age members out as the TTL passes.
  presenceTimer = window.setInterval(() => {
    if (app?.active) {
      renderRoster();
      renderTyping();
    }
    renderSidebar();
  }, 4000);
}

function stopTimers(): void {
  if (heartbeatTimer) window.clearInterval(heartbeatTimer);
  if (presenceTimer) window.clearInterval(presenceTimer);
}

/* ------------------------------------------------------------ guarded access */

/** The active channel ref, or undefined when there is no active channel. */
function activeRef(): ChannelRef | undefined {
  const a = app;
  if (!a || !a.active) return undefined;
  return a.service.joined().find((r) => r.id === a.active);
}

/** Mentionable handles for highlighting self in the active channel. */
function selfHandles(): Set<string> {
  const out = new Set<string>();
  if (!app) return out;
  out.add(app.selfId.toLowerCase());
  const n = app.service.name;
  if (n) out.add(n.toLowerCase());
  return out;
}

/* ------------------------------------------------------------------ render */

function renderLoading(): void {
  if (!root) return;
  clear(root);
  root.append(
    el("div", { class: "shell" }, [
      el("aside", { class: "sidebar" }, [brandNode()]),
      el("section", { class: "main" }, [el("div", { class: "skeleton" }, skeletonRows(6))]),
    ]),
  );
}

function skeletonRows(n: number): Node[] {
  const rows: Node[] = [];
  for (let i = 0; i < n; i++) {
    rows.push(
      el("div", { class: "skel-row" }, [
        el("div", { class: "skel-av" }),
        el("div", {}, [
          el("div", { class: "skel-line", style: `width:${30 + ((i * 17) % 40)}%; margin-bottom:8px` }),
          el("div", { class: "skel-line", style: `width:${50 + ((i * 23) % 40)}%` }),
        ]),
      ]),
    );
  }
  return rows;
}

function renderConnectError(err: unknown, retry: () => void): void {
  if (!root) return;
  const f = toFriendly(err);
  const nodeUrl = resolveNodeUrl(loadNodeUrl(store));
  clear(root);
  root.append(
    el("div", { class: "shell" }, [
      el("aside", { class: "sidebar" }, [brandNode()]),
      el("section", { class: "main" }, [
        el("div", { class: "placeholder" }, [
          el("div", { class: "card" }, [
            el("div", { class: "glyph" }, ["⚓"]),
            el("h3", {}, ["Can't reach your CE node"]),
            el("p", {}, ["ce-chat talks to a local node over its HTTP+SSE API at ", el("code", {}, [nodeUrl]), "."]),
            el("p", {}, [f.hint ?? "Start your node, then retry."]),
            el("p", { style: "margin-top:14px" }, [el("code", {}, ["ce start"])]),
            el("div", { class: "modal-actions", style: "justify-content:center;margin-top:20px;gap:10px" }, [
              el("button", { class: "btn ghost", onclick: openNodeUrlModal }, ["Change node URL"]),
              el("button", { class: "btn primary", onclick: retry }, ["Retry connection"]),
            ]),
          ]),
        ]),
      ]),
    ]),
  );
}

function renderAll(): void {
  if (!app || !root) return;
  clear(root);
  root.append(el("div", { class: "shell" }, [buildSidebar(), buildMain(), buildRoster()]));
  scrollStreamToBottom();
}

function renderSidebar(): void {
  if (!app) return;
  const existing = document.querySelector(".sidebar");
  if (existing) existing.replaceWith(buildSidebar());
}
function renderStream(): void {
  if (!app) return;
  const main = document.querySelector(".main");
  if (main) {
    main.replaceWith(buildMain());
    scrollStreamToBottom();
  }
}
function renderRoster(): void {
  if (!app) return;
  const existing = document.querySelector(".roster");
  if (existing) existing.replaceWith(buildRoster());
}
function renderTyping(): void {
  if (!app?.active) return;
  const bar = document.getElementById("typing-bar");
  const typers = app.service.typers(app.active);
  if (bar) bar.replaceWith(buildTypingBar(typers));
}

function brandNode(): Node {
  return el("div", { class: "brand" }, [
    el("div", {
      class: "mark",
      html: `<svg viewBox="0 0 32 32" width="30" height="30"><rect width="32" height="32" rx="8" fill="#0b1f24"/><path d="M4 20c3-4 6 0 9-2s6-6 9-2 6 0 9-2" stroke="#34d0c4" stroke-width="2.4" fill="none" stroke-linecap="round"/><path d="M4 25c3-4 6 0 9-2s6-6 9-2 6 0 9-2" stroke="#1fa99e" stroke-width="1.8" fill="none" stroke-linecap="round" opacity="0.7"/></svg>`,
    }),
    el("div", {}, [el("h1", {}, ["ce-chat"]), el("p", { class: "tag" }, ["team chat on the Sea"])]),
  ]);
}

function buildSidebar(): Node {
  if (!app) return el("aside", { class: "sidebar" });
  const a = app;
  const channels = a.service.joined();
  const now = Date.now();

  const list = el("ul", { class: "channel-list", role: "list" });
  for (const ref of channels) {
    const st = a.service.state(ref.id);
    const online = st ? st.presence.onlineCount(now) : 0;
    const unread = st ? st.unread : 0;
    const isActive = ref.id === a.active;
    list.append(
      el("li", {}, [
        el(
          "button",
          {
            class: `chan${unread > 0 && !isActive ? " unread" : ""}`,
            "aria-current": isActive ? "true" : "false",
            onclick: () => void selectChannel(ref.id),
          },
          [
            el("span", { class: "sigil", "aria-hidden": "true" }, [sigilFor(ref)]),
            el("span", { class: "label" }, [ref.label]),
            ...(ref.kind === "private" ? [el("span", { class: "lock", title: "capability-gated" }, ["lock"])] : []),
            ...(unread > 0 && !isActive
              ? [el("span", { class: "badge", title: `${unread} unread` }, [String(Math.min(unread, 99))])]
              : online > 0
                ? [el("span", { class: "count", title: `${online} online` }, [String(online)])]
                : []),
          ],
        ),
      ]),
    );
  }

  const offline = a.connection !== "live" && a.connection !== "connecting";
  const footText =
    a.connection === "reconnecting"
      ? "reconnecting…"
      : a.connection === "stopped"
        ? "node unreachable"
        : `mesh live · ${channels.length} channels`;
  return el("aside", { class: "sidebar" }, [
    brandNode(),
    identityCard(),
    el("div", { class: "nav-section" }, [
      el("h2", {}, ["Channels"]),
      el("button", { class: "add", title: "New channel or DM", "aria-label": "New channel or DM", onclick: openComposeModal }, ["+"]),
    ]),
    list,
    el("div", { class: "sidebar-foot" }, [
      el("span", { class: `dot ${offline ? "warn" : "on"}` }),
      footText,
    ]),
  ]);
}

function sigilFor(ref: ChannelRef): string {
  if (ref.kind === "dm") return "@";
  if (ref.kind === "private") return "*";
  return "#";
}

function identityCard(): Node {
  if (!app) return el("div", { class: "identity" });
  const a = app;
  const name = a.service.name;
  const display = name || shortId(a.selfId);
  return el("div", { class: "identity" }, [
    avatarNode(name || a.selfId, a.selfId, 36),
    el("div", { class: "who" }, [
      el("div", { class: "name" }, [display]),
      el("div", { class: "nid" }, [
        shortId(a.selfId, 6, 6),
        el("button", { title: "Copy your node id", onclick: () => copy(a.selfId) }, ["copy"]),
        el("button", { title: "Set display name", onclick: openNameModal }, ["rename"]),
      ]),
    ]),
  ]);
}

function buildMain(): Node {
  if (!app) return el("section", { class: "main" });
  const a = app;
  const ref = activeRef();
  const st = a.active ? a.service.state(a.active) : undefined;
  if (!ref || !st) return el("section", { class: "main" }, [emptyPane()]);

  const now = Date.now();
  const online = st.presence.onlineCount(now);

  const stream = el("div", {
    class: "stream",
    id: "stream",
    role: "log",
    "aria-live": "polite",
    "aria-label": `${ref.label} messages`,
  });
  const roots = st.store.roots();
  if (roots.length === 0) {
    stream.append(emptyChannel(ref));
  } else {
    renderMessages(stream, roots);
  }

  const main = el("section", { class: "main" }, [
    el("header", { class: "topbar" }, [
      el("div", { class: "title" }, [
        el("span", { class: "sigil", "aria-hidden": "true" }, [sigilFor(ref)]),
        el("h2", {}, [ref.label]),
      ]),
      el("span", { class: "topic", title: ref.topic }, [ref.topic]),
      el("div", { class: "spacer" }),
      el(
        "button",
        { class: "ghost-btn", title: "Reload history from peers", onclick: () => void a.service.requestHistory(ref.id, true) },
        ["history"],
      ),
      el("div", { class: "presence-chip", title: `${online} online` }, [el("span", { class: "dot on" }), `${online} online`]),
    ]),
  ]);

  if (a.connectionError && a.connection !== "live") {
    main.append(
      el("div", { class: "banner error", role: "alert" }, [
        el("span", {}, ["⚠"]),
        el("span", {}, [a.connection === "reconnecting" ? "Reconnecting to the mesh…" : a.connectionError]),
        ...(a.connection === "reconnecting" ? [] : [el("button", { onclick: () => void boot() }, ["Reconnect"])]),
      ]),
    );
  }

  main.append(stream, buildTypingBar(a.service.typers(ref.id)), buildComposer(ref));
  // Thread side-pane.
  const section = el("div", { class: "main-with-thread" }, [main]);
  if (a.thread) {
    const pane = buildThreadPane(ref, a.thread);
    if (pane) section.append(pane);
  }
  return section;
}

function renderMessages(stream: HTMLElement, msgs: StoredMessage[]): void {
  if (!app?.active) return;
  const st = app.service.state(app.active);
  const lastReadAt = st?.lastReadAt ?? 0;
  let lastDay = "";
  let prevFrom = "";
  let prevTs = 0;
  let unreadDividerShown = false;
  const handles = selfHandles();
  for (const m of msgs) {
    const day = new Date(m.ts || m.receivedAt).toDateString();
    if (day !== lastDay) {
      stream.append(el("div", { class: "daydiv" }, [friendlyDay(m.ts || m.receivedAt)]));
      lastDay = day;
      prevFrom = "";
    }
    if (!unreadDividerShown && !m.isSelf && m.receivedAt > lastReadAt && (st?.unread ?? 0) > 0) {
      stream.append(el("div", { class: "unread-div" }, ["new messages"]));
      unreadDividerShown = true;
      prevFrom = "";
    }
    const grouped = m.from === prevFrom && m.ts - prevTs < 5 * 60 * 1000 && prevFrom !== "";
    stream.append(messageNode(m, grouped, handles));
    prevFrom = m.from;
    prevTs = m.ts || m.receivedAt;
  }
}

function messageNode(m: StoredMessage, grouped: boolean, handles: Set<string>): Node {
  if (!app) return document.createTextNode("");
  const a = app;
  const author = m.name || shortId(m.from);
  const failed = m.status === "failed";
  const cls = ["msg", grouped ? "grouped" : "", m.status === "pending" ? "pending" : "", failed ? "failed" : "", m.deleted ? "deleted" : ""]
    .filter(Boolean)
    .join(" ");

  const head = grouped
    ? null
    : el("div", { class: "head" }, [
        el("span", { class: `author ${m.isSelf ? "self" : ""}` }, [author]),
        ...(m.name ? [el("span", { class: "nid" }, [shortId(m.from, 4, 4)])] : []),
        el("span", { class: "stamp" }, [clockTime(m.ts || m.receivedAt)]),
        ...(m.editedAt ? [el("span", { class: "edited", title: "edited" }, ["(edited)"])] : []),
      ]);

  const body = el("div", { class: "body" }, m.deleted ? [el("span", { class: "tombstone" }, ["message deleted"])] : linkify(m.text, handles));
  if (m.status === "pending") body.append(el("span", { class: "pending-tag" }, ["sending"]));
  if (failed) {
    body.append(el("span", { class: "failed-tag" }, ["failed"]));
    body.append(
      el("button", { class: "retry-btn", title: "Retry send", onclick: () => void retrySend(m.id) }, ["retry"]),
    );
  }

  const reactionBar = m.reactions && m.reactions.length > 0 && !m.deleted ? buildReactionBar(m) : null;

  const replyN = a.active ? (a.service.state(a.active)?.store.replyCount(m.id) ?? 0) : 0;
  const threadLink =
    replyN > 0 && !m.replyTo
      ? el("button", { class: "thread-link", onclick: () => openThread(m.id) }, [`${replyN} ${replyN === 1 ? "reply" : "replies"}`])
      : null;

  const actions = m.deleted
    ? null
    : el("div", { class: "msg-actions" }, [
        el("button", { title: "Add reaction", "aria-label": "Add reaction", onclick: (e) => openReactionPicker(e as MouseEvent, m) }, ["+"]),
        el("button", { title: "Reply in thread", "aria-label": "Reply in thread", onclick: () => openThread(m.replyTo || m.id) }, ["reply"]),
        ...(m.isSelf
          ? [
              el("button", { title: "Edit", "aria-label": "Edit message", onclick: () => beginEdit(m) }, ["edit"]),
              el("button", { title: "Delete", "aria-label": "Delete message", onclick: () => void deleteMsg(m.id) }, ["del"]),
            ]
          : []),
      ]);

  const right = el("div", { class: "msg-right" }, [
    ...(head ? [head] : []),
    body,
    ...(reactionBar ? [reactionBar] : []),
    ...(threadLink ? [threadLink] : []),
  ]);

  return el("div", { class: cls, "data-id": m.id }, [
    el("div", { class: "avatar-cell" }, [grouped ? document.createTextNode("") : avatarNode(author, m.from, 34)]),
    right,
    ...(actions ? [actions] : []),
  ]);
}

function buildReactionBar(m: StoredMessage): Node {
  const bar = el("div", { class: "reactions" });
  for (const g of m.reactions ?? []) {
    const mine = app ? g.reactors.includes(app.selfId.toLowerCase()) : false;
    bar.append(
      el(
        "button",
        {
          class: `chip${mine ? " mine" : ""}`,
          title: `${g.reactors.length} reacted`,
          onclick: () => void toggleReaction(m, g.emoji, mine ? "remove" : "add"),
        },
        [g.emoji, " ", String(g.reactors.length)],
      ),
    );
  }
  return bar;
}

function buildTypingBar(typers: { nodeId: string; name?: string }[]): Node {
  const names = typers.map((t) => t.name || shortId(t.nodeId)).slice(0, 3);
  let text = "";
  if (names.length === 1) text = `${names[0]} is typing…`;
  else if (names.length === 2) text = `${names[0]} and ${names[1]} are typing…`;
  else if (names.length >= 3) text = `${names[0]}, ${names[1]} and others are typing…`;
  return el("div", { class: `typing-bar${text ? " active" : ""}`, id: "typing-bar", "aria-live": "polite" }, text ? [text] : []);
}

function buildThreadPane(ref: ChannelRef, rootId: string): Node | null {
  if (!app?.active) return null;
  const st = app.service.state(app.active);
  if (!st) return null;
  const root = st.store.list().find((m) => m.id === rootId);
  const replies = st.store.replies(rootId);
  const handles = selfHandles();
  const list = el("div", { class: "thread-stream" });
  if (root) list.append(messageNode(root, false, handles));
  list.append(el("div", { class: "thread-sep" }, [`${replies.length} ${replies.length === 1 ? "reply" : "replies"}`]));
  for (const r of replies) list.append(messageNode(r, false, handles));
  return el("aside", { class: "thread-pane", "aria-label": "Thread" }, [
    el("header", { class: "thread-head" }, [
      el("h3", {}, ["Thread"]),
      el("button", { class: "ghost-btn", title: "Close thread", onclick: closeThread }, ["close"]),
    ]),
    list,
    buildThreadComposer(ref, rootId),
  ]);
}

function buildThreadComposer(ref: ChannelRef, rootId: string): Node {
  let value = "";
  const ta = el("textarea", {
    placeholder: "Reply in thread…",
    rows: 1,
    "aria-label": "Reply in thread",
    oninput: (e) => (value = (e.target as HTMLTextAreaElement).value),
    onkeydown: (e) => {
      const ke = e as KeyboardEvent;
      if (ke.key === "Enter" && !ke.shiftKey) {
        ke.preventDefault();
        void sendThreadReply();
      }
    },
  }) as HTMLTextAreaElement;
  return el("div", { class: "thread-composer" }, [
    ta,
    el("button", { class: "btn primary sm", onclick: () => void sendThreadReply() }, ["Reply"]),
  ]);

  async function sendThreadReply(): Promise<void> {
    if (!app?.active) return;
    const text = value.trim();
    if (text.length === 0 || utf8Len(text) > MAX_TEXT_LEN) return;
    value = "";
    ta.value = "";
    try {
      await app.service.send(app.active, text, rootId);
      renderStream();
    } catch (err) {
      flash(`Couldn't reply: ${toFriendly(err).message}`);
      renderStream();
    }
    void ref;
  }
}

function avatarNode(label: string, idForHue: string, size: number): HTMLElement {
  const hue = hueFor(idForHue);
  return el(
    "div",
    {
      class: "avatar",
      style: `width:${size}px;height:${size}px;background:linear-gradient(135deg, hsl(${hue} 62% 58%), hsl(${(hue + 36) % 360} 64% 46%))`,
      "aria-hidden": "true",
    },
    [initials(label)],
  );
}

function buildComposer(ref: ChannelRef): Node {
  if (!app) return el("div", { class: "composer" });
  const a = app;
  const draft = a.drafts.get(ref.id) ?? "";
  const ta = el("textarea", {
    placeholder: `Message ${ref.kind === "dm" ? ref.label : "#" + ref.label}…`,
    rows: 1,
    "aria-label": `Message ${ref.label}`,
    oninput: (e) => {
      const t = e.target as HTMLTextAreaElement;
      a.drafts.set(ref.id, t.value);
      persistDrafts();
      autoGrow(t);
      updateComposerMeta();
      maybeSendTyping();
    },
    onkeydown: (e) => {
      const ke = e as KeyboardEvent;
      if (ke.key === "Enter" && !ke.shiftKey) {
        ke.preventDefault();
        void doSend();
      }
    },
  }) as HTMLTextAreaElement;
  ta.value = draft;

  const send = el(
    "button",
    { class: "send", title: "Send (Enter)", "aria-label": "Send message", onclick: () => void doSend() },
    [el("span", { html: `<svg width="18" height="18" viewBox="0 0 24 24" fill="none"><path d="M4 12l16-8-6 8 6 8-16-8z" fill="currentColor"/></svg>` })],
  );

  const meta = el("div", { class: "meta", id: "composer-meta" }, [
    el("span", {}, [ref.kind === "dm" ? "Direct message · end-to-mesh" : "Enter to send · Shift+Enter for newline"]),
    el("span", { id: "char-count" }, [""]),
  ]);

  queueMicrotask(() => {
    ta.focus();
    autoGrow(ta);
    updateComposerMeta();
  });

  return el("div", { class: "composer" }, [el("div", { class: "box" }, [ta, send]), meta]);

  function autoGrow(t: HTMLTextAreaElement): void {
    t.style.height = "auto";
    t.style.height = Math.min(t.scrollHeight, 160) + "px";
  }
  function updateComposerMeta(): void {
    const count = document.getElementById("char-count");
    const sendBtn = document.querySelector(".composer .send") as HTMLButtonElement | null;
    const len = utf8Len((a.drafts.get(ref.id) ?? "").trim());
    if (count) {
      count.textContent = len > MAX_TEXT_LEN - 200 ? `${len}/${MAX_TEXT_LEN}` : "";
      count.className = len > MAX_TEXT_LEN ? "over" : "";
    }
    if (sendBtn) sendBtn.disabled = len === 0 || len > MAX_TEXT_LEN;
  }
  function maybeSendTyping(): void {
    const now = Date.now();
    if (now - lastTypingSent < TYPING_THROTTLE_MS) return;
    if ((a.drafts.get(ref.id) ?? "").trim().length === 0) return;
    lastTypingSent = now;
    void a.service.sendTyping(ref.id);
  }
}

async function doSend(): Promise<void> {
  const a = app;
  if (!a || !a.active) return;
  const cid = a.active;
  const text = (a.drafts.get(cid) ?? "").trim();
  if (text.length === 0 || utf8Len(text) > MAX_TEXT_LEN) return;
  a.drafts.delete(cid);
  persistDrafts();
  try {
    await a.service.send(cid, text);
    renderStream();
  } catch (err) {
    const f = toFriendly(err);
    if (f.kind === "offline" || f.kind === "auth") a.connectionError = `${f.message}${f.hint ? " " + f.hint : ""}`;
    renderStream();
    flash(`Couldn't send: ${f.message}`);
  }
}

async function retrySend(id: string): Promise<void> {
  if (!app?.active) return;
  try {
    await app.service.retry(app.active, id);
    renderStream();
  } catch (err) {
    flash(`Retry failed: ${toFriendly(err).message}`);
    renderStream();
  }
}

async function toggleReaction(m: StoredMessage, emoji: string, op: "add" | "remove"): Promise<void> {
  if (!app?.active) return;
  try {
    await app.service.react(app.active, m.from, m.id, emoji, op);
    renderStream();
  } catch (err) {
    flash(`Reaction failed: ${toFriendly(err).message}`);
  }
}

async function deleteMsg(id: string): Promise<void> {
  if (!app?.active) return;
  try {
    await app.service.delete(app.active, id);
    renderStream();
  } catch (err) {
    flash(`Delete failed: ${toFriendly(err).message}`);
  }
}

function beginEdit(m: StoredMessage): void {
  let value = m.text;
  const input = el("textarea", {
    value,
    rows: 3,
    "aria-label": "Edit message",
    oninput: (e) => (value = (e.target as HTMLTextAreaElement).value),
  }) as HTMLTextAreaElement;
  input.value = m.text;
  const close = openModal("Edit message", "Your edit is broadcast to the channel; peers see an (edited) marker.", [
    el("div", { class: "field" }, [input]),
    el("div", { class: "modal-actions" }, [
      el("button", { class: "btn ghost", onclick: () => close() }, ["Cancel"]),
      el("button", { class: "btn primary", onclick: save }, ["Save"]),
    ]),
  ]);
  queueMicrotask(() => input.focus());
  async function save(): Promise<void> {
    if (!app?.active) return close();
    const text = value.trim();
    if (text.length === 0 || utf8Len(text) > MAX_TEXT_LEN) return;
    close();
    try {
      await app.service.edit(app.active, m.id, text);
      renderStream();
    } catch (err) {
      flash(`Edit failed: ${toFriendly(err).message}`);
    }
  }
}

function openReactionPicker(ev: MouseEvent, m: StoredMessage): void {
  ev.stopPropagation();
  const existing = document.getElementById("emoji-pop");
  if (existing) existing.remove();
  const pop = el("div", { id: "emoji-pop", class: "emoji-pop", role: "menu" });
  for (const e of QUICK_EMOJI) {
    pop.append(
      el("button", { title: `React ${e}`, onclick: () => { pop.remove(); void toggleReaction(m, e, "add"); } }, [e]),
    );
  }
  document.body.append(pop);
  const target = ev.currentTarget as HTMLElement;
  const r = target.getBoundingClientRect();
  pop.style.left = `${Math.max(8, r.left - 40)}px`;
  pop.style.top = `${Math.max(8, r.top - 48)}px`;
  const onAway = (e: MouseEvent): void => {
    if (!pop.contains(e.target as Node)) {
      pop.remove();
      document.removeEventListener("mousedown", onAway);
    }
  };
  queueMicrotask(() => document.addEventListener("mousedown", onAway));
}

function openThread(rootId: string): void {
  if (!app) return;
  app.thread = rootId;
  renderStream();
}
function closeThread(): void {
  if (!app) return;
  app.thread = null;
  renderStream();
}

function buildRoster(): Node {
  if (!app) return el("aside", { class: "roster" });
  const a = app;
  const st = a.active ? a.service.state(a.active) : undefined;
  if (!a.active || !st) return el("aside", { class: "roster" });
  const now = Date.now();
  const members: Member[] = st.presence.list(now);
  const ul = el("ul", { role: "list" });
  for (const m of members) {
    const online = now - m.lastSeen <= PRESENCE_TTL_MS;
    const label = m.isSelf ? (a.service.name || "you") + " (you)" : m.name || shortId(m.nodeId);
    ul.append(
      el("li", { class: `member ${online ? "" : "offline"}` }, [
        avatarNode(m.name || m.nodeId, m.nodeId, 28),
        el("div", { class: "info" }, [
          el("div", { class: "mname" }, [label]),
          el("div", { class: "mid" }, [shortId(m.nodeId, 4, 4) + (online ? "" : " · " + relativeTime(m.lastSeen, now))]),
        ]),
        el("span", { class: `pdot ${online ? "on" : "off"}`, title: online ? "online" : "away" }),
      ]),
    );
  }
  return el("aside", { class: "roster", "aria-label": "Members" }, [el("h3", {}, [`Members · ${members.length}`]), ul]);
}

function emptyPane(): Node {
  return el("div", { class: "placeholder" }, [
    el("div", { class: "card" }, [
      el("div", { class: "glyph" }, ["~"]),
      el("h3", {}, ["No channel selected"]),
      el("p", {}, ["Pick a channel on the left, or create one to start talking over the mesh."]),
    ]),
  ]);
}

function emptyChannel(ref: ChannelRef): Node {
  return el("div", { class: "placeholder", style: "flex:1" }, [
    el("div", { class: "card" }, [
      el("div", { class: "glyph" }, [sigilFor(ref)]),
      el("h3", {}, [ref.kind === "dm" ? `Say hi to ${ref.label}` : `Welcome to #${ref.label}`]),
      el("p", {}, [
        ref.kind === "dm"
          ? "This is the beginning of your direct conversation over the CE mesh."
          : "This channel is a mesh pubsub topic. Anything you send is gossiped to every subscribed peer in real time.",
      ]),
      el("p", { style: "margin-top:8px" }, ["Asking peers for recent history…"]),
      el("p", { style: "margin-top:8px" }, ["Topic: ", el("code", {}, [ref.topic])]),
    ]),
  ]);
}

function friendlyDay(ts: number): string {
  const d = new Date(ts);
  const today = new Date();
  const yest = new Date(today.getTime() - 86400000);
  if (d.toDateString() === today.toDateString()) return "Today";
  if (d.toDateString() === yest.toDateString()) return "Yesterday";
  return d.toLocaleDateString(undefined, { weekday: "long", month: "short", day: "numeric" });
}

/* ------------------------------------------------------------------ actions */

async function selectChannel(id: string): Promise<void> {
  if (!app) return;
  app.active = id;
  app.thread = null;
  app.service.markRead(id);
  renderAll();
  void app.service.heartbeat(id);
}

function scrollStreamToBottom(): void {
  const s = document.getElementById("stream");
  if (s) s.scrollTop = s.scrollHeight;
}

function copy(text: string): void {
  void navigator.clipboard?.writeText(text).then(
    () => flash("Copied node id"),
    () => flash("Copy failed"),
  );
}

let flashTimer: number | undefined;
function flash(msg: string): void {
  let bar = document.getElementById("flash");
  if (!bar) {
    bar = el("div", {
      id: "flash",
      style:
        "position:fixed;bottom:20px;left:50%;transform:translateX(-50%);background:#0b1f24;border:1px solid #1d4a51;color:#eaf6f4;padding:9px 16px;border-radius:10px;font-size:13px;z-index:80;box-shadow:0 8px 28px rgba(0,0,0,.4)",
      role: "status",
    });
    document.body.append(bar);
  }
  bar.textContent = msg;
  if (flashTimer) window.clearTimeout(flashTimer);
  flashTimer = window.setTimeout(() => bar?.remove(), 2400);
}

/* ----------------------------------------------------------- persistence ops */

function persistChannels(): void {
  if (!app) return;
  saveChannels(store, app.service.joined());
}
function persistDrafts(): void {
  if (!app) return;
  saveDrafts(store, app.drafts);
}

/* ------------------------------------------------------------------ modals */

function openNameModal(): void {
  if (!app) return;
  const a = app;
  let value = a.service.name ?? "";
  const input = el("input", {
    value,
    placeholder: "e.g. Leif",
    maxlength: 64,
    "aria-label": "Display name",
    oninput: (e) => (value = (e.target as HTMLInputElement).value),
    onkeydown: (e) => {
      if ((e as KeyboardEvent).key === "Enter") save();
    },
  }) as HTMLInputElement;

  const close = openModal("Display name", "Shown next to your messages. Stored locally; broadcast with your presence.", [
    el("div", { class: "field" }, [
      el("label", { for: "name-input" }, ["Name"]),
      input,
      el("div", { class: "help" }, ["Leave blank to use your short node id."]),
    ]),
    el("div", { class: "modal-actions" }, [
      el("button", { class: "btn ghost", onclick: () => close() }, ["Cancel"]),
      el("button", { class: "btn primary", onclick: save }, ["Save"]),
    ]),
  ]);
  input.id = "name-input";
  queueMicrotask(() => input.focus());

  function save(): void {
    const name = value.trim() || undefined;
    saveName(store, name);
    // Apply in place — no reload, no data loss.
    a.service.setDisplayName(name);
    flash(name ? `Name set to ${name}` : "Name cleared");
    // Re-announce presence under the new name in every channel.
    void a.service.heartbeatAll();
    close();
    renderAll();
  }
}

function openNodeUrlModal(): void {
  let value = loadNodeUrl(store) ?? "";
  const input = el("input", {
    value,
    placeholder: "http://127.0.0.1:8844",
    class: "mono",
    "aria-label": "Node URL",
    oninput: (e) => (value = (e.target as HTMLInputElement).value),
  }) as HTMLInputElement;
  const close = openModal("Node URL", "Point ce-chat at a different CE node (e.g. a remote node or an alternate port).", [
    el("div", { class: "field" }, [el("label", {}, ["HTTP+SSE base URL"]), input]),
    el("div", { class: "modal-actions" }, [
      el("button", { class: "btn ghost", onclick: () => { saveNodeUrl(store, undefined); close(); flash("Node URL reset"); void boot(); } }, ["Reset to default"]),
      el("button", { class: "btn primary", onclick: () => { saveNodeUrl(store, value.trim() || undefined); close(); void boot(); } }, ["Save & connect"]),
    ]),
  ]);
  queueMicrotask(() => input.focus());
}

function openComposeModal(): void {
  let tab: "channel" | "private" | "dm" = "channel";
  let channelInput = "";
  let privateInput = "";
  let dmInput = "";
  let errMsg = "";

  const render = (): void => {
    clear(body);
    const tabs = el("div", { class: "tabs", role: "tablist" }, [
      tabBtn("Channel", tab === "channel", () => setTab("channel")),
      tabBtn("Private", tab === "private", () => setTab("private")),
      tabBtn("Direct", tab === "dm", () => setTab("dm")),
    ]);
    body.append(tabs);

    if (tab === "channel") {
      body.append(
        field("Channel name", "general", channelInput, "channel", (v) => (channelInput = v), submit),
        help("A public mesh topic anyone can join: ", el("code", {}, ["ce-chat/channel/<name>"])),
      );
    } else if (tab === "private") {
      body.append(
        field("Private channel", "eng-secret", privateInput, "channel", (v) => (privateInput = v), submit),
        help(
          "Capability-gated. The node enforces access on ",
          el("code", {}, ["ce-chat/private/<name>"]),
          ". If you lack a grant, subscribe returns 403 and we explain how to get one.",
        ),
      );
    } else {
      body.append(
        field("Peer node id (64 hex)", "a1b2…", dmInput, "node", (v) => (dmInput = v), submit),
        help("Opens a 1:1 topic derived from both node ids — order-independent, so either side can start it."),
      );
    }
    if (errMsg) body.append(el("div", { class: "field" }, [el("div", { class: "err" }, [errMsg])]));
    body.append(
      el("div", { class: "modal-actions" }, [
        el("button", { class: "btn ghost", onclick: () => close() }, ["Cancel"]),
        el("button", { class: "btn primary", onclick: submit }, [tab === "dm" ? "Open DM" : "Create / Join"]),
      ]),
    );
  };

  const body = el("div", {});
  const close = openModalRaw("New channel or direct message", body);
  render();

  function setTab(t: typeof tab): void {
    tab = t;
    errMsg = "";
    render();
  }

  async function submit(): Promise<void> {
    if (!app) return;
    const a = app;
    errMsg = "";
    try {
      let ref: ChannelRef;
      if (tab === "dm") {
        const peer = dmInput.trim().toLowerCase();
        if (!isNodeId(peer)) {
          errMsg = "Enter a valid 64-hex node id.";
          return render();
        }
        if (peer === a.selfId.toLowerCase()) {
          errMsg = "You can't DM yourself.";
          return render();
        }
        ref = dmChannel(a.selfId, peer, shortId(peer, 5, 5));
      } else {
        const raw = tab === "channel" ? channelInput : privateInput;
        const name = normalizeChannelName(raw);
        if (!isValidChannelName(name)) {
          errMsg = "Use 1–64 lowercase letters, digits, - or _.";
          return render();
        }
        ref = tab === "channel" ? publicChannel(name) : privateChannel(name);
      }
      await a.service.join(ref);
      persistChannels();
      a.active = ref.id;
      a.connectionError = null;
      close();
      renderAll();
      void a.service.heartbeat(ref.id);
    } catch (err) {
      const f = toFriendly(err);
      errMsg = `${f.message}${f.hint ? " — " + f.hint : ""}`;
      render();
    }
  }
}

function tabBtn(label: string, selected: boolean, onclick: () => void): Node {
  return el("button", { role: "tab", "aria-selected": selected ? "true" : "false", onclick }, [label]);
}

function field(
  label: string,
  placeholder: string,
  value: string,
  kind: "channel" | "node",
  onchange: (v: string) => void,
  onsubmit: () => void,
): Node {
  const input = el("input", {
    placeholder,
    value,
    class: kind === "node" ? "mono" : "",
    spellcheck: false,
    autocapitalize: "off",
    autocomplete: "off",
    oninput: (e) => onchange((e.target as HTMLInputElement).value),
    onkeydown: (e) => {
      if ((e as KeyboardEvent).key === "Enter") onsubmit();
    },
  }) as HTMLInputElement;
  queueMicrotask(() => input.focus());
  return el("div", { class: "field" }, [el("label", {}, [label]), input]);
}

function help(...children: (Node | string)[]): Node {
  return el("div", { class: "field" }, [el("div", { class: "help" }, children)]);
}

function openModal(title: string, sub: string, children: (Node | string)[]): () => void {
  const body = el("div", {}, [el("p", { class: "sub" }, [sub]), ...children]);
  return openModalRaw(title, body);
}

function openModalRaw(title: string, body: Node): () => void {
  const onKey = (e: KeyboardEvent): void => {
    if (e.key === "Escape") close();
  };
  const modal = el("div", { class: "modal", role: "dialog", "aria-modal": "true", "aria-label": title }, [el("h3", {}, [title]), body]);
  const scrim = el(
    "div",
    {
      class: "scrim",
      onclick: (e) => {
        if (e.target === scrim) close();
      },
    },
    [modal],
  );
  document.body.append(scrim);
  document.addEventListener("keydown", onKey);
  function close(): void {
    document.removeEventListener("keydown", onKey);
    scrim.remove();
  }
  return close;
}

/** A defensive Storage wrapper: in-memory if localStorage is unavailable. */
function safeStorage(): StorageLike {
  try {
    if (typeof localStorage !== "undefined") {
      const probe = "ce-chat:probe";
      localStorage.setItem(probe, "1");
      localStorage.removeItem(probe);
      return localStorage;
    }
  } catch {
    /* fall through to memory */
  }
  const m = new Map<string, string>();
  return {
    getItem: (k) => (m.has(k) ? m.get(k)! : null),
    setItem: (k, v) => void m.set(k, v),
    removeItem: (k) => void m.delete(k),
  };
}

// Clean up timers if the page is torn down.
if (typeof window !== "undefined") {
  window.addEventListener("beforeunload", () => {
    app?.service.stop();
    stopTimers();
  });
}
