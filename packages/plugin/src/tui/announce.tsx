/** @jsxImportSource @opentui/solid */
/**
 * The two moments a workflow has to pull a user out of the terminal: a question waiting, and a run finishing.
 *
 * Both go through `attention.notify`, not a bare toast, because the host's attention layer is focus-aware — it
 * raises a desktop notification and plays a sound only when the user is not already looking — and a workflow
 * that runs for an hour is precisely the thing someone walks away from. The toast rides alongside for the case
 * where they ARE looking, and carries the route back, since the host's toast has no action of its own.
 *
 * ## Why this is a slot and not a `createRoot` in the plugin entry
 *
 * The obvious implementation is a `createEffect` inside `createRoot(...)` at activation time. It type-checks,
 * it runs, and on a real host it announces nothing: an owner created outside the renderer's own reactive root
 * is never flushed by the render loop, so the effect either never runs or first runs long after the state it
 * was supposed to notice. Found live — the sidebar badge appeared and no toast ever did, twice, including with
 * a ten-second duration.
 *
 * Registering an `app`-slot component instead puts the watcher INSIDE the render tree the host is already
 * driving, which is the only place a Solid effect is guaranteed to run when a signal changes. The component
 * renders a zero-sized box: it is a watcher, not a view.
 */
import type { TuiPluginApi, TuiSlotContext } from "@opencode-ai/plugin/tui"
import { createComponent, createEffect, type Accessor } from "solid-js"
import type { RunSnapshot } from "../runs"
import { pendingInteractions, runOfInteraction } from "./route-model"

/**
 * How long a workflow toast stays up.
 *
 * Deliberately twice the host's own default. That default is tuned for "your file was saved"; this one is the
 * only announcement a user gets that a run has STOPPED and is waiting on them.
 */
const TOAST_MS = 10_000

/**
 * Announce, and never let announcing be the thing that breaks.
 *
 * Both host calls are isolated: `attention.notify` returns a promise that can reject for reasons that have
 * nothing to do with the run (a missing sound pack, a platform without notifications), and a rejection escaping
 * an effect is an unhandled rejection in the host's process. Separating them also means a failure in one does
 * not silently cost the other — the first version called them in sequence, so anything wrong with the sound
 * would have taken the toast down with it.
 */
function notify(api: TuiPluginApi, input: Parameters<TuiPluginApi["attention"]["notify"]>[0]): void {
  try {
    void Promise.resolve(api.attention.notify(input)).catch(() => {})
  } catch {
    // An announcement is never worth a crash.
  }
}

function toast(api: TuiPluginApi, message: string): void {
  try {
    api.ui.toast({ variant: "warning", title: "Workflow question", message, duration: TOAST_MS })
  } catch {
    // Same. The sidebar badge is the durable announcement; this is the one that taps you on the shoulder.
  }
}

export interface WorkflowAnnouncerProps {
  api: TuiPluginApi
  runs: Accessor<readonly RunSnapshot[]>
}

export default function WorkflowAnnouncer(props: WorkflowAnnouncerProps) {
  /** Request ids already announced, so a reconnect that republishes the same question is not a second chime. */
  let announced = new Set<string>()
  /** Runs already announced as finished, for the same reason. */
  let settled = new Set<string>()
  /**
   * Skips the first frame.
   *
   * A terminal opened while a run was already waiting should show the badge, not chime for something that
   * happened before it existed — and a run that finished before this session started is history, not news.
   */
  let primed = false

  createEffect(() => {
    const runs = props.runs()
    const pending = pendingInteractions(runs)
    const pendingIds = new Set(pending.map((interaction) => interaction.requestID))
    const settledIds = new Set(runs.filter((run) => run.status !== "running").map((run) => run.runId))

    if (!primed) {
      primed = true
      announced = pendingIds
      settled = settledIds
      return
    }

    const fresh = pending.find((interaction) => !announced.has(interaction.requestID))
    if (fresh) {
      const run = runOfInteraction(runs, fresh.requestID)
      const message = `${run?.workflow ?? "a workflow"} is waiting on an answer`
      notify(props.api, { title: "Workflow question", message, sound: { name: "question" } })
      // The command, not a keybinding: the host's toast carries no action, and a plugin claiming a global key
      // is a key taken away from the user.
      toast(props.api, `${message} — /workflow-answer`)
    }

    for (const run of runs) {
      if (run.status === "running" || settled.has(run.runId)) continue
      notify(props.api, {
        title: "Workflow finished",
        message: `${run.workflow} ${run.status}`,
        sound: { name: run.status === "done" ? "done" : "error" },
      })
    }

    announced = pendingIds
    settled = settledIds
  })

  // A watcher, not a view. Absolute so it cannot take a row from the layout it is overlaid on.
  return <box position="absolute" width={0} height={0} />
}

/**
 * Mount the announcer into the host's root overlay.
 *
 * `app` rather than `sidebar_content`, because the sidebar is only composed while a session route is open and
 * wide enough — and a question raised while the user is on the home screen, or in the run browser itself, still
 * has to reach them.
 */
export function registerAnnouncer(api: TuiPluginApi, runs: Accessor<readonly RunSnapshot[]>): string {
  return api.slots.register({
    order: 350,
    slots: {
      app(_context: TuiSlotContext) {
        return createComponent(WorkflowAnnouncer, { api, runs })
      },
    },
  })
}
