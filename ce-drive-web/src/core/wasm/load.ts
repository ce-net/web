/**
 * Loader for the generated `ce-drive-wasm` bundle (`wasm-pack build --target web`).
 *
 * The build emits `src/wasm/ce_drive_wasm.js` (the JS glue, default export `init` plus the
 * `DriveCrdt` class) and `src/wasm/ce_drive_wasm_bg.wasm` (the binary). We import the glue
 * dynamically and hand it the `.wasm` URL via Vite's `?url` asset import, then call the
 * module's `init()` panic-hook installer. Everything is lazy and cached so the wasm is only
 * fetched/instantiated once, and only when {@link WasmDriveCore} is actually selected.
 *
 * The dynamic import is deliberately string-built so `tsc --noEmit` does not require the
 * generated file to exist on disk: when `pkg/` is absent (fresh checkout before the wasm
 * build), typecheck still passes and the loader throws a clear, actionable error at runtime.
 */

import type { DriveWasmModule } from "./types.js";

/** Thrown when the generated wasm bundle is missing — tells the operator how to produce it. */
export class WasmNotBuiltError extends Error {
  constructor(cause?: unknown) {
    super(
      "ce-drive-wasm is not built. Run `npm run build:wasm` in ce-drive-web " +
        "(wasm-pack build --target web ../ce-drive/crates/ce-drive-wasm) to generate " +
        "src/wasm/ce_drive_wasm.js. Falling back to the mock core.",
    );
    this.name = "WasmNotBuiltError";
    if (cause !== undefined) (this as { cause?: unknown }).cause = cause;
  }
}

interface GeneratedGlue {
  /** wasm-pack `--target web` default export: `init(input?) => Promise<...>`. */
  default: (input?: { module_or_path?: unknown } | URL | string) => Promise<unknown>;
  /** Our explicit panic-hook installer (`pub fn init()` in lib.rs). */
  init: () => void;
  DriveCrdt: DriveWasmModule["DriveCrdt"];
}

let cached: Promise<DriveWasmModule> | undefined;

/**
 * Load + instantiate the wasm module once. Resolves with the `DriveCrdt` constructor.
 * Rejects with {@link WasmNotBuiltError} when the generated bundle is absent.
 */
export function loadDriveWasm(): Promise<DriveWasmModule> {
  if (cached === undefined) cached = instantiate();
  return cached;
}

// Vite `import.meta.glob` discovers the generated bundle *if present*, bundles it into the
// production build, and tolerates ZERO matches at build time (so `npm run build` is green on a
// fresh checkout before `npm run build:wasm`). The glue module is imported as a lazy factory;
// the `.wasm` is imported as a hashed asset URL (`{ query: "?url" }`).
const glueGlob = import.meta.glob<GeneratedGlue>("../../wasm/ce_drive_wasm.js");
const wasmUrlGlob = import.meta.glob<string>("../../wasm/ce_drive_wasm_bg.wasm", {
  query: "?url",
  import: "default",
});

const GLUE_KEY = "../../wasm/ce_drive_wasm.js";
const WASM_KEY = "../../wasm/ce_drive_wasm_bg.wasm";

async function instantiate(): Promise<DriveWasmModule> {
  const glueLoader = glueGlob[GLUE_KEY];
  const wasmLoader = wasmUrlGlob[WASM_KEY];
  if (!glueLoader || !wasmLoader) {
    throw new WasmNotBuiltError();
  }
  let glue: GeneratedGlue;
  let wasmUrl: string;
  try {
    glue = await glueLoader();
    wasmUrl = await wasmLoader();
  } catch (err) {
    throw new WasmNotBuiltError(err);
  }

  // `--target web` requires explicit init with the wasm binary URL (no top-level await fetch).
  await glue.default({ module_or_path: wasmUrl });
  // Install the Rust panic -> console.error hook.
  try {
    glue.init();
  } catch {
    // Non-fatal: the panic hook is a debug aid, not a correctness dependency.
  }
  return { DriveCrdt: glue.DriveCrdt };
}
