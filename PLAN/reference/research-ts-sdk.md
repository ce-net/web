I have comprehensive research coverage. Here is the report.

---

# Shipping `@ce-net/sdk`: A Modern TypeScript SDK for an HTTP+SSE API (2026)

## TL;DR — Recommended stack

| Concern | Recommendation |
|---|---|
| **Source of truth** | Hand-written, runtime-agnostic core. CE is small (one node API); a hand-written SDK gives the best DX and lets you encode CE-specific money/SSE semantics that codegen handles poorly. **Also publish an OpenAPI 3.1 spec** as a secondary artifact for other-language users. |
| **Build tool** | `tsdown` (Rolldown-based, the tsup successor) or `tsup` if you want max-stability. Output ESM + CJS + `.d.ts`/`.d.cts`. |
| **Module strategy** | Dual ESM/CJS via `exports` map, ESM-first. Target Node 20 LTS baseline. |
| **HTTP** | Global `fetch` only — no axios, no node-fetch. Inject a custom `fetch` via options for non-standard runtimes. |
| **Money** | Decimal strings on the wire → expose a tiny `Amount` value type backed by `bigint` (base units). Never `JSON.parse` amounts into `number`. |
| **SSE** | `fetch` + `ReadableStream` with a hand-rolled SSE line parser exposed as `AsyncIterable`. Not `EventSource` (no auth headers, not in Node/Workers). |
| **Validation/types** | Hand-written TS types for the happy path; **Zod v4-mini** only at trust boundaries (SSE event decoding, error envelopes) for tree-shakeable runtime validation. |
| **Errors/retries** | Typed error hierarchy; retry 429/5xx/network with exponential backoff + full jitter; respect `Retry-After`; honor idempotency keys. |
| **Auth** | Pluggable: static token, `() => string`, or `async () => string` callback injected per-request. |
| **Verify before publish** | `publint` + `@arethetypeswrong/cli` (attw) in `prepublishOnly` and CI. |

---

## 1. Dual ESM/CJS publishing

**The 2026 consensus:** new packages should be **ESM-first but still dual-published** for the duration of Node 18/20 LTS. Node 23+ can `require()` ESM, but you cannot assume all consumers (bundlers, older Node, certain edge configs) are there yet, so ship both ([Snyk](https://snyk.io/blog/building-npm-package-compatible-with-esm-and-cjs-2024/), [Liran Tal](https://lirantal.com/blog/typescript-in-2025-with-esm-and-cjs-npm-publishing)).

**Build tool:** Three viable options ([PkgPulse](https://www.pkgpulse.com/guides/tsup-vs-tsdown-vs-unbuild-typescript-library-bundling-2026)):
- `tsup` — most popular, zero-config, ESM+CJS+`.d.ts`. Safe default.
- `tsdown` — Rolldown (Rust) successor to tsup; same DX, faster. **My pick for a greenfield SDK in 2026.**
- `unbuild` — pick only if you're in the UnJS/Nuxt ecosystem.
- (`tshy`/`zshy` — `tsc`-only, bundler-free; good if you want zero bundling, but tsdown gives you more control over the single-dep output.)

**`exports` map** — the load-bearing config. Put `types` first in every condition block, give CJS types a `.d.cts` extension (attw catches this if wrong):

```jsonc
{
  "name": "@ce-net/sdk",
  "type": "module",
  "sideEffects": false,
  "exports": {
    ".": {
      "import": { "types": "./dist/index.d.ts",  "default": "./dist/index.js" },
      "require": { "types": "./dist/index.d.cts", "default": "./dist/index.cjs" }
    },
    "./package.json": "./package.json"
  },
  "main": "./dist/index.cjs",
  "module": "./dist/index.js",
  "types": "./dist/index.d.ts",
  "files": ["dist"],
  "engines": { "node": ">=20" }
}
```

**Verify before every publish** ([johnnyreilly](https://johnnyreilly.com/dual-publishing-esm-cjs-modules-with-tsup-and-are-the-types-wrong)):

```jsonc
"scripts": {
  "prepublishOnly": "tsdown && publint && attw --pack"
}
```

`publint` catches broken `exports` paths; `attw` (Are the Types Wrong) catches the classic "masquerading CJS/ESM types" trap. Run both in CI too.

---

## 2. Runtime-agnostic fetch

The runtime landscape has forked — Node, Bun, Deno, browsers, Cloudflare Workers/Vercel Edge all coexist ([debugg.ai](https://debugg.ai/resources/js-runtimes-have-forked-2025-cross-runtime-libraries-node-bun-deno-edge-workers)). The portability rule: **implement against Web Standard APIs first** (fetch, `ReadableStream`, `AbortController`, `TextDecoder`, `crypto.subtle`), drop to runtime-specific code only as a last resort.

Concrete rules for `@ce-net/sdk`:
- **Use global `fetch`.** Node 20+, Bun, Deno, browsers, and Workers all have it. Do **not** depend on `axios` or `node-fetch` — they pull in Node built-ins that break in Workers/edge.
- **Allow `fetch` injection** so users on exotic runtimes or who need mocking/proxying can override:
  ```ts
  new CeClient({ baseUrl, token, fetch: customFetch });
  ```
- **No Node built-ins** (`http`, `https`, `stream`, `crypto`, `Buffer`) in the core path. Use `crypto.randomUUID()` / `crypto.subtle` and `Uint8Array`.
- **`AbortController` / `AbortSignal`** for timeouts and cancellation (works everywhere; honors `signal` passthrough).
- Mark `"sideEffects": false` and keep the entry tree-shakeable so edge bundles stay tiny.

This single rule (Web APIs only + injectable fetch) is what lets you ship **one** package across all five targets instead of per-runtime forks.

---

## 3. Big-integer money (the most CE-specific concern)

CE's model: amounts are `u128` base units, `10^18` per credit, **and the HTTP API already carries them as decimal strings** because they exceed JSON's `2^53`. The SDK must never undo that.

The hazard: `JSON.parse` silently coerces large numbers to `Number`, losing precision above `Number.MAX_SAFE_INTEGER` (9007199254740991) ([HackerOne](https://www.hackerone.com/blog/safely-handling-large-integers-json-best-practices-and-pitfalls), [V8 BigInt](https://v8.dev/features/bigint)).

**Recommended design:**
1. **Wire = decimal strings** (already true). Keep amount fields typed as `string` in the raw response types so a naïve `JSON.parse` never touches them as numbers.
2. **Expose a small `Amount` value object** backed by `bigint` base units — integers only, no floats, sidestepping `0.1 + 0.2` entirely ([dev.to/omriluz1](https://dev.to/omriluz1/bigint-handling-large-integers-in-javascript-2h52)):
   ```ts
   class Amount {
     readonly base: bigint;                 // base units (10^18 = 1 credit)
     static fromBaseUnits(s: string): Amount
     static fromCredits(s: string): Amount  // parse human "1.5" → base units
     toBaseUnits(): string                  // for the wire
     toCredits(): string                    // human display, no float
     add(o: Amount): Amount; sub(o: Amount): Amount;
     cmp(o: Amount): -1 | 0 | 1
   }
   ```
3. **Do NOT** reach for `json-bigint` as the default parser. It's a fine tool, but since CE already sends strings, you keep `JSON.parse` fast and just construct `Amount` from the string fields yourself. Offer a `json-bigint`-style reviver only as an escape hatch if some endpoint ever returns a bare large integer.
4. Don't `JSON.stringify` a `bigint` (it throws); always serialize via `Amount.toBaseUnits()` → string.

This matches your existing money memo (integers, never floats, strings on the API) and makes the danger structurally unrepresentable.

---

## 4. SSE / streaming

CE has four SSE endpoints (`/signals/stream`, `/blocks/stream`, `/transactions/stream`). **Don't use `EventSource`:** it can't send `Authorization`/custom headers, and it isn't natively present in Node or Workers ([web-developpeur](https://www.web-developpeur.com/en/blog/sse-fetch-readable-stream-api-key)).

**Use `fetch` + `ReadableStream`** and parse SSE yourself, exposing each stream as a typed `AsyncIterable` ([Medium/Arif Dewi](https://medium.com/@arifdewi/streaming-ai-responses-sse-vs-readablestream-vs-vercel-ai-sdk-8bde9db53c03)):

```ts
for await (const block of ce.blocks.stream({ signal })) {
  // block: typed, validated
}
```

Implementation notes:
- `response.body!.pipeThrough(new TextDecoderStream())`, buffer by `\n\n`, parse `data:`/`event:`/`id:` fields.
- **You give up EventSource's freebies, so re-implement them**: auto-reconnect with backoff, and `Last-Event-ID` resumption (send the last seen `id:` as a header/query on reconnect).
- Cancellation via the passed `AbortSignal`.
- Validate each decoded event with a Zod schema (trust boundary — see §6).
- Works identically in Node 20+, Bun, Deno, browsers, and Workers because it's pure Web-stream API.

(Reference implementations to study: MCP TypeScript SDK's fetch-based SSE transport, `sse-ts` ([GitHub](https://github.com/smartmuki/sse-ts)). Vercel AI SDK is the gold-standard DX but is overkill/AI-specific.)

---

## 5. Errors, retries, auth

**Typed error hierarchy** — let users `instanceof`-narrow:
```
CeError
 ├─ CeApiError      (HTTP non-2xx; .status, .code, .requestId, .body)
 │   ├─ CeAuthError        (401/403)
 │   ├─ CeBadRequestError  (400/422)
 │   ├─ CeNotFoundError    (404)
 │   ├─ CeRateLimitError   (429; .retryAfter)
 │   ├─ CeInsufficientFundsError (402 — CE-specific, /jobs/bid)
 │   └─ CeServerError      (5xx)
 ├─ CeConnectionError (network/DNS/timeout)
 └─ CeStreamError     (SSE decode/disconnect)
```

**Retries** ([AWS Well-Architected](https://docs.aws.amazon.com/en_us/wellarchitected/2022-03-31/framework/rel_mitigate_interaction_failure_limit_retries.html), [dev.to backoff+jitter](https://dev.to/gabrielanhaia/a-100-line-retry-with-exponential-backoff-and-jitter-for-typescript-38mg)):
- Retry only on **429, 408, 5xx, and network errors**. Never retry 400/401/403/404/402 (permanent / business-logic).
- **Exponential backoff with full jitter** to avoid thundering-herd; cap attempts (default ~2–3) and total delay.
- **Honor `Retry-After`** on 429/503.
- **Idempotency keys:** auto-attach an `Idempotency-Key` (`crypto.randomUUID()`) header to mutating POSTs (`/transfer`, `/jobs/bid`, `/channels/open`, etc.) so retries are safe. Let users override.
- Surface config: `maxRetries`, `timeoutMs`, per-call `signal`.

**Auth injection** — pluggable, async-capable so tokens can be refreshed:
```ts
new CeClient({
  token: "...",                       // static, OR
  token: () => process.env.CE_TOKEN,  // sync callback, OR
  token: async () => await getCapToken(), // async (refresh)
});
```
Resolve the token per-request and inject the header (`Authorization` / CE capability token) right before fetch. Never log it. This fits CE's capability-token model where tokens rotate/expire.

---

## 6. Types & validation: zod vs hand-written vs OpenAPI codegen

Three approaches, and the right answer is a **hybrid** ([DEV/young_gao](https://dev.to/young_gao/request-validation-at-the-edge-zod-schemas-openapi-and-type-safe-apis-1kib), [Speakeasy zod v4](https://www.speakeasy.com/blog/release-zod-v4)):

- **Hand-written TS types** for request/response shapes: best DX, zero runtime cost, full control. Best for a small, stable API like CE's.
- **Zod** gives runtime validation (TS types vanish at runtime; Zod fills that gap) but adds bundle weight. **Zod v4-mini** has a standalone-function API that tree-shakes well (~10% smaller SDKs vs full Zod) ([Speakeasy](https://www.speakeasy.com/blog/release-zod-v4)).
- **Full OpenAPI codegen** (Speakeasy/Stainless) auto-generates everything but produces less idiomatic code for CE-specific concerns (the `Amount`/bigint type, the SSE iterables) and you'd fight the generator.

**Recommendation for `@ce-net/sdk`:** hand-write the types; apply **Zod v4-mini only at trust boundaries** — decoding SSE events and the error envelope — where data is least trusted and a bad payload should fail loudly. Keep the happy-path request builders validation-free for speed and size. This keeps the SDK tree-shakeable (`sideEffects:false`, named exports, no barrel side effects) while still being safe where it matters.

---

## 7. Should CE publish an OpenAPI spec for multi-language codegen?

**Yes — publish OpenAPI 3.1 as a first-class artifact, but keep the flagship TS SDK hand-written.**

Rationale:
- CE will eventually want Python/Go/Rust(ce-rs already exists)/etc. clients. Generators (Speakeasy: 10 languages incl. TS, Python, Go, Java, C#, PHP, Ruby, Kotlin, Terraform; Stainless: 7 + MCP servers/CLI/Terraform) turn one spec into idiomatic clients and stay in sync with the API ([Speakeasy comparison](https://www.speakeasy.com/blog/comparison-sdk-generators-openapi), [Fern](https://buildwithfern.com/post/best-sdk-generation-tools-multi-language-api)).
- Speakeasy is **OpenAPI-native** (spec is the single source of truth, runs as a standalone CLI, ships TS SDKs with Zod runtime validation and a single runtime dep). Stainless uses a custom config DSL and requires its cloud, but also emits MCP servers / CLIs / Terraform providers — relevant given CE's MCP/agent leanings ([Stainless compare](https://www.stainless.com/docs/compare/speakeasy/)). Both have meaningful per-language pricing.

**Pragmatic path:**
1. Author/maintain `openapi.yaml` (3.1) for the node HTTP API — also doubles as living docs and powers the existing `docs/api.md`.
2. Hand-write `@ce-net/sdk` (TS) and keep `ce-rs` hand-written for Rust — these are your two best-DX, highest-traffic clients.
3. Use **Speakeasy** (OpenAPI-native, air-gappable CLI, free tier = 1 language/250 endpoints — fits CE's small surface) to generate **Python/Go/Java/etc.** on demand. Two caveats worth a spec annotation: money fields must be typed `string` (`format: decimal`) so no generator coerces to float, and SSE endpoints (which OpenAPI models awkwardly) may need hand-written streaming shims per language regardless.

So: **OpenAPI spec yes (for breadth + docs); hand-written for the two flagship SDKs (TS + Rust) where CE's money/SSE semantics demand bespoke ergonomics.**

---

## 8. Testing & DX

**Testing:**
- **Vitest** (fast, ESM-native, TS-first) for unit tests.
- Mock at the `fetch` boundary (inject a fake `fetch`) — cleaner and more portable than network interceptors, and exercises your injection seam.
- Test the SSE parser against chunk-split streams (events split across read boundaries — the #1 SSE bug).
- Test `Amount` against values `> 2^53` to prove no precision loss.
- **Cross-runtime smoke tests** in CI: run the test suite on Node 20/22, Bun, and Deno, plus a `wrangler`/Workers build check, to guarantee the runtime-agnostic promise.
- Type tests with `tsd` or `expect-type`; `attw` + `publint` gate publishing.

**DX / README:**
- Lead with a 5-line copy-paste quickstart (install → construct client → one call).
- A runnable `examples/` dir: a job-bid flow, a `/transfer` with `Amount`, and a `for await` SSE block stream.
- Document the **money model prominently** (`Amount`, base units, "never use `number`").
- Document error types and retry/timeout/idempotency config.
- TSDoc on every public symbol (IDE hovers are the real docs).
- Note runtime support explicitly: Node 20+, Bun, Deno, browsers, Cloudflare Workers.

---

## Concrete recommended stack for `@ce-net/sdk`

```
Language       TypeScript (strict), target ES2022, "type":"module"
Build          tsdown  → ESM (.js) + CJS (.cjs) + .d.ts/.d.cts
Packaging      exports map (types-first, .d.cts for CJS), sideEffects:false,
               engines.node >=20, files:["dist"]
HTTP           global fetch only, injectable; AbortController timeouts/cancel
Money          Amount value object over bigint base units; strings on the wire
SSE            fetch + ReadableStream → typed AsyncIterable; reconnect + Last-Event-ID
Validation     hand-written types + Zod v4-mini at SSE/error trust boundaries
Errors         typed CeError hierarchy (incl. CeInsufficientFundsError for 402)
Retries        429/5xx/network only, exp backoff + full jitter, honor Retry-After,
               auto Idempotency-Key on mutating POSTs
Auth           token: string | () => string | async () => string
Runtimes       Node 20+, Bun, Deno, browsers, Cloudflare Workers (Web APIs only)
Test           Vitest + fetch mocking; cross-runtime CI (Node/Bun/Deno/Workers)
Verify         publint + attw in prepublishOnly & CI; tsd/expect-type for types
Multi-lang     maintain openapi.yaml (3.1) → Speakeasy for Python/Go/Java/etc.;
               hand-write TS + Rust (ce-rs) flagships
DX             quickstart README, runnable examples/, full TSDoc, money-model docs
```

This mirrors your existing `ce-rs` philosophy (thin client over the node HTTP API, `Amount` for base-unit money) and your no-floats money memo, while adding the SSE iterables and runtime-agnostic constraints CE's API specifically needs.

**Sources:**
- [Snyk — ESM/CJS npm package](https://snyk.io/blog/building-npm-package-compatible-with-esm-and-cjs-2024/)
- [Liran Tal — TS ESM/CJS publishing is still a mess](https://lirantal.com/blog/typescript-in-2025-with-esm-and-cjs-npm-publishing)
- [johnnyreilly — dual publishing with tsup + attw](https://johnnyreilly.com/dual-publishing-esm-cjs-modules-with-tsup-and-are-the-types-wrong)
- [PkgPulse — tsup vs tsdown vs unbuild 2026](https://www.pkgpulse.com/guides/tsup-vs-tsdown-vs-unbuild-typescript-library-bundling-2026)
- [debugg.ai — cross-runtime libraries 2025](https://debugg.ai/resources/js-runtimes-have-forked-2025-cross-runtime-libraries-node-bun-deno-edge-workers)
- [HackerOne — large integers in JSON](https://www.hackerone.com/blog/safely-handling-large-integers-json-best-practices-and-pitfalls)
- [V8 — BigInt](https://v8.dev/features/bigint)
- [dev.to/omriluz1 — BigInt large integers](https://dev.to/omriluz1/bigint-handling-large-integers-in-javascript-2h52)
- [web-developpeur — SSE with fetch + ReadableStream, auth headers](https://www.web-developpeur.com/en/blog/sse-fetch-readable-stream-api-key)
- [Medium/Arif Dewi — SSE vs ReadableStream vs Vercel AI SDK](https://medium.com/@arifdewi/streaming-ai-responses-sse-vs-readablestream-vs-vercel-ai-sdk-8bde9db53c03)
- [sse-ts](https://github.com/smartmuki/sse-ts)
- [dev.to — retry with backoff + jitter (TS)](https://dev.to/gabrielanhaia/a-100-line-retry-with-exponential-backoff-and-jitter-for-typescript-38mg)
- [AWS Well-Architected — limit retries](https://docs.aws.amazon.com/en_us/wellarchitected/2022-03-31/framework/rel_mitigate_interaction_failure_limit_retries.html)
- [DEV/young_gao — Zod + OpenAPI type-safe APIs 2026](https://dev.to/young_gao/request-validation-at-the-edge-zod-schemas-openapi-and-type-safe-apis-1kib)
- [Speakeasy — Zod v4 mini in TS SDKs](https://www.speakeasy.com/blog/release-zod-v4)
- [Speakeasy — SDK generator comparison](https://www.speakeasy.com/blog/comparison-sdk-generators-openapi)
- [Stainless vs Speakeasy compare](https://www.stainless.com/docs/compare/speakeasy/)
- [Fern — best SDK generation tools 2026](https://buildwithfern.com/post/best-sdk-generation-tools-multi-language-api)