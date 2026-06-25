import { el } from "./dom.js";
import { hueFromId } from "../lib/format.js";

/**
 * The pulse rail: a sonar sweep along the top. Every newly accepted block fires
 * a ping that rises and ripples, tinted by the miner's id, so you can literally
 * watch the chain advance. The big number on the right is the live tip height.
 */
export class PulseRail {
  readonly root: HTMLElement;
  private track: HTMLElement;
  private heightEl: HTMLElement;
  private x = 6;
  private lastIndex = -1;

  constructor() {
    this.track = el("div", { class: "rail-track", style: "position:absolute; inset:0" });
    this.heightEl = el("div", { class: "rail-height" }, [
      el("small", { text: "tip height" }),
      document.createTextNode("—"),
    ]);
    this.root = el("div", { class: "rail", role: "img", "aria-label": "Live block arrival sonar" }, [
      el("span", { class: "rail-label", text: "mesh pulse" }),
      this.track,
      this.heightEl,
    ]);
  }

  /** Set the displayed tip height (text node is the last child). */
  setHeight(height: number): void {
    this.heightEl.lastChild!.textContent = height >= 0 ? `#${height}` : "—";
  }

  /** Fire a ping for a block. De-dupes by index so re-renders don't double-ping. */
  ping(index: number, minerId: string): void {
    if (index <= this.lastIndex) return;
    this.lastIndex = index;
    const hue = hueFromId(minerId);
    const width = this.track.clientWidth || 1200;
    this.x += 40;
    if (this.x > width - 8) this.x = 6;
    const h = 14 + (hueFromId(minerId + "h") % 30); // 14..44px
    const ping = el("div", {
      class: "ping",
      style: `left:${this.x}px; height:${h}px; --tint:hsl(${hue} 70% 60%)`,
    }, [el("span", { class: "blip" })]);
    this.track.append(ping);
    // Keep the DOM bounded — drop pings older than the sweep window.
    while (this.track.children.length > 40) this.track.firstElementChild?.remove();
  }
}
