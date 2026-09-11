/**
 * The one file that reaches across the workspace into the plugin's sources.
 *
 * Types are re-exported type-only, so nothing node-shaped (`journal.ts` touches `node:fs`, `control.ts` names
 * the SDK client) ever lands in the browser bundle — `verbatimModuleSyntax` guarantees the erasure. The two
 * modules re-exported FOR RUNTIME (`runs.ts`, `progress.ts`) are deliberately pure: `runs.ts` imports only a
 * type, and `progress.ts` documents that it imports nothing but the store's types. Sharing them is the point —
 * the dashboard renders `phase 2/3` and `2m10s` through the exact functions the TUI does, so the honesty rules
 * (no denominator the system does not know, no negative elapsed) are one implementation rather than two.
 */
export {
  clonePendingInteraction,
  cloneRunSnapshot,
  cloneUnitSnapshot,
  toResolvedInteraction,
} from "../../plugin/src/runs"
export type {
  InteractionQuestion,
  PendingInteraction,
  ResolvedInteraction,
  RunEvent,
  RunSnapshot,
  UnitSnapshot,
} from "../../plugin/src/runs"
export type { JournalRecord, RunSummary } from "../../plugin/src/journal"
export type { ControlAction, ControlFailure, ControlResult } from "../../plugin/src/control"
// Type-only, like the rest: `endpoint.ts` names Bun and node modules at runtime, and none of that may reach
// the bundle. `RunOrigin` is the tag the endpoint's `?scope=everywhere` merge stamps onto a peer's rows.
export type { RunOrigin } from "../../plugin/src/endpoint"
export {
  formatClock,
  formatDay,
  formatElapsed,
  formatTokens,
  phasePosition,
  phaseProgress,
  settledUnits,
} from "../../plugin/src/progress"
