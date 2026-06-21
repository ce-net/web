import type { Recipe } from "../recipe.js";
import { short } from "../recipe.js";

/** Recipe 1 — node status: the simplest read, proves the connection works. */
export const statusRecipe: Recipe = {
  id: "status",
  num: "01",
  title: "Node status",
  teaches: "GET /status — node id, chain height, balance",
  desc: "The smallest possible CE program: connect to a node and read its identity, chain height, and credit balance. Every other recipe builds on this client.",
  chips: ["status()", "GET /status", "GET /bootstrap", "Amount"],
  needs: ["any-node"],
  source: `import { CeClient } from "@ce-net/sdk";

// Browser node via the in-page bridge, or your own \`ce start\` on :8844.
const ce = new CeClient({ baseUrl: "http://127.0.0.1:8844" });

const me = await ce.status.status();
console.log("node    ", me.nodeId);
console.log("height  ", me.height);
console.log("balance ", me.balance.toCredits(), "credits");
console.log("free    ", me.free.toCredits(), "credits");

const boot = await ce.bootstrap();
console.log("peers   ", boot.peers.length);`,
  async run(ctx) {
    const me = await ctx.ce.status.status();
    ctx.ok(`node     ${me.nodeId}`);
    ctx.log(`height   ${me.height}`);
    ctx.log(`balance  ${me.balance.toCredits()} credits`);
    ctx.log(`free     ${me.free.toCredits()} credits  (spendable)`);
    ctx.log(`bond     ${me.bond.toCredits()} credits`);
    ctx.log(`weight   ${me.weight}`);
    const boot = await ctx.ce.bootstrap();
    ctx.log(`peers    ${boot.peers.length} bootstrap multiaddr(s)`);
    for (const p of boot.peers.slice(0, 3)) ctx.dim(`  ${short(p, 60)}`);
  },
};
