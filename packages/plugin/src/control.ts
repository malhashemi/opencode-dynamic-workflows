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
import type { WorkflowClient } from "./client"
import type { PendingInteraction, RunStore } from "./runs"

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
   * Answer a pending question — agent-raised or script-raised (Phase 4).
   *
   * ONE action for both origins, because a person answering a question should never have to know which kind it
   * was. `answers` is the host's own reply shape: one entry per question in the form, each a list of chosen
   * option labels.
   */
  | { action: "question.reply"; runId: string; requestID: string; answers: string[][] }
  /** Hand a pending question back to automation — `esc leave for automation`. */
  | { action: "question.reject"; runId: string; requestID: string }
  /** Answer a pending permission ask. `always` is admitted for an API caller; no surface offers it. */
  | { action: "permission.reply"; runId: string; requestID: string; reply: "once" | "always" | "reject" }

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

/**
 * A run's own interaction handles — the local half of answering.
 *
 * Registered like a run controller or a unit cancel, because it is the same kind of thing: a handle the engine
 * owns and a surface addresses. Two operations, and `handOff` is the interesting one: for a SCRIPT question it
 * settles the author's declared fallback, and for an AGENT question it expires the grace so the watcher's
 * proxy → escalate → reject ladder takes over. Both are what `esc leave for automation` means, and neither is
 * the host's `question.reject` — rejecting outright would kill a question the ladder could still answer.
 */
export interface RunInteractions {
  /** Settle a script-origin request with the human's answer; false when it is not one of this run's. */
  answer(requestID: string, answers: string[][]): boolean
  /** Hand a request back to automation now, without waiting out its grace. */
  handOff(requestID: string): boolean
}

/**
 * Answering an AGENT-raised interaction, which lives in the host rather than here.
 *
 * Injected rather than built here for the same reason `save` is: this registry is a lookup table, and reaching
 * for the SDK from inside it would give every consumer a dependency on the host client.
 */
export interface InteractionController {
  reply(runId: string, requestID: string, answers: string[][]): Promise<ControlResult>
  reject(runId: string, requestID: string): Promise<ControlResult>
  permission(runId: string, requestID: string, reply: "once" | "always" | "reject"): Promise<ControlResult>
}

export interface ControlDeps {
  save?: RunSaver
  interactions?: InteractionController
}

export interface ControlRegistry {
  /** Register the run-scoped controller aborting this run. Returns a disposer; calling it twice is safe. */
  registerRun(runId: string, controller: AbortController): () => void
  /** Register a best-effort cancel for ONE in-flight unit. Returns a disposer, called when the unit settles. */
  registerUnit(runId: string, unitId: string, cancel: () => void): () => void
  /** Register a run's interaction handles. Returns a disposer, called when the run ends. */
  registerInteractions(runId: string, sink: RunInteractions): () => void
  stopRun(runId: string): ControlResult
  stopUnit(runId: string, unitId: string): ControlResult
  dispatch(action: ControlAction): Promise<ControlResult>
}

interface RunControl {
  controller: AbortController
  units: Map<string, () => void>
  interactions: RunInteractions | null
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
  const requestID = candidate.requestID
  const addressed = typeof requestID === "string" && requestID.length > 0
  if (candidate.action === "question.reply" && addressed) {
    const answers = candidate.answers
    if (!Array.isArray(answers)) return null
    // Narrowed here rather than trusted downstream: `answers` crosses the wire, and a `string[][]` that is
    // actually a `string[]` would reach the host's reply endpoint as a shape it silently mis-reads.
    const rows: string[][] = []
    for (const row of answers) {
      if (!Array.isArray(row) || !row.every((label) => typeof label === "string")) return null
      rows.push([...(row as string[])])
    }
    return { action: "question.reply", runId, requestID: requestID as string, answers: rows }
  }
  if (candidate.action === "question.reject" && addressed) {
    return { action: "question.reject", runId, requestID: requestID as string }
  }
  if (candidate.action === "permission.reply" && addressed) {
    const reply = candidate.reply
    if (reply !== "once" && reply !== "always" && reply !== "reject") return null
    return { action: "permission.reply", runId, requestID: requestID as string, reply }
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
      const entry: RunControl = {
        controller,
        units: existing?.units ?? new Map(),
        interactions: existing?.interactions ?? null,
      }
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

    registerInteractions(runId, sink) {
      const entry = runs.get(runId)
      if (!entry) return () => {}
      entry.interactions = sink
      let active = true
      return () => {
        if (!active) return
        active = false
        if (entry.interactions === sink) entry.interactions = null
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
      // A script-raised question is settled HERE — it never existed anywhere else — so the local sink is tried
      // first and the host controller is the fallthrough. Request ids are UUIDs on both sides, so "did the
      // local sink know it?" is a complete answer rather than a guess. This keeps ONE dispatch path for both
      // origins, which is the whole reason a surface never has to know which kind it is answering.
      if (action.action === "question.reply") {
        if (runs.get(action.runId)?.interactions?.answer(action.requestID, action.answers)) return { ok: true }
        if (!deps.interactions) return { ok: false, reason: "unknown-request" }
        return deps.interactions.reply(action.runId, action.requestID, action.answers)
      }
      if (action.action === "question.reject") {
        if (runs.get(action.runId)?.interactions?.handOff(action.requestID)) return { ok: true }
        if (!deps.interactions) return { ok: false, reason: "unknown-request" }
        return deps.interactions.reject(action.runId, action.requestID)
      }
      if (action.action === "permission.reply") {
        if (!deps.interactions) return { ok: false, reason: "unsupported" }
        return deps.interactions.permission(action.runId, action.requestID, action.reply)
      }
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

/**
 * Answer an AGENT-raised interaction — the half that has to leave this process.
 *
 * The store is consulted first, and not merely for politeness: it is what tells `unknown-request` apart from
 * "the host has it but this run does not own it", and the second case is a scope violation rather than a typo.
 * A request nobody in this run published is never forwarded to the host, so a surface cannot answer somebody
 * else's question through our endpoint.
 */
export function createInteractionController(client: WorkflowClient, store: RunStore): InteractionController {
  const find = (runId: string, requestID: string): PendingInteraction | null =>
    store.get(runId)?.interactions.find((candidate) => candidate.requestID === requestID) ?? null

  /**
   * Drop the row now rather than waiting for the watcher's next poll to notice it left the host's list.
   *
   * The `answers` go with it. This is the only moment anyone in this process knows what the person chose for an
   * AGENT question — the reply went straight to the host — so a resolution recorded without them would leave
   * the run's own record saying "answered" and nothing else.
   */
  const settle = (
    runId: string,
    requestID: string,
    settlement: { answers?: string[][]; outcome?: "answered" | "rejected" } = {},
  ) => {
    try {
      store.apply({ type: "interaction.resolved", runId, requestID, by: "human", ...settlement })
    } catch {
      // The run is gone; the answer still reached the host, which is the part that mattered.
    }
  }

  const failed = (error: unknown): ControlResult => ({
    ok: false,
    reason: "unsupported",
    detail: error instanceof Error ? error.message : String(error),
  })

  return {
    async reply(runId, requestID, answers) {
      const interaction = find(runId, requestID)
      if (!interaction || interaction.origin !== "agent") return { ok: false, reason: "unknown-request" }
      try {
        if (interaction.kind === "permission") {
          // A surface that answered a permission through the question pane sent the option label; it means the
          // same thing as the dedicated action, so accept it rather than making the pane branch.
          const label = answers[0]?.[0]
          if (label !== "once" && label !== "always" && label !== "reject") return { ok: false, reason: "unsupported" }
          await client.permission.reply({ requestID, reply: label })
        } else {
          await client.question.reply({ requestID, answers })
        }
        settle(runId, requestID, { answers, outcome: "answered" })
        return { ok: true }
      } catch (error) {
        return failed(error)
      }
    },

    async reject(runId, requestID) {
      const interaction = find(runId, requestID)
      if (!interaction || interaction.origin !== "agent") return { ok: false, reason: "unknown-request" }
      try {
        if (interaction.kind === "permission") await client.permission.reply({ requestID, reply: "reject" })
        else await client.question.reject({ requestID })
        // A refusal, recorded as one. It reached the host as `reject`, so the asking unit sees a denial — which
        // is a different thing to tell a reader than "answered, contents unknown".
        settle(runId, requestID, { outcome: "rejected" })
        return { ok: true }
      } catch (error) {
        return failed(error)
      }
    },

    async permission(runId, requestID, reply) {
      const interaction = find(runId, requestID)
      if (!interaction || interaction.origin !== "agent" || interaction.kind !== "permission") {
        return { ok: false, reason: "unknown-request" }
      }
      try {
        await client.permission.reply({ requestID, reply })
        settle(
          runId,
          requestID,
          reply === "reject" ? { outcome: "rejected" } : { answers: [[reply]], outcome: "answered" },
        )
        return { ok: true }
      } catch (error) {
        return failed(error)
      }
    },
  }
}
