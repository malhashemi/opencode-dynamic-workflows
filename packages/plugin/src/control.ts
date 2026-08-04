/**
 * The write direction of the live slice.
 *
 * Phase 1 published run state and nothing could change it: the tool's own abort signal WAS the run signal, so
 * the only thing able to stop a run was the session that started it. A run browser that can only watch is a
 * log viewer, and — more to the point — a read-only endpoint cannot prove that the transport works in both
 * directions. So the browser and the control path land together.
 *
 * This module is the engine-side half. It owns nothing and decides nothing: the orchestrator registers a
 * cancellation handle per run and per in-flight unit, the endpoint turns an HTTP request into a
 * {@link ControlAction}, and this registry is the lookup between them. Later phases add members to
 * {@link ControlAction} — never a second dispatch mechanism.
 */

export type ControlAction =
  | { action: "stop.run"; runId: string }
  | { action: "stop.unit"; runId: string; unitId: string }
  /**
   * Promote a journaled run's source to a durable workflow file (Phase 3).
   *
   * A control action rather than a filesystem write from the view, because the run browser merges runs from
   * every endpoint it can see: the engine that journaled a run is the only party that knows which project's
   * `.opencode/workflows/` it belongs in, and the TUI knows only its own.
   */
  | { action: "save.run"; runId: string }

/**
 * Why a control action did nothing.
 *
 * The vocabulary is wider than any one phase can produce (`unknown-request` arrives with Phase 4's
 * interactions) because every surface that renders a failure reason should be written against the final set
 * once. `ok: false` without a reason is never returned.
 */
export type ControlFailure =
  | "unknown-run"
  | "unknown-unit"
  | "unknown-request"
  | "not-running"
  | "conflict"
  | "unsupported"

export interface ControlResult {
  ok: boolean
  reason?: ControlFailure
  /**
   * Human-readable specifics, when the reason alone is not the whole answer — the path a save landed at, the
   * file that was already there. For display only; nothing parses it.
   */
  detail?: string
}

/** Promote a journaled run to a durable workflow file. Supplied by the engine; absent surfaces answer `unsupported`. */
export type RunSaver = (runId: string) => Promise<ControlResult>

export interface ControlDeps {
  save?: RunSaver
}

export interface ControlRegistry {
  /** Register the run-scoped controller aborting this run. Returns a disposer; calling it twice is safe. */
  registerRun(runId: string, controller: AbortController): () => void
  /** Register a best-effort cancel for ONE in-flight unit. Returns a disposer, called when the unit settles. */
  registerUnit(runId: string, unitId: string, cancel: () => void): () => void
  stopRun(runId: string): ControlResult
  stopUnit(runId: string, unitId: string): ControlResult
  dispatch(action: ControlAction): Promise<ControlResult>
}

interface RunControl {
  controller: AbortController
  units: Map<string, () => void>
}

/**
 * Narrow an untrusted body (an HTTP payload, a dashboard message) to a {@link ControlAction}.
 *
 * Lives here rather than in the endpoint so that the parser and the dispatcher can never drift: adding a
 * member to `ControlAction` without teaching this function about it makes the action unreachable, which is a
 * visible failure rather than a silently-ignored request.
 */
export function parseControlAction(value: unknown): ControlAction | null {
  if (typeof value !== "object" || value === null) return null
  const candidate = value as Record<string, unknown>
  const runId = candidate.runId
  if (typeof runId !== "string" || runId.length === 0) return null
  if (candidate.action === "stop.run") return { action: "stop.run", runId }
  if (candidate.action === "save.run") return { action: "save.run", runId }
  if (candidate.action === "stop.unit") {
    const unitId = candidate.unitId
    if (typeof unitId !== "string" || unitId.length === 0) return null
    return { action: "stop.unit", runId, unitId }
  }
  return null
}

export function createControlRegistry(deps: ControlDeps = {}): ControlRegistry {
  const runs = new Map<string, RunControl>()

  const registry: ControlRegistry = {
    registerRun(runId, controller) {
      const existing = runs.get(runId)
      // Keep any units already registered under this id: a resumed run (Phase 6) re-registers its controller
      // while its in-flight units are untouched.
      const entry: RunControl = { controller, units: existing?.units ?? new Map() }
      runs.set(runId, entry)
      let active = true
      return () => {
        if (!active) return
        active = false
        if (runs.get(runId) === entry) runs.delete(runId)
      }
    },

    registerUnit(runId, unitId, cancel) {
      const entry = runs.get(runId)
      // A unit whose run is not registered has no reachable surface; silently dropping the handle is correct
      // (the run cannot be addressed either), and the disposer stays a no-op so callers need no branch.
      if (!entry) return () => {}
      entry.units.set(unitId, cancel)
      let active = true
      return () => {
        if (!active) return
        active = false
        if (entry.units.get(unitId) === cancel) entry.units.delete(unitId)
      }
    },

    stopRun(runId) {
      const entry = runs.get(runId)
      if (!entry) return { ok: false, reason: "unknown-run" }
      if (entry.controller.signal.aborted) return { ok: false, reason: "not-running" }
      entry.controller.abort()
      return { ok: true }
    },

    stopUnit(runId, unitId) {
      const entry = runs.get(runId)
      if (!entry) return { ok: false, reason: "unknown-run" }
      const cancel = entry.units.get(unitId)
      // A settled unit has already unregistered, so "not currently cancellable" and "never existed" are the
      // same observation from here — `unknown-unit` covers both, and the caller has the run snapshot to tell
      // them apart.
      if (!cancel) return { ok: false, reason: "unknown-unit" }
      try {
        cancel()
      } catch {
        // A cancel handle is best effort; a throwing one must not make the surface believe the run is broken.
      }
      return { ok: true }
    },

    async dispatch(action) {
      if (action.action === "stop.run") return registry.stopRun(action.runId)
      if (action.action === "stop.unit") return registry.stopUnit(action.runId, action.unitId)
      if (action.action === "save.run") {
        // Unlike a stop, a save addresses the JOURNAL rather than a live run — a run that ended three sessions
        // ago is exactly the one worth keeping — so it never consults the registry's own run table.
        if (!deps.save) return { ok: false, reason: "unsupported" }
        try {
          return await deps.save(action.runId)
        } catch (error) {
          return { ok: false, reason: "unsupported", detail: error instanceof Error ? error.message : String(error) }
        }
      }
      return { ok: false, reason: "unsupported" }
    },
  }

  return registry
}
