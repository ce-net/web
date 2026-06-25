/** Tiny typed DOM helpers — no framework. */

type Attrs = Record<string, string | number | boolean | undefined | null | EventListener>;

/** Create an element with attributes and children. `on*` keys attach listeners. */
export function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attrs: Attrs = {},
  children: (Node | string)[] = [],
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === undefined || v === null || v === false) continue;
    if (k.startsWith("on") && typeof v === "function") {
      node.addEventListener(k.slice(2).toLowerCase(), v as EventListener);
    } else if (k === "class") {
      node.className = String(v);
    } else if (k === "html") {
      node.innerHTML = String(v);
    } else if (v === true) {
      node.setAttribute(k, "");
    } else {
      node.setAttribute(k, String(v));
    }
  }
  for (const c of children) node.append(typeof c === "string" ? document.createTextNode(c) : c);
  return node;
}

export function clear(node: Element): void {
  while (node.firstChild) node.removeChild(node.firstChild);
}

/** A token produced by {@link tokenizeMessage}. */
export type RichToken =
  | { kind: "text"; value: string }
  | { kind: "url"; value: string }
  | { kind: "mention"; value: string; raw: string }
  | { kind: "code"; value: string };

const URL_RE = /\bhttps?:\/\/[^\s<>"]+/g;
// @name or @<64-hex-node-id>; names are [A-Za-z0-9._-], 1..64.
const MENTION_RE = /(^|[^A-Za-z0-9_])@([A-Za-z0-9._-]{1,64}|[0-9a-fA-F]{64})\b/g;
// `inline code`
const CODE_RE = /`([^`\n]{1,400})`/g;

/**
 * Tokenize a plain-text message body into text / url / mention / code spans.
 * Pure (no DOM), so it unit-tests deterministically and is reused by the mention
 * highlighter. URLs take precedence, then inline code, then mentions, all on the
 * remaining plain text. Never interprets HTML — values are raw text.
 */
export function tokenizeMessage(text: string): RichToken[] {
  // First split out code spans (highest precedence so a URL inside backticks stays literal).
  const out: RichToken[] = [];
  let cm: RegExpExecArray | null;
  CODE_RE.lastIndex = 0;
  const codeRanges: { start: number; end: number; value: string }[] = [];
  while ((cm = CODE_RE.exec(text)) !== null) {
    codeRanges.push({ start: cm.index, end: cm.index + cm[0].length, value: cm[1]! });
  }
  let i = 0;
  for (const r of codeRanges) {
    if (r.start > i) pushPlain(out, text.slice(i, r.start));
    out.push({ kind: "code", value: r.value });
    i = r.end;
  }
  if (i < text.length) pushPlain(out, text.slice(i));
  return out;
}

/** Split a plain (no-code) run into text / url / mention tokens. */
function pushPlain(out: RichToken[], text: string): void {
  // Walk URLs first, then mentions inside the non-URL gaps.
  let m: RegExpExecArray | null;
  URL_RE.lastIndex = 0;
  const urlRanges: { start: number; end: number; value: string }[] = [];
  while ((m = URL_RE.exec(text)) !== null) {
    urlRanges.push({ start: m.index, end: m.index + m[0].length, value: m[0] });
  }
  let i = 0;
  for (const r of urlRanges) {
    if (r.start > i) pushMentions(out, text.slice(i, r.start));
    out.push({ kind: "url", value: r.value });
    i = r.end;
  }
  if (i < text.length) pushMentions(out, text.slice(i));
}

function pushMentions(out: RichToken[], text: string): void {
  let i = 0;
  let m: RegExpExecArray | null;
  MENTION_RE.lastIndex = 0;
  while ((m = MENTION_RE.exec(text)) !== null) {
    const lead = m[1] ?? ""; // delimiter char captured before '@' (belongs to text)
    const handle = m[2]!;
    const atPos = m.index + lead.length; // position of the '@'
    // Everything from the last cut up to and including the lead delimiter is text.
    if (atPos > i) pushText(out, text.slice(i, atPos));
    out.push({ kind: "mention", value: handle, raw: "@" + handle });
    i = m.index + m[0].length;
  }
  if (i < text.length) pushText(out, text.slice(i));
}

/** Append text, coalescing with a trailing text token if present. */
function pushText(out: RichToken[], value: string): void {
  if (value.length === 0) return;
  const prev = out[out.length - 1];
  if (prev && prev.kind === "text") prev.value += value;
  else out.push({ kind: "text", value });
}

/**
 * Render plain text into safe DOM nodes: bare URLs become links, @mentions become
 * highlighted spans (extra-highlighted when they mention `selfHandles`), and inline
 * `code` becomes a <code> span. Never uses innerHTML — every value is a text node,
 * so there is no injection surface.
 */
export function linkify(text: string, selfHandles: ReadonlySet<string> = new Set()): (Node | string)[] {
  const toks = tokenizeMessage(text);
  const out: (Node | string)[] = [];
  for (const t of toks) {
    if (t.kind === "text") {
      out.push(t.value);
    } else if (t.kind === "url") {
      out.push(el("a", { href: t.value, target: "_blank", rel: "noopener noreferrer" }, [t.value]));
    } else if (t.kind === "code") {
      out.push(el("code", { class: "inline-code" }, [t.value]));
    } else {
      const isSelf = selfHandles.has(t.value.toLowerCase());
      out.push(el("span", { class: `mention${isSelf ? " self" : ""}` }, [t.raw]));
    }
  }
  return out;
}

/** Extract the lowercased mention handles from a message body. */
export function mentionsIn(text: string): string[] {
  return tokenizeMessage(text)
    .filter((t): t is Extract<RichToken, { kind: "mention" }> => t.kind === "mention")
    .map((t) => t.value.toLowerCase());
}
