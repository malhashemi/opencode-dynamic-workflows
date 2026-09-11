import type { TuiPluginApi, TuiSlotContext, TuiTheme } from "@opencode-ai/plugin/tui"
import { createComponent, type Accessor } from "solid-js"
import { formatElapsed, phasePosition, settledUnits } from "../progress"
import type { RunSnapshot } from "../runs"
import { openWorkflowRoute } from "./keymap"
import { handedToAutomation } from "./route-model"

// Re-exported so every sidebar consumer imports its row model and its formatters from one place, while the
// server target keeps importing them from `../progress` (no solid-js in the published server entrypoint).
export { formatElapsed, phasePosition } from "../progress"

/**
 * One run in the sidebar strip. A live run takes two lines; a settled one takes a single line, unless it
 * failed and has a reason worth carrying:
 *
 *   ⠹ deep-research            14/40 · 2m10s     line 1 — spinner + `workflow` (accent), `counts`/`elapsed` (muted)
 *     phase 2/3 · gather sources                 line 2 — `detail` (muted)
 *   ✓ summarize                  3/3 · 41s       settled: one line, glyph carries the outcome
 *   ✗ refine                     2/3 · 45s
 *     1 unit failed                              a failure keeps its second line — the glyph says it broke,
 *                                                this says what
 *
 * Two lines for a LIVE run because the host sidebar is 42 columns (~38 usable): a single line truncates a real
 * workflow name the moment it carries a phase title and counts. One line for a SETTLED run because its phase
 * position is no longer news — its outcome is — and the strip has to stay affordable as a session accumulates
 * runs.
 */
export interface SidebarRunRow {
  runId: string
  workflow: string
  /** Drives the glyph and its color; `running` is the only status that animates. */
  status: RunSnapshot["status"]
  counts: string
  elapsed: string
  /** Line 2, or `null` for a single-line row. */
  detail: string | null
}

export interface SidebarView {
  rows: SidebarRunRow[]
  /**
   * Renders the `❓ n question(s) waiting` row.
   *
   * Counts every waiting interaction, permissions included. A permission ask only appears here when the
   * workflow opted into `interaction.permissions: "human"` — the default allows it silently — so the wording
   * stays true of the case that actually occurs, and a badge that under-reported what is blocking a run would
   * be the worse error.
   */
  pendingQuestions: number
  /**
   * The request that has been waiting longest, for the badge to deep-link to. `null` when nothing is waiting.
   *
   * Oldest first because it is the one closest to being taken back by automation.
   */
  oldestPending: { runId: string; requestID: string } | null
  /**
   * This project's dashboard URL — the `⌂ http://127.0.0.1:7466` line, muted, under the heading.
   *
   * Always shown while the endpoint is live, runs or no runs: the address is stable and tokenless on loopback,
   * so it is worth knowing before anything is running — which also means the block renders from host start
   * rather than materialising with the first run. `null` (no live endpoint for this project) draws nothing.
   */
  dashboardUrl: string | null
}

export interface WorkflowSidebarProps {
  runs: Accessor<readonly RunSnapshot[]>
  theme: TuiTheme
  /** The session this strip belongs to; absent shows every run. See {@link sidebarViewModel}. */
  sessionID?: string
  /** This project's dashboard URL, from the endpoint descriptors; see {@link SidebarView.dashboardUrl}. */
  dashboardUrl?: Accessor<string | null>
  /**
   * Open the run browser on a run — or on the whole list, from the question badge.
   *
   * The strip is a summary, and a summary that cannot be followed is a dead end: every row here is a run whose
   * detail lives one level away. Optional so a view test can mount without a router.
   */
  onOpen?: (runId: string | null) => void
  /**
   * Open the answer pane directly on one waiting request.
   *
   * Separate from `onOpen` because the badge's destination is not a run, it is a question — and landing on the
   * run browser's list, one drill short of the thing the badge was pointing at, is the difference between a
   * deep link and a hint.
   */
  onAnswer?: (runId: string, requestID: string) => void
}

/** Tolerated as absent so a snapshot from an engine older than this reader reads as "nobody is waiting". */
function interactionsOf(run: RunSnapshot): readonly RunSnapshot["interactions"][number][] {
  return Array.isArray(run.interactions) ? run.interactions : []
}

/**
 * Line 2 for a run, or `null` when the row says everything on one line.
 *
 * A live run needs its phase position — that is the whole point of watching it. A `done` or `aborted` run does
 * not: the glyph and the final counts already say what happened. A `failed` run is the exception, because
 * "it broke" without "how many broke" sends the user hunting.
 */
function detailFor(run: RunSnapshot): string | null {
  if (run.status === "running") {
    const position = phasePosition(run)
    const phase = run.currentPhase ?? "starting"
    return position ? `${position} · ${phase}` : phase
  }
  if (run.status !== "failed") return null
  const failed = run.errors.length
  return failed > 0 ? `${failed} unit${failed === 1 ? "" : "s"} failed` : "failed"
}

export function toSidebarRunRow(run: RunSnapshot, now = Date.now()): SidebarRunRow {
  return {
    runId: run.runId,
    workflow: run.workflow,
    status: run.status,
    counts: `${settledUnits(run)}/${run.units.length}`,
    elapsed: formatElapsed((run.endedAt ?? now) - run.startedAt),
    detail: detailFor(run),
  }
}

/**
 * Every run this session, live ones first.
 *
 * A settled run deliberately STAYS. It used to be dropped the moment it ended, on the theory that the strip
 * should show "what's live" — but a workflow that finishes in three seconds then vanishes never tells the user
 * whether it succeeded, and one that fails vanishes exactly as quietly as one that worked. The outcome is the
 * part worth seeing, so it persists for the session; Phase 3's journal is what makes it survive *past* the
 * session, and Phase 2's run browser is where the full history lives.
 *
 * Live runs sort oldest-first (a stable reading order that does not reshuffle as they progress); settled runs
 * sort most-recently-ended first, so the one just finished sits directly under the live group rather than at
 * the bottom of a growing list.
 */
export function sidebarViewModel(
  runs: readonly RunSnapshot[],
  now = Date.now(),
  /**
   * The session this strip belongs to — the host hands it to the slot, and the strip shows only its own runs.
   *
   * The run client scans every endpoint on the machine, so without this the strip carried other projects' and
   * other sessions' runs into a five-row summary of what YOU are doing. The user asked the question that
   * settles it: *"why would I want to see a run from another session?"*
   *
   * `undefined` shows everything, which is what a test without a host means and what a slot with no session
   * would mean if one ever existed.
   */
  sessionID?: string,
  /** The project's dashboard URL, or `null` while no endpoint is live. The caller matches descriptors. */
  dashboardUrl: string | null = null,
): SidebarView {
  const mine = sessionID === undefined ? runs : runs.filter((run) => run.parentSessionID === sessionID)
  const live = mine
    .filter((run) => run.status === "running")
    .sort((a, b) => a.startedAt - b.startedAt || a.runId.localeCompare(b.runId))
  const settled = mine
    .filter((run) => run.status !== "running")
    .sort((a, b) => (b.endedAt ?? b.startedAt) - (a.endedAt ?? a.startedAt) || a.runId.localeCompare(b.runId))
  // Only a live run can be waiting on an answer; a settled one's questions are already resolved. And a request
  // whose grace has run out is still pending in the host but is no longer a PERSON's to answer — the watcher
  // has handed it to its ladder — so counting it would light a badge that says "you are blocking this run"
  // about a decision that has already been taken away.
  //
  // Counted across EVERY run, not just this session's — the one thing the scoping above deliberately does not
  // touch. A question is a run asking a person to unblock it, and the person is the same person whichever
  // session raised it. Hiding it until they happened to be in the right session would make the badge a thing
  // that sometimes tells you.
  const waiting = runs
    .filter((run) => run.status === "running")
    .flatMap((run) => interactionsOf(run).map((interaction) => ({ run, interaction })))
    .filter(({ interaction }) => !handedToAutomation(interaction, now))
    .sort((a, b) => a.interaction.raisedAt - b.interaction.raisedAt)
  const oldest = waiting[0]
  return {
    rows: [...live, ...settled].map((run) => toSidebarRunRow(run, now)),
    pendingQuestions: waiting.length,
    oldestPending: oldest ? { runId: oldest.run.runId, requestID: oldest.interaction.requestID } : null,
    dashboardUrl,
  }
}

// Imported EAGERLY, and it must stay that way.
//
// `lazy()` looks right here — defer the JSX-bearing view until the host renders the slot — and it is fatal.
// While a lazy component resolves, Solid holds its position with an empty TEXT node, and OpenTUI throws on
// any text node whose parent is not a `<text>`: `Orphan text error: "" must have a <text> as a parent`. That
// is not a sidebar glitch; it is an uncaught render error that takes the entire TUI down to a crash screen,
// the instant the sidebar first becomes visible.
//
// Eager is also correct on the merits: the host calls `ensureRuntimePluginSupport()` at module-evaluation
// time, BEFORE it dynamically imports any external TUI entrypoint, so the OpenTUI/Solid transform is already
// installed by the time this module is loaded. Built-in sidebar plugins import their views directly too.
// `packages/plugin/test/tui/sidebar-view.test.tsx` mounts this through the real slot registry to keep it so.
import WorkflowSidebar from "./sidebar-view"

export function registerSidebar(
  api: TuiPluginApi,
  runs: Accessor<readonly RunSnapshot[]>,
  /** This project's dashboard URL; optional so a row-model test can register without endpoint discovery. */
  dashboardUrl?: Accessor<string | null>,
): string {
  return api.slots.register({
    order: 350,
    slots: {
      // The second argument is the slot's own props — the host tells a `sidebar_content` slot which session it
      // is rendering for, which is exactly the fact the strip needs to show only this session's runs.
      sidebar_content(context: TuiSlotContext, props: { session_id: string }) {
        return createComponent(WorkflowSidebar, {
          runs,
          theme: context.theme,
          sessionID: props.session_id,
          ...(dashboardUrl ? { dashboardUrl } : {}),
          onOpen: (runId: string | null) => openWorkflowRoute(api, runId),
          onAnswer: (runId: string, requestID: string) => openWorkflowRoute(api, runId, requestID),
        })
      },
    },
  })
}
