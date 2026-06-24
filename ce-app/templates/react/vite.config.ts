import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// base "./" so assets resolve under /apps/<id>/ on the hub or at a domain root.
export default defineConfig({
  base: "./",
  plugins: [react()],
  build: { outDir: "dist", emptyOutDir: true },
});
