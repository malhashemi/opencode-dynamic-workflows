import type { TuiPluginApi, TuiSlotContext, TuiTheme } from "@opencode-ai/plugin/tui"
import { createComponent, type Accessor } from "solid-js"
import { formatElapsed, phasePosition, settledUnits } from "../progress"
import type { RunSnapshot } from "../runs"

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
  /** Renders the `❓ n question(s) waiting` row; 0 until Phase 4 fills `RunSnapshot.interactions`. */
  pendingQuestions: number
}

export interface WorkflowSidebarProps {
  runs: Accessor<readonly RunSnapshot[]>
  theme: TuiTheme
}

/**
 * Pending owned interactions on a run. Phase 4 adds `RunSnapshot.interactions`; until then every run reports
 * zero, so the badge slot exists in the layout from day one and lights up with no shape change.
 */
function pendingInteractions(run: RunSnapshot): number {
  const value = (run as RunSnapshot & { interactions?: unknown }).interactions
  return Array.isArray(value) ? value.length : 0
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
export function sidebarViewModel(runs: readonly RunSnapshot[], now = Date.now()): SidebarView {
  const live = runs
    .filter((run) => run.status === "running")
    .sort((a, b) => a.startedAt - b.startedAt || a.runId.localeCompare(b.runId))
  const settled = runs
    .filter((run) => run.status !== "running")
    .sort((a, b) => (b.endedAt ?? b.startedAt) - (a.endedAt ?? a.startedAt) || a.runId.localeCompare(b.runId))
  return {
    rows: [...live, ...settled].map((run) => toSidebarRunRow(run, now)),
    // Only a live run can be waiting on an answer; a settled one's questions are already resolved.
    pendingQuestions: live.reduce((total, run) => total + pendingInteractions(run), 0),
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

export function registerSidebar(api: TuiPluginApi, runs: Accessor<readonly RunSnapshot[]>): string {
  return api.slots.register({
    order: 350,
    slots: {
      sidebar_content(context: TuiSlotContext) {
        return createComponent(WorkflowSidebar, { runs, theme: context.theme })
      },
    },
  })
}
