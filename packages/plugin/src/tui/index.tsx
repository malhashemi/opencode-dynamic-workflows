/** @jsxImportSource @opentui/solid */
import type { TuiPlugin } from "@opencode-ai/plugin/tui"
import { registerAnnouncer } from "./announce"
import { createRunClient } from "./client"
import { createControlClient } from "./control"
import { registerOpenCommand, WORKFLOW_ROUTE } from "./keymap"
import { pendingInteractions, runOfInteraction, samePath } from "./route-model"
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
          // The other half of `/state` no longer carrying unit answers, and what makes a History row openable:
          // both screens read the one record they are displaying, through the same endpoint that owns the run.
          record={(runId) => client.record(runId)}
          // Whose project a run belongs to. The client scans every endpoint on the machine, so this is the only
          // party that can answer it — and the scope filter is exactly that question asked of every row.
          endpointFor={(runId) => client.endpointFor(runId)}
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
  // The strip's `⌂` line: THIS project's endpoint, found the same way the route's scope filter decides project
  // membership (`samePath`, which tolerates the /var vs /private/var alias). Loopback needs no token, so the
  // descriptor's bare URL is the whole address. An accessor, because the endpoint (and even `api.state.path`)
  // can arrive after registration — the view re-reads it on its clock.
  const dashboardUrl = () => {
    const project = api.state.path.worktree || api.state.path.directory || null
    if (!project) return null
    const descriptor = client
      .endpoints()
      .find((candidate) => samePath(candidate.worktree, project) || samePath(candidate.directory, project))
    return descriptor?.url ?? null
  }
  registerSidebar(api, client.runs, dashboardUrl)
  // Mounted in the host's root overlay rather than driven from here: an effect created outside the renderer's
  // own reactive root is never flushed by the render loop, so an announcer built at activation time announces
  // nothing. See `announce.tsx`.
  registerAnnouncer(api, client.runs)
  api.lifecycle.onDispose(() => client.stop())
}

export default { id: "opencode-dynamic-workflows", tui }
