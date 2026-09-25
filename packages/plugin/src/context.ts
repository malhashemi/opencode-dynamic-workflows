/**
 * The context factory — assembles the {@link WorkflowContext} handed to a Workflow's `run`.
 *
 * Semantics carried from V1 (and pinned by the tests): one shared {@link Semaphore} caps in-flight Units across
 * the whole Run, so `parallel` (a barrier) and `pipeline` (no barrier between items) draw from the same limiter
 * (D5); a failed Unit resolves to `null` and is recorded in `ctx.errors` rather than throwing (D9); the budget is
 * advisory unless the Workflow asks for a hard one (D10); the Run's signal stops queued AND in-flight Units (D11).
 *
 * New on V2: Units run through {@link runUnit} on public session APIs; hard limits stop a runaway script with a
 * legible error; and a resumed Run replays the Units a previous Run already finished (start-order replay).
 */
import type { AgentOpts, AskOptions, AskQuestion, WorkflowContext, WorkflowError, z } from "./workflow"
import { formatModel, toHostModel, type EngineHost, type HostPermissionRule } from "./host"
import { emptyUsage, type Unit, type Usage } from "./protocol"
import { DEFAULT_SUBAGENT, runUnit, stringifyError, type UnitRunResult } from "./runner"
import { toUnitOutput } from "./runs"
import { createCapabilities } from "./capabilities"
import { AbortError, defaultConcurrency, Semaphore } from "./scheduler"
import { resolveJsonSchema } from "./schema-bridge"
import type { UnitBinding, UnitIndex } from "./units"

export interface EngineEvents {
  onLog?: (message: string) => void
  onPhase?: (title: string) => void
  /** Every Unit transition (queued, running, repairing, settled). */
  onUnit?: (unit: Unit) => void
  /** The Unit session exists; `stop` ends just this Unit. */
  onUnitSession?: (unitId: string, sessionID: string, stop: () => void) => void
}

export interface EngineState {
  logs: string[]
  phases: string[]
  currentPhase: string | null
  errors: WorkflowError[]
  unitCount: number
  /** Output tokens of completed Units — what `ctx.budget.spent()` reports. */
  tokensSpent: number
  usage: Usage
}

export function createEngineState(): EngineState {
  return { logs: [], phases: [], currentPhase: null, errors: [], unitCount: 0, tokensSpent: 0, usage: emptyUsage() }
}

export interface RunLimits {
  maxUnits: number
  maxItemsPerCall: number
  maxUnitSteps: number
}

export const DEFAULT_LIMITS: RunLimits = { maxUnits: 1_000, maxItemsPerCall: 4_096, maxUnitSteps: 250 }

/** What a previous Run recorded, for resume. Keyed by Unit ordinal (start order). */
export interface ReplayPlan {
  units: Map<number, { prompt: string; status: Unit["status"]; output?: string; schema: boolean; subagent: string }>
  /** Answers to `ctx.ask`, in the order they were asked; `null` means the author's fallback was used. */
  answers: Array<string[][] | null>
  rerunFailed: boolean
  /** Set once the script diverges from the record; from then on everything runs live. */
  diverged: boolean
  onDiverge?: (message: string) => void
}

export interface CreateContextInput<A> {
  host: EngineHost
  index: UnitIndex
  runId: string
  workflow: string
  location: string
  parentSessionID: string
  args: A
  state: EngineState
  events?: EngineEvents
  concurrency?: number
  budget?: number | null
  hardBudget?: boolean
  signal?: AbortSignal
  unitTimeout?: number
  /** Publish `ctx.ask` (the broker). Absent ⇒ the fallback answers at once — the headless contract. */
  ask?: (form: AskQuestion[], options: AskOptions) => Promise<string[][]>
  /** Route a Unit model's `question` call to the broker. */
  askAgent?: (unitId: string, sessionID: string) => UnitBinding["ask"]
  permissionPolicy?: UnitBinding["permissionPolicy"]
  /** Workflow-level rules applied to every Unit session. */
  permissions?: HostPermissionRule[]
  limits?: Partial<RunLimits>
  /** A limit was hit: the orchestrator stops the Run with this message. */
  onLimit?: (message: string) => void
  replay?: ReplayPlan
  /** Extra context members (capabilities) merged onto the context. */
  extend?: Record<string, unknown>
}

function newUnit(input: {
  runId: string
  unitId: string
  ordinal: number
  label: string | null
  subagent: string
  phase: string | null
  prompt: string
  model: string | null
  schema: boolean
}): Unit {
  return {
    unitId: input.unitId,
    runId: input.runId,
    ordinal: input.ordinal,
    label: input.label,
    subagent: input.subagent,
    phase: input.phase,
    status: "queued",
    sessionID: null,
    location: null,
    prompt: input.prompt,
    model: { requested: input.model, resolved: null },
    schema: input.schema,
    resultPath: null,
    attempts: [],
    usage: emptyUsage(),
    startedAt: null,
    endedAt: null,
  }
}

const noAgentQuestions: UnitBinding["ask"] = async () => null

export function createWorkflowContext<A>(input: CreateContextInput<A>): WorkflowContext<A> {
  const { state, events } = input
  const limits: RunLimits = { ...DEFAULT_LIMITS, ...input.limits }
  const concurrency = Number.isFinite(input.concurrency) ? (input.concurrency as number) : defaultConcurrency()
  const limiter = new Semaphore(concurrency)
  const signal = input.signal ?? new AbortController().signal
  const budgetTotal = input.budget == null ? null : input.budget
  const budget: WorkflowContext<A>["budget"] = {
    total: budgetTotal,
    spent: () => state.tokensSpent,
    remaining: () => (budgetTotal == null ? Infinity : Math.max(0, budgetTotal - state.tokensSpent)),
  }
  let limitHit = false
  const hitLimit = (message: string) => {
    if (limitHit) return
    limitHit = true
    state.logs.push(message)
    input.onLimit?.(message)
  }
  const emit = (unit: Unit) => events?.onUnit?.({ ...unit, model: { ...unit.model }, attempts: [...unit.attempts] })

  const replayed = (
    unit: Unit,
    record: NonNullable<ReturnType<ReplayPlan["units"]["get"]>>,
    schema: z.ZodType | undefined,
  ): { value: unknown } | null => {
    if (record.status !== "succeeded" && record.status !== "replayed") return null
    if (record.output === undefined) return { value: schema ? null : "" }
    if (!schema) return { value: record.output }
    try {
      const parsed = schema.safeParse(JSON.parse(record.output))
      return parsed.success ? { value: parsed.data } : null
    } catch {
      return null
    }
  }

  const agent = (async (prompt: string, opts: AgentOpts<z.ZodType> = {}) => {
    state.unitCount += 1
    const ordinal = state.unitCount
    const unitId = crypto.randomUUID()
    const subagent = opts.subagent ?? opts.agentType ?? DEFAULT_SUBAGENT
    const phase = opts.phase ?? state.currentPhase
    const label = opts.label ?? null
    const model = toHostModel(opts.model)
    const withVariant = model && opts.effort && !model.variant ? { ...model, variant: opts.effort } : model
    let schema: z.ZodType | undefined
    try {
      schema = resolveJsonSchema(opts.schema)
    } catch (error) {
      const message = `agent({ schema }) is not a zod schema or a JSON Schema: ${stringifyError(error)}`
      state.errors.push({ unit: label ?? subagent, prompt, subagent, error: message })
      return null
    }
    const unit = newUnit({
      runId: input.runId,
      unitId,
      ordinal,
      label,
      subagent,
      phase,
      prompt,
      model: formatModel(withVariant),
      schema: schema !== undefined,
    })

    if (ordinal > limits.maxUnits) {
      hitLimit(`limit reached: this Run tried to start more than ${limits.maxUnits} Units (limits.maxUnits)`)
    }
    if (input.hardBudget && budgetTotal !== null && state.tokensSpent >= budgetTotal) {
      hitLimit(`budget exhausted: ${state.tokensSpent} of ${budgetTotal} output tokens spent (meta.budget, hard)`)
    }

    // Resume: a Unit the previous Run already finished comes back from the record, in start order.
    const plan = input.replay
    if (plan && !plan.diverged) {
      const record = plan.units.get(ordinal)
      if (record && record.prompt === prompt) {
        const value = replayed(unit, record, schema)
        if (value) {
          const done: Unit = {
            ...unit,
            status: "replayed",
            resultPath: "replay",
            output: toUnitOutput(value.value),
            startedAt: Date.now(),
            endedAt: Date.now(),
          }
          emit(done)
          return value.value
        }
        if (!plan.rerunFailed) {
          const error = "replayed failure from the resumed Run"
          emit({ ...unit, status: "failed", error, startedAt: Date.now(), endedAt: Date.now() })
          state.errors.push({ unit: label ?? subagent, prompt, subagent, error })
          return null
        }
      } else if (record) {
        plan.diverged = true
        plan.onDiverge?.(
          `resume diverged at Unit ${ordinal}: the script asked for a different prompt than the recorded Run; running live from here`,
        )
      }
    }

    emit(unit)
    try {
      return await limiter.run(async () => {
        let current: Unit = { ...unit, status: "running", startedAt: Date.now() }
        emit(current)
        const result: UnitRunResult = await runUnit(input.host, input.index, {
          runId: input.runId,
          unitId,
          workflow: input.workflow,
          location: input.location,
          ...(opts.location ? { unitLocation: opts.location } : {}),
          parentSessionID: input.parentSessionID,
          ordinal,
          prompt,
          subagent,
          label,
          ...(withVariant ? { model: withVariant } : {}),
          ...(schema ? { schema } : {}),
          ...(opts.retries !== undefined ? { retries: opts.retries } : {}),
          ...(opts.timeoutMs ?? input.unitTimeout ? { timeoutMs: opts.timeoutMs ?? input.unitTimeout } : {}),
          signal,
          maxSteps: limits.maxUnitSteps,
          permissions: [...(input.permissions ?? []), ...(opts.permissions ?? [])],
          ask: noAgentQuestions,
          permissionPolicy: input.permissionPolicy ?? (() => "deny"),
          onSession: (sessionID, stop) => {
            current = { ...current, sessionID, location: opts.location ?? input.location }
            const binding = input.index.get(sessionID)
            if (binding && input.askAgent) binding.ask = input.askAgent(unitId, sessionID)
            emit(current)
            events?.onUnitSession?.(unitId, sessionID, stop)
          },
          onRepairing: () => {
            current = { ...current, status: "repairing" }
            emit(current)
          },
        })

        const usage = result.usage
        state.usage = {
          tokens: {
            input: state.usage.tokens.input + usage.tokens.input,
            output: state.usage.tokens.output + usage.tokens.output,
            reasoning: state.usage.tokens.reasoning + usage.tokens.reasoning,
            cacheRead: state.usage.tokens.cacheRead + usage.tokens.cacheRead,
            cacheWrite: state.usage.tokens.cacheWrite + usage.tokens.cacheWrite,
          },
          cost: state.usage.cost + usage.cost,
        }
        state.tokensSpent += usage.tokens.output
        const settled: Unit = {
          ...current,
          sessionID: result.sessionID ?? current.sessionID,
          status: result.ok ? "succeeded" : result.stopped ? "stopped" : "failed",
          model: { requested: current.model.requested, resolved: formatModel(result.model) },
          resultPath: result.ok ? result.path : null,
          attempts: result.attempts,
          usage,
          endedAt: Date.now(),
          ...(result.ok ? { output: toUnitOutput(result.value) } : { error: result.error }),
        }
        emit(settled)
        if (input.hardBudget && budgetTotal !== null && state.tokensSpent >= budgetTotal) {
          hitLimit(`budget exhausted: ${state.tokensSpent} of ${budgetTotal} output tokens spent (meta.budget, hard)`)
        }
        if (result.ok) return result.value
        state.errors.push({ unit: label ?? subagent, prompt, subagent, error: result.error })
        return null
      }, signal)
    } catch (err) {
      if (err instanceof AbortError) {
        const error = stringifyError(err)
        emit({ ...unit, status: "stopped", error, endedAt: Date.now() })
        state.errors.push({ unit: label ?? subagent, prompt, subagent, error })
        return null
      }
      throw err
    }
  }) as WorkflowContext<A>["agent"]

  const checkItems = (count: number, what: string) => {
    if (count > limits.maxItemsPerCall) {
      throw new Error(`limit reached: ${what} got ${count} items; the limit is ${limits.maxItemsPerCall} (limits.maxItemsPerCall)`)
    }
  }

  const parallel: WorkflowContext<A>["parallel"] = async (thunks) => {
    checkItems(thunks.length, "parallel")
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

  const pipeline = (async (items: unknown[], ...stages: Array<(prev: unknown, item: unknown, index: number) => unknown>) => {
    checkItems(items.length, "pipeline")
    const runItem = async (item: unknown, index: number) => {
      let value: unknown = item
      for (const stage of stages) {
        try {
          value = await stage(value, item, index)
        } catch (err) {
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

  const ask: WorkflowContext<A>["ask"] = async (form, options) => {
    const questions = Array.isArray(form) ? form : [form]
    if (questions.length === 0) return []
    const plan = input.replay
    if (plan && !plan.diverged && plan.answers.length > 0) {
      const recorded = plan.answers.shift()!
      const { coerceAnswers, toInteractionQuestions } = await import("./broker")
      const coerced = coerceAnswers(toInteractionQuestions(questions), recorded ?? options.fallback)
      if (coerced) return coerced
      plan.diverged = true
      plan.onDiverge?.("resume diverged at a ctx.ask: the recorded answer does not fit the question; asking live from here")
    }
    if (!input.ask) {
      const { coerceAnswers, toInteractionQuestions } = await import("./broker")
      const fallback = coerceAnswers(toInteractionQuestions(questions), options.fallback)
      if (!fallback) {
        throw new Error("ctx.ask: `fallback` must have one entry per question, each drawn from that question's offered labels")
      }
      return fallback
    }
    return input.ask(questions, options)
  }

  return {
    ...createCapabilities({ location: input.location, signal, audit: () => {}, disabled: "capabilities are only available inside a Run" }),
    ...(input.extend ?? {}),
    agent,
    ask,
    parallel,
    pipeline,
    collect,
    get errors() {
      return state.errors
    },
    args: input.args,
    log,
    phase,
    budget,
    signal,
  } as unknown as WorkflowContext<A>
}
