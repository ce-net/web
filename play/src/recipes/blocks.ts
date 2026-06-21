import type { Recipe } from "../recipe.js";

/** Recipe 2 — stream blocks: typed SSE async-iteration, the live chain. */
export const blocksRecipe: Recipe = {
  id: "stream-blocks",
  num: "02",
  title: "Stream blocks",
  teaches: "GET /blocks/stream — typed SSE, for-await-of",
  desc: "Open the block SSE stream and iterate accepted blocks as they are mined. The SDK exposes it as a typed AsyncIterable, so a plain for-await-of loop gives you live chain tip events.",
  chips: ["streams.blocks()", "GET /blocks/stream", "SSE", "AbortController"],
  needs: ["any-node"],
  source: `import { CeClient } from "@ce-net/sdk";
const ce = new CeClient({ baseUrl: "http://127.0.0.1:8844" });

// Stop after 30s; blocks arrive roughly every ~10s.
const ctrl = new AbortController();
setTimeout(() => ctrl.abort(), 30_000);

for await (const block of ce.streams.blocks({ signal: ctrl.signal })) {
  console.log(\`#\${block.index}  \${block.hash.slice(0, 12)}…  \${block.txCount} txs\`);
}`,
  async run(ctx) {
    ctx.log("waiting for the next block (≈10s cadence)…");
    let count = 0;
    for await (const block of ctx.ce.streams.blocks({ signal: ctx.signal })) {
      ctx.event(
        `#${block.index}  ${block.hash.slice(0, 12)}…  ${block.txCount} txs  miner ${block.miner.slice(0, 8)}…`,
      );
      if (++count >= 5) {
        ctx.ok(`received ${count} blocks — stopping the stream`);
        break;
      }
    }
  },
};
