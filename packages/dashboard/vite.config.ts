import { defineConfig } from "vite"
import solid from "vite-plugin-solid"

// The app imports types and pure helpers straight out of `packages/plugin/src` (one source for the formatting
// and honesty rules), so the dev server must be allowed to read across the workspace root. The build needs no
// such permission — Rollup follows the imports regardless.
export default defineConfig({
  plugins: [solid()],
  server: { fs: { allow: ["../.."] } },
  build: { outDir: "dist", emptyOutDir: true, target: "es2022" },
})
