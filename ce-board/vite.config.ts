import { defineConfig } from "vite";

// ce-board: a Vite + TS single-page app that talks to a local CE node at
// http://127.0.0.1:8844 through @ce-net/sdk. The dev server proxies /ce-api to the
// node so the browser can stream SSE and POST without CORS friction during dev.
export default defineConfig({
  server: {
    port: 5176,
    proxy: {
      "/ce-api": {
        target: "http://127.0.0.1:8844",
        changeOrigin: true,
        rewrite: (p) => p.replace(/^\/ce-api/, ""),
      },
    },
  },
  test: {
    globals: true,
    environment: "node",
    include: ["test/**/*.test.ts"],
  },
});
