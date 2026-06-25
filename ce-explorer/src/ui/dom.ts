/** Tiny typed DOM helpers — no framework, just ergonomic `createElement`. */

type Attrs = Record<string, string | number | boolean | undefined | EventListener> & {
  class?: string;
  text?: string;
  html?: string;
};

type Child = Node | string | null | undefined | false;

export function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attrs: Attrs = {},
  children: Child[] = [],
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === undefined || v === false) continue;
    if (k === "class") node.className = String(v);
    else if (k === "text") node.textContent = String(v);
    else if (k === "html") node.innerHTML = String(v);
    else if (k.startsWith("on") && typeof v === "function") {
      node.addEventListener(k.slice(2).toLowerCase(), v as EventListener);
    } else if (typeof v === "boolean") {
      if (v) node.setAttribute(k, "");
    } else {
      node.setAttribute(k, String(v));
    }
  }
  for (const c of children) {
    if (c === null || c === undefined || c === false) continue;
    node.append(typeof c === "string" ? document.createTextNode(c) : c);
  }
  return node;
}

/** Replace all children of `parent` with `nodes`. */
export function mount(parent: Element, ...nodes: Child[]): void {
  parent.replaceChildren(...nodes.filter((n): n is Node | string => !!n).map((n) =>
    typeof n === "string" ? document.createTextNode(n) : n,
  ));
}

export function $(sel: string, root: ParentNode = document): HTMLElement | null {
  return root.querySelector(sel);
}
