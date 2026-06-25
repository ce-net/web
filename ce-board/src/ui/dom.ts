/** Tiny DOM helpers. No framework — the board view is hand-rolled for control + zero deps. */

type Attrs = Record<string, string | number | boolean | undefined> & {
  text?: string;
  html?: string;
};

/** Create an element with attributes, optional text/html, and children. */
export function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attrs: Attrs = {},
  ...children: (Node | string)[]
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === undefined || v === false) continue;
    if (k === "text") node.textContent = String(v);
    else if (k === "html") node.innerHTML = String(v);
    else if (k === "class") node.className = String(v);
    else if (k.startsWith("data-") || k === "role" || k.startsWith("aria-"))
      node.setAttribute(k, String(v));
    else if (v === true) node.setAttribute(k, "");
    else node.setAttribute(k, String(v));
  }
  for (const c of children) node.append(c);
  return node;
}

/** Remove all children of a node. */
export function clear(node: Element): void {
  while (node.firstChild) node.removeChild(node.firstChild);
}
