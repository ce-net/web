/** The live output console: an append-only, classified, timestamped log pane. */

export type LogKind = "in" | "ok" | "er" | "ev" | "dim";

export class Console {
  private readonly el: HTMLElement;
  private empty = true;

  constructor(el: HTMLElement) {
    this.el = el;
  }

  clear(): void {
    this.el.replaceChildren();
    this.empty = true;
    const span = document.createElement("span");
    span.className = "empty";
    span.textContent = "Click Run to execute this recipe against the connected node.";
    this.el.appendChild(span);
  }

  append(kind: LogKind, msg: string): void {
    if (this.empty) {
      this.el.replaceChildren();
      this.empty = false;
    }
    const line = document.createElement("span");
    line.className = `log ${kind}`;
    const ts = document.createElement("span");
    ts.className = "ts";
    ts.textContent = stamp();
    line.appendChild(ts);
    line.appendChild(document.createTextNode(msg));
    this.el.appendChild(line);
    // Keep the latest line in view.
    this.el.scrollTop = this.el.scrollHeight;
  }
}

function stamp(): string {
  const d = new Date();
  const p = (n: number, w = 2) => String(n).padStart(w, "0");
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}.${p(d.getMilliseconds(), 3)}`;
}
