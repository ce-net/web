import { defineConfig } from "vite";
import { svelte } from "@sveltejs/vite-plugin-svelte";

// base "./" so the build serves under /apps/<id>/ on the CE hub or on a
// custom subdomain. emptyOutDir keeps dist/ clean between builds.
export default defineConfig({
  base: "./",
  plugins: [svelte()],
  build: { outDir: "dist", emptyOutDir: true },
});
