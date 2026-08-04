/** @jsxImportSource @opentui/solid */
import type { TuiPlugin } from "@opencode-ai/plugin/tui"
import { registerAnnouncer } from "./announce"
import { createRunClient } from "./client"
import { createControlClient } from "./control"
import { registerOpenCommand, WORKFLOW_ROUTE } from "./keymap"
import { pendingInteractions, runOfInteraction } from "./route-model"
import WorkflowRoute from "./route"
import { registerSidebar } from "./sidebar"

const tui: TuiPlugin = async (api, options) => {
  if (options?.enabled === false) return
  const client = createRunClient({
    statePath: () => api.state.path.state,
    signal: api.lifecycle.signal,
  })
  // The control client addresses writes through the SAME descriptor scan the run client reads from, so a stop
  // can never reach a different host than the snapshot the user is looking at.
  const control = createControlClient({ endpointFor: (runId) => client.endpointFor(runId) })

  // Registered through the lifecycle-scoped `api`, so deactivating the plugin unwinds the route with
  // everything else. The route component owns its own drill stack, keymap layer, and mode push: all three are
  // only meaningful while it is on screen, and tying them to its mount is what guarantees the session prompt
  // gets its keys back the instant the user leaves.
  api.route.register([
    {
      name: WORKFLOW_ROUTE,
      render: ({ params }) => (
        <WorkflowRoute
          api={api}
          runs={client.runs}
          history={client.history}
          control={control}
          params={params}
        />
      ),
    },
  ])
  // The always-available way in. The sidebar strip renders nothing until a run starts, so without a palette
  // entry the browser would be unreachable in exactly the state where a user goes looking for a past run.
  registerOpenCommand(api, () => {
    const oldest = pendingInteractions(client.runs())[0]
    if (!oldest) return null
    const run = runOfInteraction(client.runs(), oldest.requestID)
    return run ? { runId: run.runId, requestID: oldest.requestID } : null
  })
  registerSidebar(api, client.runs)
  // Mounted in the host's root overlay rather than driven from here: an effect created outside the renderer's
  // own reactive root is never flushed by the render loop, so an announcer built at activation time announces
  // nothing. See `announce.tsx`.
  registerAnnouncer(api, client.runs)
  api.lifecycle.onDispose(() => client.stop())
}

export default { id: "opencode-dynamic-workflows", tui }
