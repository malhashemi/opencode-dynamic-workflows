/**
 * The context factory — assembles the {@link WorkflowContext} handed to a Workflow's `run`.
 *
 * This slice wires `agent`, `parallel`, `collect`, `errors`, `args`, `log`, `phase`. The engine keeps a
 * private {@link EngineState} the context closes over, so logs/phases/errors/unit-counts can be surfaced in
 * the tool result without widening the author-facing API. Failed Units resolve to `null` and are recorded in
 * `state.errors` (error model D9) rather than throwing and aborting the Run; `ctx.parallel` fans Units out
 * across distinct child sessions under a bounded limiter and is a barrier.
 */
import type { AgentOpts, WorkflowContext, WorkflowError } from "@opencode-ai/workflow"
import type { WorkflowClient } from "./client"
import { DEFAULT_SUBAGENT, runAgent, stringifyError } from "./runner"
import { defaultConcurrency, runBounded } from "./scheduler"

/**
 * One completed Unit's child-session record. Surfaced so the human can navigate to a Unit's transcript from
 * the native session list (v1 visibility is out-of-band — there is no inline subagent widget for a plugin
 * tool; see the orchestration spec's rendering note). `sessionID` is null only if `session.create` failed.
 */
export interface UnitRecord {
  sessionID: string | null
  label: string | null
  subagent: string
  phase: string | null
  ok: boolean
}

/** Optional live-progress sink (the adapter forwards these to `ctx.metadata`). */
export interface EngineEvents {
  onLog?: (message: string) => void
  onPhase?: (title: string) => void
  onUnitStart?: (info: { prompt: string; subagent: string; phase: string | null; label: string | null }) => void
  /** Fired once a Unit settles, carrying its child-session ref (lets the adapter emit live child links). */
  onUnit?: (unit: UnitRecord) => void
}

export interface EngineState {
  logs: string[]
  phases: string[]
  currentPhase: string | null
  errors: WorkflowError[]
  unitCount: number
  /** Every Unit that has settled, in completion order — child-session refs for out-of-band navigation. */
  units: UnitRecord[]
}

export function createEngineState(): EngineState {
  return { logs: [], phases: [], currentPhase: null, errors: [], unitCount: 0, units: [] }
}

export interface CreateContextInput<A> {
  client: WorkflowClient
  parentSessionID: string
  args: A
  state: EngineState
  events?: EngineEvents
  /** Max Units in flight at once for `ctx.parallel` (from `meta.concurrency`); defaults to the plugin cap. */
  concurrency?: number
}

export function createWorkflowContext<A>(input: CreateContextInput<A>): WorkflowContext<A> {
  const { client, parentSessionID, args, state, events } = input
  // Own the default policy here: an absent OR non-finite (NaN/Infinity, e.g. a mis-computed `meta.concurrency`)
  // value resolves to the plugin default cap. Finite values (incl. 0/negative) pass through — runBounded
  // clamps those to ≥ 1. This keeps a bad cap from silently dropping the whole fan-out (D9).
  const concurrency = Number.isFinite(input.concurrency) ? (input.concurrency as number) : defaultConcurrency()

  const agent: WorkflowContext<A>["agent"] = async (prompt, opts: AgentOpts = {}) => {
    state.unitCount += 1
    const subagent = opts.subagent ?? DEFAULT_SUBAGENT
    const phase = opts.phase ?? state.currentPhase
    const label = opts.label ?? null
    events?.onUnitStart?.({ prompt, subagent, phase, label })

    const result = await runAgent(client, parentSessionID, prompt, {
      subagent: opts.subagent,
      model: opts.model,
      schema: opts.schema,
    })

    // Record the Unit's child session (present even when the prompt failed; null only on create failure) so
    // the human can open its transcript from the session list, and the adapter can surface live child links.
    const record: UnitRecord = { sessionID: result.childSessionID ?? null, label, subagent, phase, ok: result.ok }
    state.units.push(record)
    events?.onUnit?.(record)

    if (result.ok) return result.text
    state.errors.push({ unit: label ?? subagent, prompt, subagent, error: result.error })
    return null
  }

  // A barrier over distinct child sessions, bounded by the limiter. A Unit that fails via agent() has already
  // recorded its (rich) error and resolves to null — passed straight through. A thunk that *throws* (author
  // code, a chained `.then`, an unexpected agent() error) is caught here: its slot becomes null and a
  // best-effort entry is appended to errors, so a fan-out drop is never silent (D9).
  const parallel: WorkflowContext<A>["parallel"] = async (thunks) => {
    const settled = await runBounded(thunks, { concurrency })
    return settled.map((r, index) => {
      if (r.status === "fulfilled") return r.value
      state.errors.push({
        unit: `parallel#${index}`,
        prompt: "(unavailable: the parallel thunk threw outside agent())",
        subagent: "(unknown)",
        error: stringifyError(r.reason),
      })
      return null
    })
  }

  // Generic declaration (not a const typed as CollectFn) so `T` is nameable for the narrowing type-guard:
  // `x is T` strips exactly `null` from `T | null`, leaving `T[]` — the type-narrowing `.filter(Boolean)` can't.
  function collect<T>(xs: Array<T | null>): T[] {
    return xs.filter((x): x is T => x !== null)
  }

  const log: WorkflowContext<A>["log"] = (message) => {
    state.logs.push(message)
    events?.onLog?.(message)
  }

  const phase: WorkflowContext<A>["phase"] = (title) => {
    state.currentPhase = title
    state.phases.push(title)
    events?.onPhase?.(title)
  }

  return {
    agent,
    parallel,
    collect,
    get errors() {
      return state.errors
    },
    args,
    log,
    phase,
  }
}
