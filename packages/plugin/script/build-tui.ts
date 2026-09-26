import path from "node:path"

/**
 * Precompile the TUI plugin (`src/tui/index.tsx` → `dist/tui.js`).
 *
 * OpenCode's runtime Solid transform skips files under `node_modules`, so an installed package's TSX would load
 * as React JSX or render nothing. The build applies OpenTUI's Solid transform ahead of time and
 * leaves the host-provided runtime modules external: the TUI maps `solid-js`, `@opentui/*` and `@opencode/*` to
 * its own copies, and a second copy of Solid would break reactivity.
 *
 *     bun run script/build-tui.ts
 */
import { createSolidTransformPlugin } from "@opentui/solid/bun-plugin"

const root = path.resolve(import.meta.dir, "..")

const result = await Bun.build({
  entrypoints: [path.join(root, "src/tui/index.tsx")],
  outdir: path.join(root, "dist"),
  naming: "tui.js",
  target: "bun",
  format: "esm",
  plugins: [
    createSolidTransformPlugin(),
    {
      // The TUI uses only `generateSyntax` from `@opencode/theme/tui`, whose index also pulls in the whole theme
      // schema (~500 KiB). Its own module is small and imports only `@opentui/core` (external, the host's copy).
      name: "theme-syntax-only",
      setup(builder) {
        builder.onResolve({ filter: /^@opencode\/theme\/tui$/ }, () => ({
          path: path.join(path.dirname(Bun.resolveSync("@opencode/theme/tui", root)), "syntax.js"),
        }))
      },
    },
  ],
  // No minify: any minified output (even whitespace-only) crashes the panel with "No renderer found" on 2.0.16.
  external: [
    // A dependency of this package: resolved from its own node_modules at run time instead of bundled.
    "zod",
    "zod/*",
    "@opentui/core",
    "@opentui/core/*",
    "@opentui/solid",
    "@opentui/solid/*",
    "solid-js",
    "solid-js/*",
    "@opencode/plugin",
    "@opencode/plugin/*",
  ],
})

if (!result.success) {
  for (const log of result.logs) console.error(log)
  process.exit(1)
}
for (const output of result.outputs)
  console.log(`built ${path.relative(root, output.path)} (${(output.size / 1024).toFixed(1)} KiB)`)
