import type { Recipe } from "../recipe.js";

/** Recipe 4 — blob roundtrip: content-addressed put/get. */
export const blobRecipe: Recipe = {
  id: "blob-roundtrip",
  num: "04",
  title: "Blob roundtrip",
  teaches: "POST /blobs, GET /blobs/:hash — content addressing",
  desc: "Store bytes; get back their SHA-256 content id. Fetch by that hash from anywhere on the mesh and verify they round-trip exactly. This is CE's content-addressed data primitive.",
  chips: ["data.putBlob()", "data.getBlob()", "POST /blobs", "SHA-256 CID"],
  needs: ["any-node", "write"],
  note: "Storing a blob is a write (needs a token on a local node). On the in-browser node it runs against your own node.",
  source: `import { CeClient } from "@ce-net/sdk";
const ce = new CeClient({ baseUrl: "http://127.0.0.1:8844" });

const bytes = new TextEncoder().encode("hello from the CE playground");

const hash = await ce.data.putBlob(bytes);          // POST /blobs -> 64-hex CID
console.log("stored as", hash);

const back = await ce.data.getBlob(hash);           // GET /blobs/:hash
console.log("fetched  ", new TextDecoder().decode(back));`,
  async run(ctx) {
    const text = `hello from the CE playground @ ${new Date().toISOString()}`;
    const bytes = new TextEncoder().encode(text);
    ctx.log(`putting ${bytes.length} bytes…`);
    const hash = await ctx.ce.data.putBlob(bytes);
    ctx.ok(`stored as ${hash}`);
    ctx.log("fetching it back by CID…");
    const back = await ctx.ce.data.getBlob(hash);
    const decoded = new TextDecoder().decode(back);
    if (decoded === text) ctx.ok(`roundtrip verified: "${decoded}"`);
    else ctx.dim(`fetched (mismatch): "${decoded}"`);
  },
};
