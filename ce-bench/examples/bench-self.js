/**
 * Example: benchmark THIS machine (localhost) and print the NodeProfile that ce-bench would publish.
 *
 * This is the P2 capsule's job done from the host's own process: read /beacon for a verifiable seed,
 * run the portable suite (CPU GFLOPS / integer / memory bandwidth / disk / LLM micro-bench), detect
 * the environment, fold it all into a structurally-valid signed-shaped NodeProfile, and show the
 * FabricStats-style headline it contributes.
 *
 *   Run with a beacon seed from a live node:  node examples/bench-self.js [http://localhost:8844]
 *   Run fully offline (no node, no network):  node examples/bench-self.js --mock
 *
 * The profile printed is UNSIGNED — signing happens on the node (POST /profile/publish), the app
 * never holds a key. With `--publish` and a live node this example would also publish it (commented
 * at the bottom; off by default so the example is side-effect-free).
 */

import { benchLocal } from "../src/runner.js";
import { detectEnv, assembleProfile } from "../src/profile.js";
import { recheck, REF_MODEL } from "../src/benchmarks.js";
import { perfScore } from "../src/fabricstats.js";
import { CeClient } from "../src/ce.js";

/** A mock CE client: a fixed beacon + a synthetic node id, so the example runs with no node up. */
function mockClient() {
  return {
    beacon: async () => ({ height: 88888, hash: "a1b2c3d4e5f600112233445566778899" }),
    status: async () => ({ node_id: "a".repeat(64), height: 88888, balance: "0" }),
  };
}

async function main() {
  const args = process.argv.slice(2);
  const mock = args.includes("--mock") || args.includes("-m");
  const baseUrl = args.find((a) => a.startsWith("http")) || "http://localhost:8844";

  const ce = mock ? mockClient() : new CeClient({ baseUrl });
  console.log(
    mock
      ? "Benchmarking localhost (offline; synthetic beacon + node id via --mock)\n"
      : `Benchmarking localhost; beacon + node id from ${baseUrl}\n`,
  );

  // 1. beacon (verifiable seed — every probe in this run shares it so a verifier can reproduce it).
  const beacon = await ce.beacon();

  // 2. node id from /status (the profile is keyed to it). Fall back to "self" if the node has none.
  let nodeId = "self";
  try {
    const st = await ce.status();
    if (st && typeof st.node_id === "string" && st.node_id) nodeId = st.node_id;
  } catch {
    /* keep "self" — offline / no node */
  }

  // 3. detect the environment (cores / RAM / OS / runtime flags).
  const env = await detectEnv();

  // 4. run the portable local suite (CPU/mem/disk/LLM), seeded by the beacon hash.
  const results = await benchLocal(mock ? null : ce, { env: "node", seed: beacon });

  // 5. report each probe + verify its scalar matches its own raw evidence (anti-cheat recompute).
  console.log("probes:");
  for (const r of results) {
    const rc = recheck(r);
    console.log(
      `  ${r.kind.padEnd(14)} ${fmt(r.metric)} ${r.unit.padEnd(14)} ` +
        `(${r.ms.toFixed(1)} ms)  recheck=${rc.ok ? "ok" : "MISMATCH"}`,
    );
    if (!rc.ok) throw new Error(`recheck failed for ${r.kind}: ${rc.reason}`);
  }
  console.log(`\nreference LLM model: ${REF_MODEL.name} (${REF_MODEL.hash})`);

  // 6. fold the probes + env into a NodeProfile (validated; throws on any structural problem).
  const profile = assembleProfile({ nodeId, beacon, results, env });

  console.log("\nNodeProfile (unsigned — the node signs on publish):");
  console.log(JSON.stringify(profile, null, 2));

  // 7. the single headline this node contributes to the public FabricStats scoreboard.
  const oneNodeStats = {
    cpu_gflops: profile.cpu.gflops_fp32,
    gpu_tflops: (profile.gpus || []).reduce((s, g) => s + (g.fp16_tflops || 0), 0),
    tokens_per_sec: profile.llm.tokens_per_sec,
  };
  console.log(
    `\nthis node's perf_score contribution: ${perfScore(oneNodeStats).toFixed(1)} ` +
      `(cpu ${profile.cpu.gflops_fp32.toFixed(1)} GFLOPS, ` +
      `${profile.cpu.cores} cores, ${profile.cpu.mem_bw_gbps.toFixed(1)} GB/s mem, ` +
      `${profile.llm.tokens_per_sec.toFixed(1)} tok/s)`,
  );

  // 8. self-check (offline guarantees).
  if (profile.node_id !== nodeId) throw new Error("FAIL: profile not keyed to node id");
  if (!(profile.cpu.gflops_fp32 > 0)) throw new Error("FAIL: no CPU GFLOPS measured");
  if (!(profile.cpu.cores >= 0)) throw new Error("FAIL: cores not detected");
  console.log("\nbench-self example OK");

  // --- publish (commented; explicit, opt-in, needs a live node + api token) ----------------------
  //   import { publish } from "../src/profile.js";
  //   const pub = await publish(ce, profile); // POST /profile/publish, or CEP-1 signal fallback
  //   console.log(`published via ${pub.via}`);
}

/** Compact number formatting for the probe table. */
function fmt(n) {
  if (!Number.isFinite(n)) return String(n).padStart(10);
  return (n >= 100 ? n.toFixed(0) : n.toFixed(2)).padStart(10);
}

main().catch((err) => {
  console.error("bench-self failed:", err && err.message ? err.message : err);
  process.exit(1);
});
