/**
 * Inline SVG icon set (app-authored markup only). Returned as strings for `el(..., {html})`.
 * Stroke-based, currentColor, 24x24 viewbox — Lucide-style, calm and consistent.
 */

import { extOf } from "./format.js";
import type { NodeKind } from "../core/model.js";

function svg(paths: string): string {
  return `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths}</svg>`;
}

export const icons = {
  folder: svg(`<path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/>`),
  file: svg(`<path d="M14 3v4a1 1 0 0 0 1 1h4"/><path d="M5 3h9l5 5v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2z"/>`),
  fileText: svg(`<path d="M14 3v4a1 1 0 0 0 1 1h4"/><path d="M5 3h9l5 5v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2z"/><path d="M9 13h6M9 17h6M9 9h1"/>`),
  fileImage: svg(`<path d="M14 3v4a1 1 0 0 0 1 1h4"/><path d="M5 3h9l5 5v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2z"/><circle cx="9" cy="12" r="1.4"/><path d="m7 18 3-3 2 2 3-4 2 5"/>`),
  fileCode: svg(`<path d="M14 3v4a1 1 0 0 0 1 1h4"/><path d="M5 3h9l5 5v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2z"/><path d="m10 12-2 2 2 2M14 12l2 2-2 2"/>`),
  doc: svg(`<path d="M14 3v4a1 1 0 0 0 1 1h4"/><path d="M5 3h9l5 5v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2z"/><path d="M9 13h6M9 17h4"/>`),
  upload: svg(`<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><path d="m7 9 5-5 5 5"/><path d="M12 4v12"/>`),
  download: svg(`<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><path d="m7 11 5 5 5-5"/><path d="M12 16V4"/>`),
  folderPlus: svg(`<path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/><path d="M12 11v4M10 13h4"/>`),
  share: svg(`<circle cx="18" cy="5" r="2.5"/><circle cx="6" cy="12" r="2.5"/><circle cx="18" cy="19" r="2.5"/><path d="m8.2 10.8 7.6-4.6M8.2 13.2l7.6 4.6"/>`),
  rename: svg(`<path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z"/>`),
  copy: svg(`<rect x="9" y="9" width="11" height="11" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/>`),
  trash: svg(`<path d="M3 6h18M8 6V4a1 1 0 0 1 1-1h6a1 1 0 0 1 1 1v2M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/>`),
  restore: svg(`<path d="M3 7v6h6"/><path d="M3.5 13a9 9 0 1 0 2.6-6.4L3 9"/>`),
  history: svg(`<path d="M3 3v6h6"/><path d="M3.5 9a9 9 0 1 1-1 4"/><path d="M12 7v5l4 2"/>`),
  search: svg(`<circle cx="11" cy="11" r="7"/><path d="m21 21-4.3-4.3"/>`),
  shield: svg(`<path d="M12 3 5 6v5c0 5 3 8 7 10 4-2 7-5 7-10V6z"/>`),
  star: svg(`<path d="m12 3 2.6 5.6L21 9.3l-4.5 4.2 1.1 6.1L12 17l-5.6 2.6 1.1-6.1L3 9.3l6.4-.7z"/>`),
  x: svg(`<path d="M18 6 6 18M6 6l12 12"/>`),
  chevron: svg(`<path d="m9 6 6 6-6 6"/>`),
  drive: svg(`<path d="M9 4h6l5 9-3 5H7l-3-5z"/><path d="m9 4 5 9M15 4l-5 9M4 13h11"/>`),
  more: svg(`<circle cx="5" cy="12" r="1.6"/><circle cx="12" cy="12" r="1.6"/><circle cx="19" cy="12" r="1.6"/>`),
  link: svg(`<path d="M10 13a5 5 0 0 0 7 0l2-2a5 5 0 0 0-7-7l-1 1"/><path d="M14 11a5 5 0 0 0-7 0l-2 2a5 5 0 0 0 7 7l1-1"/>`),
  check: svg(`<path d="m5 13 4 4L19 7"/>`),
  dot: svg(`<circle cx="12" cy="12" r="5"/>`),
};

/** Pick an icon for a node by kind + extension. */
export function iconFor(kind: NodeKind, name: string): string {
  if (kind === "dir") return icons.folder;
  if (kind === "cedoc") return icons.doc;
  const ext = extOf(name);
  if (["png", "jpg", "jpeg", "gif", "svg", "webp", "avif"].includes(ext)) return icons.fileImage;
  if (["ts", "js", "rs", "py", "go", "json", "toml", "yaml", "yml", "sh", "html", "css"].includes(ext))
    return icons.fileCode;
  if (["md", "txt", "rtf", "log", "csv"].includes(ext)) return icons.fileText;
  return icons.file;
}
