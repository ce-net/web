/** Pure formatting helpers — sizes, times, names. */

const UNITS = ["B", "KB", "MB", "GB", "TB"];

/** Human byte size, e.g. `1.4 MB`. */
export function formatBytes(n: number | undefined): string {
  if (n === undefined) return "—";
  if (n < 1) return "0 B";
  let v = n;
  let u = 0;
  while (v >= 1024 && u < UNITS.length - 1) {
    v /= 1024;
    u += 1;
  }
  const s = v >= 10 || u === 0 ? v.toFixed(0) : v.toFixed(1);
  return `${s} ${UNITS[u]}`;
}

/** Relative time, e.g. `3 min ago`, `2 days ago`, falling back to a date. */
export function formatRelative(ms: number): string {
  const diff = Date.now() - ms;
  const sec = Math.round(diff / 1000);
  if (sec < 5) return "just now";
  if (sec < 60) return `${sec} sec ago`;
  const min = Math.round(sec / 60);
  if (min < 60) return `${min} min ago`;
  const hr = Math.round(min / 60);
  if (hr < 24) return `${hr} hr ago`;
  const day = Math.round(hr / 24);
  if (day < 30) return `${day} day${day === 1 ? "" : "s"} ago`;
  return new Date(ms).toLocaleDateString();
}

/** Absolute timestamp for tooltips. */
export function formatExact(ms: number): string {
  return new Date(ms).toLocaleString();
}

/** Shorten a CID/node id for compact display. */
export function shortId(id: string, head = 8, tail = 4): string {
  if (id.length <= head + tail + 1) return id;
  return `${id.slice(0, head)}…${id.slice(-tail)}`;
}

/** A file's extension (lowercase, no dot), or empty string. */
export function extOf(name: string): string {
  const dot = name.lastIndexOf(".");
  return dot > 0 ? name.slice(dot + 1).toLowerCase() : "";
}
