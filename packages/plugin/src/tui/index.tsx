/**
 * The TUI plugin entry (`@malhashemi/opencode-dynamic-workflows/tui`). Published precompiled (`script/build-tui.ts` →
 * `dist/tui.js`): OpenCode's runtime Solid transform skips `node_modules`, so an installed package's TSX would
 * not render (P0 spike S4).
 */
import { Plugin } from "@opencode/plugin/tui"
import { setupWorkflowsTui } from "./app"

export default Plugin.define({
  id: "opencode-dynamic-workflows.tui",
  setup: (context) => setupWorkflowsTui(context),
})
