/** @jsxImportSource @opentui/solid */
/**
 * The two moments a workflow has to pull a user out of the terminal: a question waiting, and a run finishing.
 *
 * Both go through `attention.notify`, not a bare toast, because the host's attention layer is focus-aware — it
 * raises a desktop notification and plays a sound only when the user is not already looking — and a workflow
 * that runs for an hour is precisely the thing someone walks away from.
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
 *
 * ## The toast is not the primary path, and this is why
 *
 * Read out of the host binary (`1.18.10`): `api.ui.toast` publishes into the root toast store, but the
 * component that RENDERS it is mounted in exactly two places — inside the home route body and inside the
 * session route body. There is no toast in a plugin route. So a question raised while the user is looking at
 * the run browser produces a toast that paints on nothing, which is one concrete reason three live cycles
 * captured a badge and never a toast. This module therefore raises a toast only where a toast can appear, and
 * treats the SIDEBAR BADGE as the durable announcement — it is the one that survives being ignored.
 *
 * ## And the host's own answer is not thrown away
 *
 * `attention.notify` resolves `{ ok, notification, sound, skipped }`, and every one of those matters here.
 * `attention_disabled` means the user switched the attention layer off and we do not get to override that;
 * `focus_unknown` means the host has seen no focus or blur event yet and will not raise a desktop notification
 * on a guess — the normal state of a terminal under tmux, and the second concrete reason nothing was observed.
 * The first version discarded the whole result, which made "we announced" indistinguishable from "we called a
 * function". Now the outcome is computed, reported through {@link WorkflowAnnouncerProps.onAnnounce}, and — the
 * part that matters to a user — a question whose announcement reached NOBODY is not marked as announced, so it
 * is announced again the moment the user is somewhere an announcement can land.
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
 * The host routes it through the root toast store, but only the `home` and `session` route bodies mount the
 * component that draws it. Anywhere else — including this plugin's own run browser — a toast is a no-op.
 */
const TOAST_ROUTES: readonly string[] = ["home", "session"]

export function toastRenders(routeName: string | undefined): boolean {
  return routeName !== undefined && TOAST_ROUTES.includes(routeName)
}

/** What actually happened when we tried to get someone's attention. Never inferred; always the host's answer. */
export interface AnnouncementOutcome {
  /** The host raised a desktop notification. */
  notification: boolean
  /** The host played a sound. */
  sound: boolean
  /** The host's own explanation for doing neither, verbatim, or `null` when it gave none. */
  skipped: string | null
  /** A toast was raised AND the route it was raised on is one that draws toasts. */
  toast: boolean
  /** Whether any channel at all reached the user. `false` means we announced nothing and must not pretend. */
  reached: boolean
}

/**
 * Fold the host's reply and the current route into one honest statement.
 *
 * Pure and exported because "did that announcement actually happen?" is the whole question this module exists
 * to answer, and burying it in an effect makes it exactly as unassertable as the bug it caused.
 */
export function announcementOutcome(
  result: { notification?: boolean; sound?: boolean; skipped?: string } | null,
  toasted: boolean,
): AnnouncementOutcome {
  const notification = result?.notification === true
  const sound = result?.sound === true
  return {
    notification,
    sound,
    skipped: result?.skipped ?? null,
    toast: toasted,
    reached: notification || sound || toasted,
  }
}

export interface WorkflowAnnouncerProps {
  api: TuiPluginApi
  runs: Accessor<readonly RunSnapshot[]>
  /** Where the outcome goes, so an announcement that did not happen is observable rather than assumed. */
  onAnnounce?: (outcome: AnnouncementOutcome & { requestID: string | null }) => void
}

export default function WorkflowAnnouncer(props: WorkflowAnnouncerProps) {
  /**
   * Request ids already ANNOUNCED — and only those whose announcement actually reached a channel.
   *
   * A question the user was never told about stays out of this set on purpose. The effect re-runs when run
   * state changes and when the ROUTE changes, so walking from the run browser back to a session is enough to
   * make the announcement land. That is the opposite of the old behaviour, which recorded the attempt.
   */
  let announced = new Set<string>()
  /** Announcements in flight, so a second effect pass cannot chime for a question already mid-announcement. */
  const announcing = new Set<string>()
  /**
   * Where the user was the last time we tried a question, so a retry costs something only when it could help.
   *
   * The route is the ONLY input that changes whether an announcement can land — the attention config does not
   * move mid-run and the message does not either — so retrying from the same screen would spend a host call
   * per log line to learn what we already know. A question that reached nobody is retried when the user moves.
   */
  let attemptedFrom = new Map<string, string | undefined>()
  /** Runs already announced as finished. Same set, same rule. */
  let settled = new Set<string>()
  /**
   * Skips the first frame.
   *
   * A terminal opened while a run was already waiting should show the badge, not chime for something that
   * happened before it existed — and a run that finished before this session started is history, not news.
   */
  let primed = false

  /**
   * Announce, and never let announcing be the thing that breaks.
   *
   * `notify` is awaited rather than fired and forgotten, because its RESULT is the only way to know whether the
   * user was actually told anything. A rejection is caught and treated as "nothing happened", which is the
   * truthful reading.
   */
  const notify = async (
    input: Parameters<TuiPluginApi["attention"]["notify"]>[0],
  ): Promise<{ notification?: boolean; sound?: boolean; skipped?: string } | null> => {
    // The user's own configuration, respected rather than worked around: with the attention layer switched off
    // there is no sound and no desktop notification, and calling `notify` would only return `attention_disabled`
    // to tell us so. The in-terminal toast and the sidebar badge are a different channel and still run.
    if (props.api.tuiConfig?.attention?.enabled === false) return { skipped: "attention_disabled" }
    try {
      return await props.api.attention.notify(input)
    } catch {
      // A missing sound pack, a platform without notifications: an announcement is never worth a crash, and a
      // failure here is honestly "no channel reached them".
      return null
    }
  }

  /** Raise a toast only where one can be drawn. Reports whether it was, never whether it was attempted. */
  const toast = (message: string, route: string | undefined): boolean => {
    if (!toastRenders(route)) return false
    try {
      props.api.ui.toast({ variant: "warning", title: "Workflow question", message, duration: TOAST_MS })
      return true
    } catch {
      return false
    }
  }

  createEffect(() => {
    const runs = props.runs()
    // Read INSIDE the effect: the host's route is a store, so this subscribes the announcer to navigation. That
    // is what lets a question raised inside the run browser announce itself when the user goes back to a
    // session, instead of being silently marked as announced from a screen that draws no toasts.
    const route = props.api.route.current?.name
    const pending = pendingInteractions(runs)
    const pendingIds = new Set(pending.map((interaction) => interaction.requestID))
    const settledIds = new Set(runs.filter((run) => run.status !== "running").map((run) => run.runId))

    if (!primed) {
      primed = true
      announced = pendingIds
      settled = settledIds
      return
    }

    // Anything that has gone stops being owed an announcement, or a question answered while the user was
    // elsewhere would chime the moment they came back to a screen that could show it.
    announced = new Set([...announced].filter((requestID) => pendingIds.has(requestID)))
    settled = new Set([...settled].filter((runId) => settledIds.has(runId)))
    attemptedFrom = new Map([...attemptedFrom].filter(([requestID]) => pendingIds.has(requestID)))

    const fresh = pending.find(
      (interaction) =>
        !announced.has(interaction.requestID) &&
        !announcing.has(interaction.requestID) &&
        // Either never tried, or tried from somewhere else — the one thing that changes the answer.
        (!attemptedFrom.has(interaction.requestID) || attemptedFrom.get(interaction.requestID) !== route),
    )
    if (fresh) {
      const requestID = fresh.requestID
      announcing.add(requestID)
      attemptedFrom.set(requestID, route)
      const run = runOfInteraction(runs, requestID)
      const message = `${run?.workflow ?? "a workflow"} is waiting on an answer`
      // The command, not a keybinding: the host's toast carries no action, and a plugin claiming a global key
      // is a key taken away from the user.
      const toasted = toast(`${message} — /workflow-answer`, route)
      void notify({ title: "Workflow question", message, sound: { name: "question" } }).then((result) => {
        announcing.delete(requestID)
        const outcome = announcementOutcome(result, toasted)
        // Only a real arrival counts. Nothing reached them ⇒ it stays owed, and the next route change or run
        // event tries again — the badge is holding the line in the meantime.
        if (outcome.reached) announced.add(requestID)
        props.onAnnounce?.({ ...outcome, requestID })
      })
    }

    for (const run of runs) {
      if (run.status === "running" || settled.has(run.runId)) continue
      settled.add(run.runId)
      void notify({
        title: "Workflow finished",
        message: `${run.workflow} ${run.status}`,
        sound: { name: run.status === "done" ? "done" : "error" },
      }).then((result) => {
        // A finished run is not owed a retry: unlike a waiting question it is not asking for anything, and the
        // sidebar keeps its outcome for the session. Reported so it is still visible, never re-announced.
        props.onAnnounce?.({ ...announcementOutcome(result, false), requestID: null })
      })
    }
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
