import type { Recipe } from "../recipe.js";

/** Recipe 8 — atlas: peer capacity + reputation substrate for host selection. */
export const atlasRecipe: Recipe = {
  id: "atlas",
  num: "08",
  title: "Atlas & reputation",
  teaches: "GET /atlas, GET /history/:id — capacity-aware placement",
  desc: "Read the peer capacity atlas (who has cores, RAM, GPUs, free capacity) and per-node interaction history (the reputation substrate). Together they let an app rank hosts before placing work — the pattern swarm distills for GPU one-shots.",
  chips: ["atlas()", "history()", "AtlasEntry", "deliveredWork()"],
  needs: ["any-node"],
  source: `import { CeClient } from "@ce-net/sdk";
const ce = new CeClient({ baseUrl: "http://127.0.0.1:8844" });

const hosts = await ce.atlas();                    // GET /atlas
for (const h of hosts) {
  console.log(\`\${h.nodeId.slice(0,8)}…  \${h.cpuCores} cores  \${h.memMb} MB  jobs=\${h.runningJobs}  [\${h.tags.join(",")}]\`);
}

// Rank candidates by delivered work (reputation), like swarm::select_hosts.
const best = hosts[0];
if (best) {
  const hist = await ce.history(best.nodeId);      // GET /history/:id
  console.log("delivered work:", hist.deliveredWork());
}`,
  async run(ctx) {
    ctx.log("reading the peer capacity atlas…");
    const hosts = await ctx.ce.atlas();
    if (hosts.length === 0) {
      ctx.dim("atlas is empty — no hosts have advertised capacity on this mesh yet.");
      return;
    }
    for (const h of hosts.slice(0, 8)) {
      ctx.event(
        `${h.nodeId.slice(0, 8)}…  ${h.cpuCores} cores  ${h.memMb} MB  jobs=${h.runningJobs}  [${h.tags.join(",") || "—"}]`,
      );
    }
    const best = hosts[0];
    if (best) {
      ctx.log(`ranking ${best.nodeId.slice(0, 8)}… by reputation…`);
      try {
        const hist = await ctx.ce.history(best.nodeId);
        ctx.ok(
          `delivered work ${hist.deliveredWork()}  ·  earned ${hist.earned.toCredits()} cr  ·  ${hist.isNewcomer() ? "newcomer" : "established"}`,
        );
      } catch {
        ctx.dim("no recorded history for that node yet (newcomer).");
      }
    }
  },
};
