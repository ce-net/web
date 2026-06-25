import { defineConfig } from "vitest/config";

// Vitest config kept separate from vite.config.ts so the dev/build server config
// (proxy, port) does not bleed into the test runner. jsdom gives the store tests a
// DOM-ish global; the wasm convergence test loads the generated bundle via initSync.
export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    environment: "jsdom",
  },
});
