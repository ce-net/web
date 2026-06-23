import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// base "./" so the build runs under /apps/<id>/ on the CE hub.
export default defineConfig({
  base: "./",
  plugins: [react()],
  build: { outDir: "dist", emptyOutDir: true },
});
