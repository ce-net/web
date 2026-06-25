/** Right-click context menu — accessible, keyboard-dismissable, positioned within viewport. */

import { el } from "../lib/dom.js";

export interface MenuItem {
  label: string;
  icon?: string;
  danger?: boolean;
  disabled?: boolean;
  onSelect: () => void;
}

let openMenu: HTMLElement | null = null;

export function closeContextMenu(): void {
  if (openMenu) {
    openMenu.remove();
    openMenu = null;
    document.removeEventListener("keydown", onKey, true);
  }
}

function onKey(e: KeyboardEvent): void {
  if (e.key === "Escape") closeContextMenu();
}

export function showContextMenu(x: number, y: number, items: MenuItem[]): void {
  closeContextMenu();
  const menu = el(
    "div",
    { class: "ctx-menu", role: "menu" },
    ...items.map((it) =>
      it.label === "—"
        ? el("div", { class: "ctx-sep", role: "separator" })
        : el(
            "button",
            {
              class: it.danger ? "ctx-item danger" : "ctx-item",
              role: "menuitem",
              type: "button",
              disabled: it.disabled === true,
              onclick: () => {
                closeContextMenu();
                it.onSelect();
              },
            },
            it.icon ? el("span", { class: "icon-inline", html: it.icon }) : null,
            el("span", {}, it.label),
          ),
    ),
  );

  menu.style.visibility = "hidden";
  document.body.append(menu);
  // Clamp within the viewport.
  const rect = menu.getBoundingClientRect();
  const px = Math.min(x, window.innerWidth - rect.width - 8);
  const py = Math.min(y, window.innerHeight - rect.height - 8);
  menu.style.left = `${Math.max(8, px)}px`;
  menu.style.top = `${Math.max(8, py)}px`;
  menu.style.visibility = "visible";

  openMenu = menu;
  setTimeout(() => {
    document.addEventListener("keydown", onKey, true);
    document.addEventListener("mousedown", onOutside, true);
  }, 0);
  menu.querySelector<HTMLElement>(".ctx-item")?.focus();
}

function onOutside(e: MouseEvent): void {
  if (openMenu && !openMenu.contains(e.target as Node)) {
    closeContextMenu();
    document.removeEventListener("mousedown", onOutside, true);
  }
}
