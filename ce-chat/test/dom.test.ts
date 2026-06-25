// @vitest-environment jsdom
import { describe, it, expect } from "vitest";
import { el, clear, linkify, tokenizeMessage, mentionsIn } from "../src/ui/dom.ts";

describe("tokenizeMessage (pure)", () => {
  it("returns a single text token for plain text", () => {
    expect(tokenizeMessage("hello world")).toEqual([{ kind: "text", value: "hello world" }]);
  });

  it("splits a URL out of surrounding text", () => {
    const t = tokenizeMessage("see https://ce-net.com now");
    expect(t).toEqual([
      { kind: "text", value: "see " },
      { kind: "url", value: "https://ce-net.com" },
      { kind: "text", value: " now" },
    ]);
  });

  it("does not swallow a trailing space or quote into a URL", () => {
    const t = tokenizeMessage('a http://x.io b');
    const url = t.find((x) => x.kind === "url")!;
    expect(url.value).toBe("http://x.io");
  });

  it("parses @name and @nodeId mentions", () => {
    const node = "a".repeat(64);
    const t = tokenizeMessage(`hi @leif and @${node}!`);
    const mentions = t.filter((x) => x.kind === "mention").map((x) => (x as { value: string }).value);
    expect(mentions).toEqual(["leif", node]);
  });

  it("does not treat an email-like @ inside a word as a mention", () => {
    const t = tokenizeMessage("write me at foo@example.com");
    // 'foo@example' has an alnum char immediately before '@', so no mention fires.
    expect(t.some((x) => x.kind === "mention")).toBe(false);
  });

  it("renders inline code spans and keeps a URL inside backticks literal", () => {
    const t = tokenizeMessage("run `curl https://x.io` ok");
    const code = t.find((x) => x.kind === "code")!;
    expect(code.value).toBe("curl https://x.io");
    // No url token, because the URL is inside the code span.
    expect(t.some((x) => x.kind === "url")).toBe(false);
  });

  it("coalesces adjacent text runs", () => {
    const t = tokenizeMessage("plain, more, text");
    expect(t).toHaveLength(1);
    expect(t[0]).toEqual({ kind: "text", value: "plain, more, text" });
  });
});

describe("mentionsIn", () => {
  it("returns lowercased mention handles", () => {
    expect(mentionsIn("yo @Alice @BOB")).toEqual(["alice", "bob"]);
  });
  it("returns empty for no mentions", () => {
    expect(mentionsIn("no one here")).toEqual([]);
  });
});

describe("linkify (DOM, injection-safe)", () => {
  it("never injects HTML — a script tag stays inert text", () => {
    const nodes = linkify('<img src=x onerror=alert(1)> hello');
    const container = el("div", {}, nodes);
    // The malicious markup is a text node, not parsed elements.
    expect(container.querySelector("img")).toBeNull();
    expect(container.textContent).toContain("<img src=x onerror=alert(1)>");
  });

  it("renders a URL as an anchor with safe rel/target", () => {
    const container = el("div", {}, linkify("go https://ce-net.com"));
    const a = container.querySelector("a")!;
    expect(a.getAttribute("href")).toBe("https://ce-net.com");
    expect(a.getAttribute("rel")).toBe("noopener noreferrer");
    expect(a.getAttribute("target")).toBe("_blank");
  });

  it("highlights a self mention", () => {
    const container = el("div", {}, linkify("ping @me", new Set(["me"])));
    const m = container.querySelector(".mention")!;
    expect(m.classList.contains("self")).toBe(true);
    expect(m.textContent).toBe("@me");
  });

  it("renders a non-self mention without the self class", () => {
    const container = el("div", {}, linkify("ping @other", new Set(["me"])));
    const m = container.querySelector(".mention")!;
    expect(m.classList.contains("self")).toBe(false);
  });

  it("renders inline code as a <code> element", () => {
    const container = el("div", {}, linkify("use `x=1`"));
    expect(container.querySelector("code.inline-code")!.textContent).toBe("x=1");
  });
});

describe("el / clear", () => {
  it("attaches event listeners from on* keys", () => {
    let clicked = 0;
    const btn = el("button", { onclick: () => clicked++ }, ["go"]);
    btn.dispatchEvent(new Event("click"));
    expect(clicked).toBe(1);
  });

  it("skips false/null/undefined attrs and sets boolean true as empty attr", () => {
    const inp = el("input", { disabled: true, value: undefined, hidden: false });
    expect(inp.getAttribute("disabled")).toBe("");
    expect(inp.hasAttribute("hidden")).toBe(false);
  });

  it("clear() empties a node", () => {
    const d = el("div", {}, ["a", el("span", {}, ["b"])]);
    expect(d.childNodes.length).toBe(2);
    clear(d);
    expect(d.childNodes.length).toBe(0);
  });
});
