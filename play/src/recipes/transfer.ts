import { Amount } from "@ce-net/sdk";
import type { Recipe } from "../recipe.js";

/** Recipe 5 — transfer credits: the money model, base-unit strings, no floats. */
export const transferRecipe: Recipe = {
  id: "transfer-credits",
  num: "05",
  title: "Transfer credits",
  teaches: "POST /transfer — integer base units, never floats",
  desc: "Move credits to another node. The load-bearing lesson is the money model: 1 credit = 10^18 base units, carried on the wire as a decimal string, because the value exceeds JavaScript's 2^53 safe integer. Amount handles this — you never touch a float.",
  chips: ["transfer()", "Amount.fromCredits()", "POST /transfer", "bigint base units"],
  needs: ["any-node", "write"],
  note: "Transfer is a signed write: on a local node it needs a token in the field above. On the in-browser node it spends that node's own balance.",
  source: `import { CeClient, Amount } from "@ce-net/sdk";
const ce = new CeClient({ baseUrl: "http://127.0.0.1:8844", token: process.env.CE_API_TOKEN });

// MONEY MODEL: 1 credit = 1_000_000_000_000_000_000 base units (10^18), wei-style.
// We construct the Amount from a credit *string* — never a float.
const amount = Amount.fromCredits("1.5");
console.log("wire amount:", amount.toBaseUnits()); // "1500000000000000000"

const recipient = "<64-hex node id>";
const txId = await ce.transfer(recipient, amount);  // POST /transfer
console.log("transfer tx", txId);`,
  async run(ctx) {
    const amount = Amount.fromCredits("1.5");
    ctx.log(`Amount.fromCredits("1.5") → ${amount.toBaseUnits()} base units (no float, ever)`);
    // Self-transfer keeps the demo safe: it touches the ledger without moving net value.
    const me = await ctx.ce.getStatus();
    if (me.free.cmp(amount) < 0) {
      ctx.dim(`balance ${me.free.toCredits()} cr is below 1.5 — sending 0 instead to demo the call shape`);
      const tx = await ctx.ce.transfer(me.nodeId, Amount.fromCredits("0"));
      ctx.ok(`transfer tx ${tx}`);
      return;
    }
    ctx.log(`self-transferring 1.5 cr (touches the ledger, net-zero) to ${me.nodeId.slice(0, 10)}…`);
    const tx = await ctx.ce.transfer(me.nodeId, amount);
    ctx.ok(`transfer tx ${tx}`);
  },
};
