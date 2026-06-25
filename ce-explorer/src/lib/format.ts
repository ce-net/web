import { Amount } from "@ce-net/sdk";

/**
 * Display helpers. All money goes through {@link Amount} (base units, never
 * floats); these functions only choose how to render an already-correct value.
 */

/**
 * Render a credit Amount for display: groups thousands and caps the fractional
 * part to `maxFrac` places without ever using `parseFloat`. The integer part
 * may be arbitrarily large (supply can reach 21 billion credits).
 *
 * `Amount.toCredits()` already trims trailing zeros and never loses precision;
 * we re-group the integer digits and truncate the fraction for readability.
 */
export function formatCredits(a: Amount, maxFrac = 4): string {
  const neg = a.isNegative();
  const raw = a.toCredits(); // e.g. "-1234.5"
  const body = neg ? raw.slice(1) : raw;
  const [intPart, fracPart = ""] = body.split(".");
  const grouped = groupThousands(intPart);
  const frac = fracPart.slice(0, maxFrac).replace(/0+$/, "");
  const sign = neg ? "-" : "";
  return frac.length > 0 ? `${sign}${grouped}.${frac}` : `${sign}${grouped}`;
}

/** `formatCredits` plus a `cr` suffix, the explorer's short unit label. */
export function formatCreditsUnit(a: Amount, maxFrac = 4): string {
  return `${formatCredits(a, maxFrac)} cr`;
}

/** Insert thousands separators into a non-negative integer digit string. */
export function groupThousands(digits: string): string {
  if (digits.length <= 3) return digits;
  const out: string[] = [];
  let i = digits.length;
  while (i > 3) {
    out.unshift(digits.slice(i - 3, i));
    i -= 3;
  }
  out.unshift(digits.slice(0, i));
  return out.join(",");
}

/** Human byte sizes (1024-based), e.g. 2048 -> "2 KiB", 1572864 -> "1.5 MiB". */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return "—";
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KiB", "MiB", "GiB", "TiB", "PiB"];
  let v = bytes / 1024;
  let u = 0;
  while (v >= 1024 && u < units.length - 1) {
    v /= 1024;
    u += 1;
  }
  const s = v >= 100 ? v.toFixed(0) : v >= 10 ? v.toFixed(1) : v.toFixed(2);
  return `${trimZeros(s)} ${units[u]}`;
}

/** Memory in MiB as the atlas reports it: 512 -> "512 MiB", 4096 -> "4 GiB". */
export function formatMemMb(mb: number): string {
  return formatBytes(Math.round(mb * 1024 * 1024));
}

function trimZeros(s: string): string {
  return s.includes(".") ? s.replace(/\.?0+$/, "") : s;
}

/** Short hash/id: first `head` and last `tail` chars joined by an ellipsis. */
export function shortHash(hex: string, head = 6, tail = 6): string {
  if (typeof hex !== "string") return "";
  if (hex.length <= head + tail + 1) return hex;
  return `${hex.slice(0, head)}…${hex.slice(-tail)}`;
}

/** Compact relative time from a unix-seconds timestamp, e.g. "12s ago". */
export function timeAgo(unixSecs: number, now = Date.now()): string {
  const deltaMs = now - unixSecs * 1000;
  return relativePast(deltaMs);
}

/** Compact relative time from a millisecond delta (already elapsed). */
export function relativePast(deltaMs: number): string {
  if (deltaMs < 0) return "just now";
  const s = Math.floor(deltaMs / 1000);
  if (s < 1) return "just now";
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  return `${d}d ago`;
}

/** Seconds -> a compact duration like "90s" -> "1m 30s", "3600" -> "1h". */
export function formatDuration(secs: number): string {
  if (!Number.isFinite(secs) || secs < 0) return "—";
  const s = Math.floor(secs);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  const rem = s % 60;
  if (m < 60) return rem ? `${m}m ${rem}s` : `${m}m`;
  const h = Math.floor(m / 60);
  const mm = m % 60;
  return mm ? `${h}h ${mm}m` : `${h}h`;
}

/** A non-cryptographic, deterministic hue (0–359) derived from an id string. */
export function hueFromId(id: string): number {
  let h = 2166136261;
  for (let i = 0; i < id.length; i++) {
    h ^= id.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return Math.abs(h) % 360;
}
