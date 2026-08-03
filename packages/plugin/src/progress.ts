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
 * `phase 2/3` for a run whose current phase is one of its known phases, `""` otherwise.
 *
 * The store appends every observed phase to `run.phases`, so an undeclared `phase("x")` still yields a
 * position — the empty string only appears before the first phase call.
 */
export function phasePosition(run: RunSnapshot): string {
  const index = run.currentPhase ? run.phases.indexOf(run.currentPhase) : -1
  return index >= 0 ? `phase ${index + 1}/${run.phases.length}` : ""
}
