/**
 * The orchestrator — turns a loaded Workflow into a Run.
 *
 * It validates `args` against `meta.args` before anything launches (D7), creates the Run in the store, opens its
 * journal record, wires the Run's interactions to the broker, builds the context, calls `run`, and settles the
 * Run with a terminal status and result. Host-independent: everything OpenCode-specific arrives as an
 * {@link EngineHost} and an {@link UnitIndex}.
 */
import type { Broker } from "./broker"
import { createEngineState, createWorkflowContext, type ReplayPlan, type RunLimits } from "./context"
import type { EngineHost, HostPermissionRule } from "./host"
import type { Journal } from "./journal"
import type { Run, WorkflowIdentity } from "./protocol"
import { newRun, type RunStore } from "./runs"
import type { UnitIndex } from "./units"
import type { DefineWorkflowConfig, WorkflowMeta } from "./workflow"

/** No default per-Unit timeout: a deadline is opt-in (meta.unitTimeout, the Run, or agent({ timeoutMs })). */
export function resolveUnitTimeout(fromRun: number | undefined, fromMeta: number | undefined): number | undefined {
  return fromRun ?? fromMeta
}

/** No default grace on a question: absent both a per-Workflow and a per-ask grace, a question waits. */
export function resolveAskGrace(fromMeta: number | undefined): number | null {
  if (fromMeta === undefined || !Number.isFinite(fromMeta)) return null
  return Math.max(0, fromMeta)
}

export type PermissionPolicy = "ask" | "auto" | "deny"

export function resolvePermissionPolicy(meta: Pick<WorkflowMeta, "interaction">): PermissionPolicy {
  const value = meta.interaction?.permissions
  if (value === "auto" || value === "deny") return value
  return "ask"
}

export function resolveBudget(meta: Pick<WorkflowMeta, "budget">, override?: number): { total: number | null; hard: boolean } {
  if (override !== undefined) return { total: override, hard: false }
  const budget = meta.budget
  if (budget === undefined) return { total: null, hard: false }
  if (typeof budget === "number") return { total: budget, hard: false }
  return { total: budget.tokens, hard: budget.hard === true }
}

export function formatArgsIssues(error: { issues: Array<{ path: PropertyKey[]; message: string }> }): string {
  return error.issues.map((issue) => `${issue.path.map(String).join(".") || "(root)"}: ${issue.message}`).join("; ")
}

export class InvalidArgsError extends Error {
  constructor(detail: string) {
    super(`invalid args: ${detail}`)
    this.name = "InvalidArgsError"
  }
}

export function previewResult(result: unknown, max = 400): string | null {
  if (result === undefined || result === null) return null
  const text = typeof result === "string" ? result : JSON.stringify(result)
  if (text === undefined) return null
  return text.length > max ? `${text.slice(0, max - 1)}…` : text
}

export interface RunWorkflowInput {
  config: DefineWorkflowConfig
  source: string
  identity: WorkflowIdentity
  args?: unknown
  host: EngineHost
  index: UnitIndex
  broker: Broker
  store: RunStore
  journal?: Journal | null
  runId: string
  parentSessionID: string
  location: string
  /** Plugin instance id, recorded as the Run's owner in the journal. */
  instance?: string
  signal?: AbortSignal
  unitTimeout?: number
  budget?: number
  background?: boolean
  limits?: Partial<RunLimits>
  replay?: ReplayPlan
  resumeOf?: string | null
  /** Rules applied to every Unit session in addition to `meta.permissions`. */
  permissions?: HostPermissionRule[]
  /** Extra context members (capabilities). */
  extend?: Record<string, unknown>
  /** The Run exists; `stop` ends it. */
  onRegister?: (runId: string, stop: (reason?: string) => void) => void
  onUnitSession?: (runId: string, unitId: string, sessionID: string, stop: () => void) => void
  /** Called when the Run is terminal (after the store and journal have it). */
  onSettled?: (run: Run, result: unknown) => void
  /** An existing store Run to continue (status `queued`, e.g. after an approval), instead of creating one. */
  existingRun?: boolean
}

export interface RunWorkflowOutput {
  result: unknown
  run: Run
  meta: DefineWorkflowConfig["meta"]
}

function journalWrite(write: (() => Promise<void>) | undefined): Promise<void> {
  if (!write) return Promise.resolve()
  try {
    return write().catch(() => {})
  } catch {
    return Promise.resolve()
  }
}

/** Validate `args` against `meta.args`; returns the parsed value. Throws {@link InvalidArgsError}. */
export function validateArgs(meta: WorkflowMeta, args: unknown): unknown {
  const schema = meta.args
  if (!schema) return args
  const parsed = schema.safeParse(args)
  if (!parsed.success) throw new InvalidArgsError(formatArgsIssues(parsed.error))
  return parsed.data
}

/**
 * Run a loaded Workflow. Resolves with the result once the Run is terminal; rejects only when the Run could not
 * start (invalid args) or when the author's `run` threw — in both cases the Run is recorded as failed first.
 */
export async function runWorkflow(input: RunWorkflowInput): Promise<RunWorkflowOutput> {
  const { config, store } = input
  const meta = config.meta
  const stopController = new AbortController()
  const signal = input.signal ? AbortSignal.any([input.signal, stopController.signal]) : stopController.signal
  const budget = resolveBudget(meta, input.budget)
  let stopReason: string | undefined

  let args: unknown
  const phases = (meta.phases ?? []).map((phase) => phase.title)
  if (!input.existingRun) {
    store.create(
      newRun({
        runId: input.runId,
        workflow: input.identity,
        location: input.location,
        parentSessionID: input.parentSessionID,
        phases,
        budget: budget.total,
        hardBudget: budget.hard,
        background: input.background ?? false,
        resumeOf: input.resumeOf ?? null,
      }),
    )
  } else {
    store.apply({
      type: "run.patch",
      runId: input.runId,
      patch: { status: "running", phases, phasesDeclared: phases.length > 0, budget: { total: budget.total, hard: budget.hard } },
    })
  }
  input.onRegister?.(input.runId, (reason) => {
    stopReason ??= reason
    stopController.abort(new Error(reason ?? "stopped"))
  })

  const state = createEngineState()
  let result: unknown
  let status: Run["status"] = "failed"
  let failure: string | undefined

  try {
    try {
      args = validateArgs(meta, input.args)
    } catch (error) {
      failure = error instanceof Error ? error.message : String(error)
      throw error
    }
    void journalWrite(
      input.journal ? () => input.journal!.begin(store.get(input.runId)!, { source: input.source, args, instance: input.instance ?? "" }) : undefined,
    )

    const ctx = createWorkflowContext({
      host: input.host,
      index: input.index,
      runId: input.runId,
      workflow: meta.name,
      location: input.location,
      parentSessionID: input.parentSessionID,
      args,
      state,
      concurrency: meta.concurrency,
      budget: budget.total,
      hardBudget: budget.hard,
      signal,
      unitTimeout: resolveUnitTimeout(input.unitTimeout, meta.unitTimeout),
      limits: { ...meta.limits, ...input.limits },
      permissions: [...(meta.permissions ?? []), ...(input.permissions ?? [])],
      permissionPolicy: () => resolvePermissionPolicy(meta),
      ask: (form, options) =>
        input.broker.ask({
          runId: input.runId,
          sessionID: input.parentSessionID,
          form,
          options,
          defaultGraceMs: resolveAskGrace(meta.interaction?.graceMs),
          signal,
        }),
      askAgent: (unitId, sessionID) => (questions, unitSignal) =>
        input.broker.askAgent({ runId: input.runId, unitId, sessionID, questions, signal: AbortSignal.any([signal, unitSignal]) }),
      onLimit: (message) => {
        stopReason ??= message
        failure = message
        stopController.abort(new Error(message))
      },
      ...(input.replay
        ? {
            replay: {
              ...input.replay,
              onDiverge: (message: string) => store.apply({ type: "run.log", runId: input.runId, value: message, kind: "engine" }),
            },
          }
        : {}),
      ...(input.extend ? { extend: input.extend } : {}),
      events: {
        onLog: (message) => store.apply({ type: "run.log", runId: input.runId, value: message }),
        onPhase: (title) => store.apply({ type: "run.phase", runId: input.runId, value: title }),
        onUnit: (unit) => {
          store.apply({ type: "unit.upsert", runId: input.runId, unit })
          if (unit.endedAt !== null) {
            store.apply({
              type: "run.patch",
              runId: input.runId,
              patch: { tokensSpent: state.tokensSpent, errors: state.errors.map((error) => ({ ...error })) },
            })
          }
        },
        onUnitSession: (unitId, sessionID, stop) => input.onUnitSession?.(input.runId, unitId, sessionID, stop),
      },
    })

    result = await config.run(ctx)
    status = signal.aborted ? (failure ? "failed" : "stopped") : "succeeded"
    return { result, run: store.get(input.runId)!, meta }
  } catch (error) {
    const aborted = signal.aborted || (error instanceof Error && error.name === "AbortError")
    status = failure ? "failed" : aborted ? "stopped" : "failed"
    failure ??= error instanceof Error ? error.message : String(error)
    throw error
  } finally {
    input.broker.releaseRun(input.runId)
    const current = store.get(input.runId)
    if (current && (current.status === "running" || current.status === "queued")) {
      if (failure && status !== "succeeded") store.apply({ type: "run.log", runId: input.runId, value: `run ${status}: ${failure}`, kind: "engine" })
      if (stopReason && status === "stopped") store.apply({ type: "run.log", runId: input.runId, value: `stopped: ${stopReason}`, kind: "engine" })
      store.apply({
        type: "run.ended",
        runId: input.runId,
        patch: {
          status,
          currentPhase: state.currentPhase ?? current.currentPhase,
          errors: state.errors.map((error) => ({ ...error })),
          tokensSpent: state.tokensSpent,
          endedAt: Date.now(),
          resultPreview: status === "succeeded" ? previewResult(result) : null,
        },
      })
    }
    const terminal = store.get(input.runId)
    if (terminal) {
      await journalWrite(input.journal ? () => input.journal!.finish(terminal, result) : undefined)
      input.onSettled?.(terminal, result)
    }
  }
}
