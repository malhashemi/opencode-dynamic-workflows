/**
 * The context factory — assembles the {@link WorkflowContext} handed to a Workflow's `run`.
 *
 * The skeleton wires the minimal surface (`agent`, `args`, `log`, `phase`). The engine keeps a private
 * {@link EngineState} the context closes over, so logs/phases/errors/unit-counts can be surfaced in the tool
 * result without widening the author-facing API. Failed Units resolve to `null` and are recorded in
 * `state.errors` (error model D9) rather than throwing and aborting the Run.
 */
import type { AgentOpts, WorkflowContext } from "@opencode-ai/workflow"
import type { WorkflowClient } from "./client"
import { DEFAULT_SUBAGENT, runAgent } from "./runner"

/** Optional live-progress sink (the adapter forwards these to `ctx.metadata`). */
export interface EngineEvents {
  onLog?: (message: string) => void
  onPhase?: (title: string) => void
  onUnitStart?: (info: { prompt: string; subagent: string; phase: string | null; label: string | null }) => void
}

export interface EngineState {
  logs: string[]
  phases: string[]
  currentPhase: string | null
  errors: { prompt: string; subagent: string; error: string }[]
  unitCount: number
}

export function createEngineState(): EngineState {
  return { logs: [], phases: [], currentPhase: null, errors: [], unitCount: 0 }
}

export interface CreateContextInput<A> {
  client: WorkflowClient
  parentSessionID: string
  args: A
  state: EngineState
  events?: EngineEvents
}

export function createWorkflowContext<A>(input: CreateContextInput<A>): WorkflowContext<A> {
  const { client, parentSessionID, args, state, events } = input

  const agent: WorkflowContext<A>["agent"] = async (prompt, opts: AgentOpts = {}) => {
    state.unitCount += 1
    const subagent = opts.subagent ?? DEFAULT_SUBAGENT
    events?.onUnitStart?.({
      prompt,
      subagent,
      phase: opts.phase ?? state.currentPhase,
      label: opts.label ?? null,
    })

    const result = await runAgent(client, parentSessionID, prompt, {
      subagent: opts.subagent,
      model: opts.model,
      schema: opts.schema,
    })

    if (result.ok) return result.text
    state.errors.push({ prompt, subagent, error: result.error })
    return null
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

  return { agent, args, log, phase }
}
