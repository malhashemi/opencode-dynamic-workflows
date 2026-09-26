/**
 * The Unit index — Unit session → the Run's live binding, shared by every plugin instance in the process.
 *
 * Hooks and tools receive only a `sessionID`. This index is how they find out whether that session is a Unit,
 * which schema its `workflow_result` must satisfy, how many model steps it has taken, and how to reach its Run's
 * interaction broker. It lives on `globalThis` (see {@link engineGlobal}) because OpenCode runs one plugin
 * instance per location and rebuilds instances on reload; an index held by one instance would orphan every
 * in-flight Unit the moment that instance is replaced.
 */
import type { z } from "zod"

import type { InteractionQuestion } from "./protocol"

export interface UnitAskResult {
  answers: string[][]
  by: "human" | "automation"
}

export interface UnitBinding {
  sessionID: string
  runId: string
  unitId: string
  /** The Run's location (project directory). */
  location: string
  workflow: string
  /** Present for `agent({ schema })` Units: the zod schema and its JSON Schema (sent to the model). */
  schema?: z.ZodType
  jsonSchema?: Record<string, unknown>
  /** The first valid `workflow_result` payload, parsed through `schema`. */
  result?: { value: unknown }
  lastError?: string
  toolCalls: number
  invalidCalls: number
  /** Model requests seen by the `context` hook — the step guard's counter. */
  steps: number
  maxSteps: number
  /** True while the engine is sending repair turns (the system instruction becomes more insistent). */
  repairing: boolean
  settled: boolean
  /**
   * Set by `restartUnit` just before it interrupts the session: the runner then re-sends the task in the SAME
   * session instead of treating the interrupt as a stop.
   */
  restart: boolean
  /** True between admitting a prompt and its turn settling — the only time a restart can take effect. */
  turnActive: boolean
  /** Restarts used so far (a surface may restart a running Unit at most MAX_RESTARTS times). */
  restarts: number
  /** Called once when `steps` passes `maxSteps`; the runner interrupts the Unit. */
  onStepLimit: () => void
  /**
   * Route a question the Unit's model asked (built-in `question` tool) to the Run's broker. Resolves with the
   * answers, or `null` when nobody can answer (headless) — the tool then tells the model to proceed.
   */
  ask: (questions: InteractionQuestion[], signal: AbortSignal) => Promise<UnitAskResult | null>
  /** Workflow permission policy for this Unit's `ask` decisions (see `broker.ts`). */
  permissionPolicy: () => "ask" | "auto" | "deny"
}

export type SubmitResult = { ok: true } | { ok: false; error: string }

export interface UnitIndex {
  bind(binding: UnitBinding): () => void
  get(sessionID: string): UnitBinding | undefined
  /** Validate a `workflow_result` payload for a Unit session and keep it when valid. */
  submit(sessionID: string, input: unknown): SubmitResult
  size(): number
  all(): UnitBinding[]
}

export function formatIssues(error: z.ZodError): string {
  return error.issues.map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`).join("; ")
}

export function createUnitIndex(): UnitIndex {
  const bindings = new Map<string, UnitBinding>()
  return {
    bind(binding) {
      bindings.set(binding.sessionID, binding)
      return () => {
        if (bindings.get(binding.sessionID) === binding) bindings.delete(binding.sessionID)
      }
    },
    get(sessionID) {
      return bindings.get(sessionID)
    },
    submit(sessionID, input) {
      const binding = bindings.get(sessionID)
      if (!binding) return { ok: false, error: "workflow_result is only available inside workflow Unit sessions." }
      binding.toolCalls += 1
      if (!binding.schema) {
        // A text Unit calling the tool anyway: accept the value as its answer rather than refusing a helpful model.
        binding.result ??= { value: input }
        return { ok: true }
      }
      const parsed = binding.schema.safeParse(input)
      if (!parsed.success) {
        binding.invalidCalls += 1
        binding.lastError = formatIssues(parsed.error)
        return { ok: false, error: binding.lastError }
      }
      // First valid result wins: a model that calls twice must not overwrite an answer the engine already read.
      binding.result ??= { value: parsed.data }
      return { ok: true }
    },
    size() {
      return bindings.size
    },
    all() {
      return [...bindings.values()]
    },
  }
}
