/// <reference types="vitest/config" />
import { defineConfig } from "vite";

// ce-explorer is a static SPA. In dev we proxy the CE node API so the browser
// can talk to a node that does not send permissive CORS headers; in production
// the app is configured with an explicit node base URL (see src/lib/config.ts).
export default defineConfig({
  server: {
    port: 5290,
    proxy: {
      "/ce-node": {
        target: "http://127.0.0.1:8844",
        changeOrigin: true,
        rewrite: (p) => p.replace(/^\/ce-node/, ""),
      },
    },
  },
  build: {
    target: "es2022",
    sourcemap: true,
  },
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
  },
});
