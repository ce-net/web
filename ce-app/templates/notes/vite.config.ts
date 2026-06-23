import { defineConfig } from "vite";

// Relative base so the built app works under /apps/<id>/ on the CE hub.
export default defineConfig({
  base: "./",
  build: { outDir: "dist", emptyOutDir: true, target: "es2020" },
});
