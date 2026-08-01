/** @jsxImportSource @opentui/solid */
import type { TuiPlugin } from "@opencode-ai/plugin/tui"
import { createRunClient } from "./client"
import { registerSidebar } from "./sidebar"

const tui: TuiPlugin = async (api, options) => {
  if (options?.enabled === false) return
  const client = createRunClient({
    statePath: () => api.state.path.state,
    signal: api.lifecycle.signal,
  })
  registerSidebar(api, client.runs)
  api.lifecycle.onDispose(() => client.stop())
}

export default { id: "opencode-dynamic-workflows", tui }
