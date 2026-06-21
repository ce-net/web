import { Amount } from "@ce-net/sdk";
import type { Recipe } from "../recipe.js";

/** Recipe 7 — place a job: bid → poll → settle lifecycle. */
export const jobRecipe: Recipe = {
  id: "place-job",
  num: "07",
  title: "Place a job",
  teaches: "POST /jobs/bid, GET /jobs/:id — the compute lifecycle",
  desc: "Broadcast a container job bid; any host with capacity may take it. Poll its status from pending → running → settled. This is the core CE value loop: spend credits to run compute on someone else's machine.",
  chips: ["jobs.bid()", "jobs.get()", "BidSpec", "Amount", "POST /jobs/bid"],
  needs: ["any-node", "write"],
  note: "Bidding locks credits (a write — needs a token on a local node). Settlement requires a Docker host on the mesh; without one the job stays pending, which the poll loop reports honestly.",
  source: `import { CeClient, Amount } from "@ce-net/sdk";
const ce = new CeClient({ baseUrl: "http://127.0.0.1:8844", token: process.env.CE_API_TOKEN });

const jobId = await ce.jobs.bid({
  image: "alpine:latest",
  cmd: ["echo", "hello from CE"],
  cpuCores: 1, memMb: 64, durationSecs: 30,
  bid: Amount.fromCredits("1"),         // → "1000000000000000000" on the wire
});
console.log("placed job", jobId);

for (;;) {
  const job = await ce.jobs.get(jobId);
  console.log("  status:", job.status);
  if (job.status === "settled" || job.status.startsWith("failed")) break;
  await new Promise(r => setTimeout(r, 2000));
}`,
  async run(ctx) {
    ctx.log("placing a bid (alpine echo, 1 credit)…");
    const jobId = await ctx.ce.jobs.bid({
      image: "alpine:latest",
      cmd: ["echo", "hello from CE"],
      cpuCores: 1,
      memMb: 64,
      durationSecs: 30,
      bid: Amount.fromCredits("1"),
    });
    ctx.ok(`placed job ${jobId}`);
    for (let i = 0; i < 8; i++) {
      const job = await ctx.ce.jobs.get(jobId);
      ctx.log(`  status: ${job.status}${job.cost ? `  cost ${job.cost.toCredits()} cr` : ""}`);
      if (job.status === "settled" || job.status.startsWith("failed")) {
        ctx.ok(`job reached terminal state: ${job.status}`);
        return;
      }
      await ctx.sleep(2000);
    }
    ctx.dim("still pending after 8 polls — no Docker host took it on this mesh (expected in-browser).");
  },
};
