/**
 * Pure run-progress formatting shared by every projection of a Run.
 *
 * This module deliberately imports nothing but the store's types: the sidebar (TUI target) and the native
 * metadata mirror (server target) both need the same phase position and elapsed text, and the server target
 * must never reach into `src/tui/*` — that would drag `solid-js` (a dev-only dependency, supplied to the TUI
 * target by the host's runtime-module layer) into the published server entrypoint.
 */
import type { RunSnapshot } from "./runs"

/** Units that reached a terminal state — the numerator of every "n/m units" projection. */
export function settledUnits(run: RunSnapshot): number {
  return run.units.filter((unit) => unit.status === "ok" || unit.status === "failed").length
}

/**
 * The phase-bearing subset of a run.
 *
 * Narrower than `RunSnapshot` so a journal `RunSummary` positions itself with the SAME function a live snapshot
 * does. A history row that computed its phase position differently would be a second implementation of the one
 * rule this project has already got wrong once (`phase 1/1` on the first of three undeclared phases).
 */
export type PhaseSource = Pick<RunSnapshot, "phases" | "phasesDeclared" | "currentPhase">

/** `2m10s` / `1h02m` / `9s` — stable at every width, never scientific, never negative. */
export function formatElapsed(milliseconds: number): string {
  const seconds = Math.max(0, Math.floor(milliseconds / 1_000))
  const hours = Math.floor(seconds / 3_600)
  const minutes = Math.floor((seconds % 3_600) / 60)
  const rest = seconds % 60
  if (hours > 0) return `${hours}h${String(minutes).padStart(2, "0")}m`
  if (minutes > 0) return `${minutes}m${String(rest).padStart(2, "0")}s`
  return `${rest}s`
}

/** `41.2k` for a token count worth abbreviating, the exact number otherwise. */
export function formatTokens(tokens: number): string {
  if (!Number.isFinite(tokens) || tokens <= 0) return "0"
  if (tokens < 1_000) return String(Math.round(tokens))
  return `${(tokens / 1_000).toFixed(tokens < 10_000 ? 1 : 0)}k`
}

/**
 * `phase 2/3` when the workflow declared its phases, `phase 2` when it did not, `""` before the first one.
 *
 * The denominator is only printed when it is actually known. The store appends every observed phase to
 * `run.phases`, so a workflow that declares nothing and calls `phase()` three times would otherwise read
 * `phase 1/1` → `phase 2/2` → `phase 3/3` — each of which claims the run is on its last phase. Dropping the
 * denominator is the honest rendering: the position is real, the total is not yet knowable.
 *
 * Declaring `meta.phases` is what buys the denominator, and with it the queued phase rows the run browser
 * shows ahead of the current one.
 */
export function phasePosition(run: PhaseSource): string {
  const index = run.currentPhase ? run.phases.indexOf(run.currentPhase) : -1
  if (index < 0) return ""
  return run.phasesDeclared ? `phase ${index + 1}/${run.phases.length}` : `phase ${index + 1}`
}

/** Phase progress as a fraction, or `null` when the total is not knowable. */
export function phaseProgress(run: PhaseSource): { index: number; total: number } | null {
  if (!run.phasesDeclared || run.phases.length === 0) return null
  const index = run.currentPhase ? run.phases.indexOf(run.currentPhase) : -1
  return index >= 0 ? { index: index + 1, total: run.phases.length } : null
}

/** `▰▰▱▱` — a block meter, sized in cells, for a 0..1 ratio. */
export function meter(ratio: number, width: number): string {
  const clamped = Math.max(0, Math.min(1, Number.isFinite(ratio) ? ratio : 0))
  const filled = Math.round(clamped * width)
  return "▰".repeat(filled) + "▱".repeat(Math.max(0, width - filled))
}

/** `14:03` — wall-clock start, so a list of runs reads as a timeline rather than a pile of durations. */
export function formatClock(timestamp: number): string {
  const date = new Date(timestamp)
  return `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`
}
