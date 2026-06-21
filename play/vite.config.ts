import { defineConfig } from "vite";

// The playground is a single static page deployed under https://ce-net.com/play.
// `base: "./"` keeps the emitted asset URLs relative so the bundle works whether
// it is served from `/play/` (production) or `/` (local `vite preview`).
export default defineConfig({
  base: "./",
  build: {
    outDir: "dist",
    target: "es2022",
    sourcemap: true,
  },
});
