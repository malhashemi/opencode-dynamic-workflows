/**
 * The context factory — assembles the {@link WorkflowContext} handed to a Workflow's `run`.
 *
 * This slice wires `agent`, `parallel`, `pipeline`, `collect`, `errors`, `args`, `log`, `phase`. The engine
 * keeps a private {@link EngineState} the context closes over, so logs/phases/errors/unit-counts can be
 * surfaced in the tool result without widening the author-facing API. Failed Units resolve to `null` and are
 * recorded in `state.errors` (error model D9) rather than throwing and aborting the Run. One shared
 * {@link Semaphore} caps in-flight Units across the whole Run: `agent()` runs under it, so `parallel` (a
 * barrier) and `pipeline` (no barrier between items) both draw from the same limiter (D5).
 */
import type { AgentOpts, AskOptions, AskQuestion, WorkflowContext, WorkflowError, z } from "@opencode-ai/workflow"
import type { WorkflowClient } from "./client"
import { DEFAULT_SUBAGENT, runAgent, stringifyError } from "./runner"
import { toUnitOutput, type PendingInteraction, type RunStore, type UnitSnapshot } from "./runs"
import { AbortError, defaultConcurrency, Semaphore } from "./scheduler"

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
  onUnitQueued?: (unit: UnitSnapshot) => void
  onUnitStart?: (unit: UnitSnapshot) => void
  onUnitSettled?: (unit: UnitSnapshot) => void
  /**
   * A best-effort cancel for one in-flight Unit, emitted once its child session exists.
   *
   * Routed as an EVENT so the context never learns what a `runId` is: the orchestrator owns run identity and
   * the control registry, and this keeps the engine's execution core independent of the control layer. Fires
   * again per structured-output retry attempt (each attempt is a fresh child); the last handle wins.
   *
   * `childSessionID` rides along because this is the FIRST moment a unit's session exists — a settled unit's
   * snapshot carries it, but an interaction raised inside a running unit needs the mapping while it is running,
   * which is the only time anyone can answer it.
   */
  onUnitCancelable?: (unitId: string, cancel: () => void, childSessionID: string) => void
}

export interface EngineState {
  logs: string[]
  phases: string[]
  currentPhase: string | null
  errors: WorkflowError[]
  unitCount: number
  /** Every Unit that has settled, in completion order — child-session refs for out-of-band navigation. */
  units: UnitRecord[]
  /** Running sum of completed Units' output tokens, surfaced via the advisory `ctx.budget.spent()`. */
  tokensSpent: number
}

export function createEngineState(): EngineState {
  return { logs: [], phases: [], currentPhase: null, errors: [], unitCount: 0, units: [], tokensSpent: 0 }
}

export function runOwnedRoots(state: EngineState, parentSessionID: string): ReadonlySet<string> {
  const roots = new Set<string>([parentSessionID])
  for (const unit of state.units) {
    if (unit.sessionID) roots.add(unit.sessionID)
  }
  return roots
}

/**
 * The script half of the interaction system: `ctx.ask` published as run state and settled from a surface.
 *
 * The host has no create-question endpoint — its questions originate from a model's tool call and carry a
 * `tool: { messageID, callID }` back-reference a script has nothing to hang one off — so a script's question
 * cannot borrow that primitive. It is published into THIS store instead, with `origin: "script"`, and every
 * surface downstream treats it identically to an agent's because the shapes are identical.
 */
export interface AskRegistry {
  /** Publish the interaction and resolve when answered, the grace expires, or the run aborts. */
  ask(runId: string, form: AskQuestion[], options: AskOptions): Promise<string[][]>
  /** Answer a `script`-origin request; false when the requestID is unknown, settled, or the answer is invalid. */
  resolve(requestID: string, answers: string[][]): boolean
  /**
   * Hand a `script`-origin request back to its declared fallback — what `esc leave for automation` means here.
   *
   * Not in the original sketch: `esc` has to mean the same thing on a script question as on an agent one, and
   * for a script the automation IS the fallback the author declared.
   */
  reject(requestID: string): boolean
}

/**
 * Coerce an answer to the offered labels, or reject it.
 *
 * Matching is case-insensitive and canonicalizing, exactly as the watcher's own proxy coercion is, so a surface
 * that sends back what it displayed always lands — and a script can trust that what it receives is drawn from
 * the closed set it offered rather than from whatever a client felt like posting.
 */
export function coerceAskAnswer(form: readonly AskQuestion[], answers: readonly string[][]): string[][] | null {
  if (answers.length !== form.length) return null
  const coerced: string[][] = []
  for (const [index, question] of form.entries()) {
    const requested = answers[index] ?? []
    if (requested.length === 0) return null
    if (question.multiple !== true && requested.length !== 1) return null
    const labels: string[] = []
    for (const candidate of requested) {
      const option = question.options.find((entry) => entry.label.toLowerCase() === candidate.toLowerCase())
      if (option) {
        labels.push(option.label)
        continue
      }
      // A free-text answer is only an answer when the author said it could be one.
      if (question.custom === true && candidate.trim().length > 0) {
        labels.push(candidate)
        continue
      }
      return null
    }
    coerced.push(labels)
  }
  return coerced
}

interface PendingAsk {
  form: AskQuestion[]
  fallback: string[][]
  settle: (answers: string[][]) => void
  timer: ReturnType<typeof setTimeout> | null
}

export function createAskRegistry(input: {
  store: RunStore
  attached: () => boolean
  signal: AbortSignal
  /** The run's own grace, or `null` for no deadline at all — see `resolveAskGrace`. */
  defaultGraceMs: number | null
}): AskRegistry {
  const waiting = new Map<string, PendingAsk & { runId: string }>()

  const finish = (requestID: string, answers: string[][], by: "human" | "automation"): boolean => {
    const entry = waiting.get(requestID)
    if (!entry) return false
    waiting.delete(requestID)
    if (entry.timer) clearTimeout(entry.timer)
    try {
      // The answers ride along: a script ask is settled HERE, so this is the only moment anyone knows what the
      // person chose, and the run's own record of it would otherwise be a resolution with a blank answer.
      input.store.apply({ type: "interaction.resolved", runId: entry.runId, requestID, by, answers })
    } catch {
      // The run may already be gone from the store (a terminal run drops nothing, but a store can be swapped in
      // a test). The waiting script still has to be released, which is what happens next.
    }
    entry.settle(answers)
    return true
  }

  // A run that stops does not get to leave its author's `await` hanging: every outstanding ask falls back.
  const onAbort = () => {
    for (const [requestID, entry] of [...waiting]) finish(requestID, entry.fallback, "automation")
  }
  input.signal.addEventListener("abort", onAbort, { once: true })

  return {
    ask(runId, form, options) {
      const fallback = coerceAskAnswer(form, options.fallback)
      // The fallback is the one answer the engine may have to give on the author's behalf, so it is validated
      // eagerly — a fallback that does not match the offered labels is an authoring bug, and discovering it
      // only in the headless path means discovering it in production.
      if (!fallback) {
        return Promise.reject(
          new Error(
            "ctx.ask: `fallback` must have one entry per question, each drawn from that question's offered labels",
          ),
        )
      }
      if (input.signal.aborted || !input.attached()) return Promise.resolve(fallback)

      const run = input.store.get(runId)
      if (!run) return Promise.resolve(fallback)

      const requestID = crypto.randomUUID()
      // `null` all the way down means "no deadline": the ask waits until a person answers it or the run stops.
      // A per-ask `graceMs` overrides the run's, and a run with none has none.
      const declared = options.graceMs ?? input.defaultGraceMs
      const graceMs =
        declared === null || declared === undefined || !Number.isFinite(declared) ? null : Math.max(0, declared)
      const now = Date.now()
      const interaction: PendingInteraction = {
        requestID,
        kind: "question",
        origin: "script",
        sessionID: run.parentSessionID,
        // A script asks from the run root, not from inside a unit — which is exactly the case `unitId: null`
        // and `depth: 1` were defined for.
        unitId: null,
        depth: 1,
        phase: run.currentPhase,
        questions: form.map((question) => ({
          header: question.header,
          prompt: question.prompt,
          options: question.options.map((option) => ({ ...option })),
          multiple: question.multiple === true,
          custom: question.custom === true,
        })),
        raisedAt: now,
        graceEndsAt: graceMs === null ? null : now + graceMs,
      }

      return new Promise<string[][]>((settle) => {
        const entry = { runId, form, fallback, settle, timer: null as ReturnType<typeof setTimeout> | null }
        waiting.set(requestID, entry)
        // The grace timer is the ONLY deadline on this path, and its expiry falls back rather than failing:
        // a question nobody answered is not an error, it is the default the author already wrote down. With no
        // grace declared there is no timer at all — the question waits for the person it was asked of, and the
        // run's abort is what releases it if nobody ever comes.
        if (graceMs !== null) entry.timer = setTimeout(() => finish(requestID, fallback, "automation"), graceMs)
        try {
          input.store.apply({ type: "interaction.pending", runId, interaction })
        } catch {
          waiting.delete(requestID)
          if (entry.timer) clearTimeout(entry.timer)
          settle(fallback)
        }
      })
    },

    resolve(requestID, answers) {
      const entry = waiting.get(requestID)
      if (!entry) return false
      const coerced = coerceAskAnswer(entry.form, answers)
      // An answer outside the offered set is refused rather than passed through, so the script's own closed set
      // holds no matter what a surface posts. The interaction stays pending; the surface can try again.
      if (!coerced) return false
      return finish(requestID, coerced, "human")
    },

    reject(requestID) {
      const entry = waiting.get(requestID)
      if (!entry) return false
      return finish(requestID, entry.fallback, "automation")
    },
  }
}

export interface CreateContextInput<A> {
  client: WorkflowClient
  parentSessionID: string
  args: A
  state: EngineState
  events?: EngineEvents
  /** Max Units in flight at once for `ctx.parallel` (from `meta.concurrency`); defaults to the plugin cap. */
  concurrency?: number
  /** Advisory output-token ceiling for `ctx.budget.total` (from `meta.budget`); null/undefined ⇒ no ceiling. */
  budget?: number | null
  /** The Run's abort signal (the adapter forwards opencode's tool-abort signal); defaults to never-aborted. */
  signal?: AbortSignal
  /** Default per-Unit prompt timeout (ms) — a Unit's `agent({ timeoutMs })` overrides it; absent ⇒ no default. */
  unitTimeout?: number
  /**
   * Where `ctx.ask` publishes. Absent ⇒ it resolves to its declared fallback immediately, which is the headless
   * contract — a Workflow that asks still runs, it just does not wait.
   */
  ask?: AskRegistry
  /**
   * The run this context belongs to, so `ctx.ask` can address it.
   *
   * Not in the original sketch, which had the registry alone. The registry is keyed by run because a surface
   * answers "this run's question", and the context is the only place holding both the registry and the id.
   */
  runId?: string
}

export function createWorkflowContext<A>(input: CreateContextInput<A>): WorkflowContext<A> {
  const { client, parentSessionID, args, state, events } = input
  // Own the default policy here: an absent OR non-finite (NaN/Infinity, e.g. a mis-computed `meta.concurrency`)
  // value resolves to the plugin default cap. Finite values (incl. 0/negative) pass through — the Semaphore
  // constructor clamps those to ≥ 1. This keeps a bad cap from silently zeroing the limiter (D9).
  const concurrency = Number.isFinite(input.concurrency) ? (input.concurrency as number) : defaultConcurrency()

  // ONE shared limiter for the whole Run. `agent()` is the only thing that launches a Unit, so bounding it
  // here means `parallel` and `pipeline` (which launch Units only through `agent`) automatically draw from the
  // same cap — total in-flight Units never exceeds it, however many primitives are mid-flight at once (D5).
  const limiter = new Semaphore(concurrency)

  // The Run's abort signal — threaded into the limiter (stops launching QUEUED Units) AND into each Unit's
  // prompt (cancels an IN-FLIGHT Unit via session.abort, so a hung subagent is freed) (D11). Default to a
  // fresh, never-aborted signal so `ctx.signal` is always a real AbortSignal.
  const signal = input.signal ?? new AbortController().signal

  // Advisory budget (D10) — NO engine hard-stop. `total` is the caller's ceiling (null ⇒ none); `spent()` reads
  // the live running token sum; `remaining()` floors at 0 (or Infinity when uncapped). Over-budget Units still
  // run — the budget informs author decisions, it never refuses work.
  const budgetTotal = input.budget == null ? null : input.budget
  const budget: WorkflowContext<A>["budget"] = {
    total: budgetTotal,
    spent: () => state.tokensSpent,
    remaining: () => (budgetTotal == null ? Infinity : Math.max(0, budgetTotal - state.tokensSpent)),
  }

  // Implemented as a plain function cast to the generic `AgentFn`: the public type carries the conditional
  // return (schema ⇒ inferred type, else string), which the body satisfies by returning the parsed `value` or
  // the `text` — the cast is the standard way to reconcile a generic conditional return with its impl.
  const agent = (async (prompt: string, opts: AgentOpts<z.ZodType> = {}) => {
    // Stamp the ordinal + resolve grouping at CALL time (author intent), then queue on the shared limiter; the
    // Unit only "starts" (onUnitStart) once it actually holds a permit, so progress reflects launches not calls.
    state.unitCount += 1
    const ordinal = state.unitCount
    const unitId = crypto.randomUUID()
    const subagent = opts.subagent ?? DEFAULT_SUBAGENT
    const phase = opts.phase ?? state.currentPhase
    const label = opts.label ?? null
    const base = { unitId, ordinal, label, subagent, phase, prompt }
    const queued: UnitSnapshot = {
      ...base,
      status: "queued",
      sessionID: null,
      startedAt: null,
      endedAt: null,
    }
    events?.onUnitQueued?.({ ...queued })

    try {
      return await limiter.run(async () => {
        const startedAt = Date.now()
        const started: UnitSnapshot = {
          ...base,
          status: "running",
          sessionID: null,
          startedAt,
          endedAt: null,
        }
        events?.onUnitStart?.({ ...started })
        const result = await runAgent(client, parentSessionID, prompt, {
          subagent: opts.subagent,
          model: opts.model,
          schema: opts.schema,
          retries: opts.retries,
          // Forward the Run signal (so abort cancels this in-flight Unit, not just queued ones) + the per-Unit
          // timeout (a Unit's own `timeoutMs` overrides the Run default), so a hung prompt fails instead of
          // blocking the whole Run.
          signal,
          timeoutMs: opts.timeoutMs ?? input.unitTimeout,
          // Only wire the handle when someone is listening: without a subscriber the runner keeps its plain
          // blocking-prompt path rather than building a per-attempt controller nobody can reach.
          ...(events?.onUnitCancelable
            ? {
                onCancelable: (cancel: () => void, childSessionID: string) =>
                  events.onUnitCancelable?.(unitId, cancel, childSessionID),
              }
            : {}),
        })

        // Record the Unit's child session (present even when the prompt failed; null only on create failure) so
        // the human can open its transcript from the session list, and the adapter can surface live child links.
        const record: UnitRecord = { sessionID: result.childSessionID ?? null, label, subagent, phase, ok: result.ok }
        state.units.push(record)
        const settled: UnitSnapshot = {
          ...base,
          status: result.ok ? "ok" : "failed",
          sessionID: result.childSessionID ?? null,
          startedAt,
          endedAt: Date.now(),
          error: result.ok ? undefined : result.error,
          output: result.ok ? toUnitOutput(result.kind === "structured" ? result.value : result.text) : undefined,
        }
        events?.onUnitSettled?.({ ...settled })

        if (result.ok) {
          state.tokensSpent += result.outputTokens // feed the advisory budget (completed Units only)
          return result.kind === "structured" ? result.value : result.text
        }
        state.errors.push({ unit: label ?? subagent, prompt, subagent, error: result.error })
        return null
      }, signal)
    } catch (err) {
      // An AbortError means the limiter rejected this Unit's acquire because the Run was aborted while it was
      // still QUEUED — it never launched. Record + null (D9): an aborted Unit is not silently dropped.
      if (err instanceof AbortError) {
        const error = stringifyError(err)
        const record: UnitRecord = { sessionID: null, label, subagent, phase, ok: false }
        state.units.push(record)
        events?.onUnitSettled?.({
          ...base,
          status: "failed",
          sessionID: null,
          startedAt: null,
          endedAt: Date.now(),
          error,
        })
        state.errors.push({ unit: label ?? subagent, prompt, subagent, error })
        return null
      }
      // Anything else is unexpected: runAgent never throws (it returns ok:false), so the only other source is a
      // bug in an injected events callback. Don't mislabel it as an aborted Unit or double-record — let it
      // propagate so it surfaces honestly via the orchestrator/adapter rather than vanishing into a null slot.
      throw err
    }
  }) as WorkflowContext<A>["agent"]

  // A barrier: launch every thunk and await them all. The concurrency cap is NOT enforced here — it lives in
  // `agent()` (the shared limiter), so a thunk's Units queue against the same cap as everything else. A Unit
  // that fails via agent() has already recorded its (rich) error and resolves to null — passed straight
  // through. A thunk that *throws* (author code, a chained `.then`, an unexpected agent() error) is caught
  // here: its slot becomes null and a best-effort entry is appended to errors, so a drop is never silent (D9).
  const parallel: WorkflowContext<A>["parallel"] = async (thunks) => {
    const settled = await Promise.allSettled(thunks.map((thunk) => thunk()))
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

  // No barrier between items (D4): each item runs its own independent stage chain, so item A can be in stage 3
  // while item B is still in stage 1. `Promise.all` only collects the per-item chains in input order — it does
  // not synchronise the stages. Bounding is uniform: every Unit a stage launches goes through `agent()`, which
  // draws from the same shared limiter, so total in-flight Units never exceeds the cap regardless of how many
  // chains are mid-flight. Stages receive `(running value, original item, index)`.
  const pipeline = ((items: unknown[], ...stages: Array<(prev: unknown, item: unknown, index: number) => unknown>) => {
    const runItem = async (item: unknown, index: number) => {
      let value: unknown = item
      for (const stage of stages) {
        try {
          value = await stage(value, item, index)
        } catch (err) {
          // A stage threw (author code, a chained `.then`, an unexpected error): collapse THIS item to null,
          // record it (never silent — D9), and skip its remaining stages. Other items keep flowing. A Unit
          // that *fails* via agent() returns null without throwing, so it flows on as `null` rather than
          // dropping the item — that's the documented pipeline contract.
          state.errors.push({
            unit: `pipeline#${index}`,
            prompt: "(unavailable: a pipeline stage threw outside agent())",
            subagent: "(unknown)",
            error: stringifyError(err),
          })
          return null
        }
      }
      return value
    }
    return Promise.all(items.map((item, index) => runItem(item, index)))
  }) as WorkflowContext<A>["pipeline"]

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

  // The headless contract, stated once here rather than checked at every call site: with no registry (or no
  // run to attach the question to) the fallback IS the answer, and it arrives without a wait. That is what
  // makes `ctx.ask` safe to put in a workflow that will also run in CI.
  const ask: WorkflowContext<A>["ask"] = async (form, options) => {
    const questions = Array.isArray(form) ? form : [form]
    if (questions.length === 0) return []
    const registry = input.ask
    if (!registry || !input.runId) {
      const fallback = coerceAskAnswer(questions, options.fallback)
      if (!fallback) {
        throw new Error(
          "ctx.ask: `fallback` must have one entry per question, each drawn from that question's offered labels",
        )
      }
      return fallback
    }
    return registry.ask(input.runId, questions, options)
  }

  return {
    agent,
    ask,
    parallel,
    pipeline,
    collect,
    get errors() {
      return state.errors
    },
    args,
    log,
    phase,
    budget,
    signal,
  }
}
