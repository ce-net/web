import type { Recipe } from "../recipe.js";

/** Recipe 3 — stream transactions: watch the economy live. */
export const txnsRecipe: Recipe = {
  id: "stream-txns",
  num: "03",
  title: "Stream transactions",
  teaches: "GET /transactions/stream — the live economy",
  desc: "Subscribe to every verified transaction as it propagates: uptime rewards, transfers, job bids, settlements. Amounts arrive as base-unit Amounts — never floats.",
  chips: ["streams.transactions()", "GET /transactions/stream", "TxKind", "Amount"],
  needs: ["any-node"],
  source: `import { CeClient } from "@ce-net/sdk";
const ce = new CeClient({ baseUrl: "http://127.0.0.1:8844" });

const ctrl = new AbortController();
setTimeout(() => ctrl.abort(), 30_000);

for await (const tx of ce.streams.transactions({ signal: ctrl.signal })) {
  // tx.amount is an Amount (bigint base units) — print human credits.
  console.log(\`\${tx.kind.padEnd(12)} \${tx.amount.toCredits()} cr  by \${tx.origin.slice(0, 8)}…\`);
}`,
  async run(ctx) {
    ctx.log("watching verified transactions…");
    let count = 0;
    for await (const tx of ctx.ce.streams.transactions({ signal: ctx.signal })) {
      ctx.event(
        `${tx.kind.padEnd(12)} ${tx.amount.toCredits().padStart(8)} cr  by ${tx.origin.slice(0, 8)}…`,
      );
      if (++count >= 8) {
        ctx.ok(`saw ${count} transactions — stopping`);
        break;
      }
    }
  },
};
