/**
 * Test-only loader for the generated ce-drive-wasm bundle.
 *
 * The production loader (src/core/wasm/load.ts) uses Vite's `import.meta.glob` + `?url`
 * asset imports, which are not available under the plain Vitest/Node runtime. Here we
 * import the generated glue module directly and initialize it synchronously from the
 * `.wasm` bytes on disk via the bundle's `initSync`, which needs no `fetch`.
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
// Static relative import so Vitest/Vite transforms the generated ESM glue. The matching
// `.wasm` binary is read off disk (initSync needs no fetch under Node).
import * as glueModule from "../src/wasm/ce_drive_wasm.js";
import type { DriveCrdtCtor } from "../src/core/wasm/types.js";

// Vitest runs with the package root as cwd, so resolve the binary from there (import.meta.url
// is rewritten to an http: scheme by the Vite transform and is unusable for fs access).
const wasmPath = resolve(process.cwd(), "src/wasm/ce_drive_wasm_bg.wasm");

interface Glue {
  initSync: (module: { module: BufferSource } | BufferSource) => unknown;
  init: () => void;
  DriveCrdt: DriveCrdtCtor;
}

let cached: { DriveCrdt: DriveCrdtCtor } | undefined;

/** Load + synchronously instantiate the wasm CRDT. Cached across tests. */
export async function loadCrdtForTest(): Promise<{ DriveCrdt: DriveCrdtCtor }> {
  if (cached) return cached;
  const glue = glueModule as unknown as Glue;
  const bytes = readFileSync(wasmPath);
  // wasm-pack `--target web` exposes initSync(module) for fetch-free instantiation.
  glue.initSync({ module: bytes });
  try {
    glue.init();
  } catch {
    // panic hook install is a debug aid, not required for correctness.
  }
  cached = { DriveCrdt: glue.DriveCrdt };
  return cached;
}
