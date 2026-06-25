/**
 * Display formatting: node ids, relative time, byte sizes, initials.
 * Pure functions — no DOM, no clock reads (callers pass `now`), so they unit-test
 * deterministically.
 */

/** Shorten a 64-hex node id to `abcd…wxyz` for compact display. */
export function shortId(nodeId: string, head = 4, tail = 4): string {
  const id = nodeId.trim();
  if (id.length <= head + tail + 1) return id;
  return `${id.slice(0, head)}…${id.slice(-tail)}`;
}

/** Two-character avatar initials from a name or node id. */
export function initials(nameOrId: string): string {
  const s = nameOrId.trim();
  if (s.length === 0) return "??";
  const words = s.split(/\s+/).filter(Boolean);
  if (words.length >= 2) {
    return (words[0]![0]! + words[1]![0]!).toUpperCase();
  }
  // Single token: first two alnum chars.
  const alnum = s.replace(/[^a-z0-9]/gi, "");
  return (alnum.slice(0, 2) || s.slice(0, 2)).toUpperCase();
}

/**
 * Deterministic hue (0-359) from a node id, for avatar tinting. Stable across
 * sessions so the same peer always gets the same color.
 */
export function hueFor(nodeId: string): number {
  let h = 2166136261 >>> 0; // FNV-1a
  for (let i = 0; i < nodeId.length; i++) {
    h ^= nodeId.charCodeAt(i);
    h = Math.imul(h, 16777619) >>> 0;
  }
  return h % 360;
}

/** Compact relative time: "now", "3m", "2h", "4d", else a date. */
export function relativeTime(ts: number, now: number): string {
  if (!Number.isFinite(ts) || ts <= 0) return "";
  const diff = now - ts;
  if (diff < 0) return "now";
  const s = Math.floor(diff / 1000);
  if (s < 10) return "now";
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h`;
  const d = Math.floor(h / 24);
  if (d < 7) return `${d}d`;
  return new Date(ts).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

/** Wall-clock HH:MM for a message timestamp. */
export function clockTime(ts: number): string {
  if (!Number.isFinite(ts) || ts <= 0) return "";
  return new Date(ts).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
}

/** Human byte size, base-1024: "812 B", "4.0 KB", "1.4 MB". */
export function formatBytes(n: number): string {
  if (!Number.isFinite(n) || n < 0) return "0 B";
  if (n < 1024) return `${n} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let v = n / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v.toFixed(1)} ${units[i]}`;
}

/** UTF-8 byte length of a string (what actually goes over the mesh). */
export function utf8Len(s: string): number {
  return new TextEncoder().encode(s).length;
}
