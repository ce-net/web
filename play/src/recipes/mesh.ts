import type { Recipe } from "../recipe.js";

/** Recipe 6 — mesh request/reply: request/response between two nodes. */
export const meshRecipe: Recipe = {
  id: "mesh-rpc",
  num: "06",
  title: "Mesh request / reply",
  teaches: "POST /mesh/request, /mesh/reply — device-to-device RPC",
  desc: "The canonical request/response over the mesh: one node subscribes and answers on a topic; another sends a request and awaits the signed reply. This AppRequest channel is how every CE app (rdev, swarm, ce-coord) does device-to-device work — no new node endpoints.",
  chips: ["mesh.subscribe()", "mesh.request()", "mesh.reply()", "POST /mesh/request"],
  needs: ["two-nodes"],
  note: "Request/reply needs a second peer. The playground pairs the connected node with the hosted demo responder on topic ce/playground/echo; if no peer answers, the request times out (expected) and the call shape is still demonstrated.",
  source: `import { CeClient } from "@ce-net/sdk";
const ce = new CeClient({ baseUrl: "http://127.0.0.1:8844" });

// --- responder side (the loop every CE app reuses) ---
await ce.mesh.subscribe("ping");
for await (const m of ce.mesh.streamMessages()) {
  if (m.topic === "ping" && m.replyToken != null) {
    await ce.mesh.reply(m.replyToken, new TextEncoder().encode("pong"));
  }
}

// --- requester side, on the other node ---
const reply = await ce.mesh.request(
  serverNodeId, "ping", new Uint8Array(), 5_000,
);
console.log(new TextDecoder().decode(reply)); // "pong"`,
  async run(ctx) {
    const topic = "ce/playground/echo";
    ctx.log(`subscribing to "${topic}" so replies can be received…`);
    await ctx.ce.mesh.subscribe(topic);
    const me = await ctx.ce.getStatus();
    ctx.log(`sending a request to a peer on "${topic}" (5s timeout)…`);
    const payload = new TextEncoder().encode("ping from playground");
    try {
      const reply = await ctx.ce.mesh.request(me.nodeId, topic, payload, 5_000);
      ctx.ok(`reply: "${new TextDecoder().decode(reply)}"`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      ctx.dim(`no peer answered within 5s (expected without a demo responder): ${msg}`);
      ctx.log("call shape demonstrated — pair with a second node to see the round-trip.");
    }
  },
};
