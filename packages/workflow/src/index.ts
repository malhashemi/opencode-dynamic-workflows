/**
 * `@opencode-ai/workflow` — the author-facing surface.
 *
 * A Workflow is a TypeScript module that exports `defineWorkflow({ meta, run })`. Authors import
 * `defineWorkflow` and `z` from here; the plugin engine injects a live {@link WorkflowContext} at run time.
 *
 * This package is intentionally thin and dependency-light (just `zod`): it is what BOTH durable workflow
 * files (`.opencode/workflows/*.ts`) and inline ad-hoc temp modules import, so it must resolve everywhere a
 * Workflow runs. The orchestration primitives themselves live in the plugin engine, not here.
 */
import { z } from "zod"

export { z }

/** Declares a Workflow: its identity plus optional UX/typing metadata. */
export interface WorkflowMeta {
  /** Unique name — the registry key and the `/workflow` dispatcher argument. */
  name: string
  /** One line; shown in the permission dialog / workflow list. */
  description: string
  /** Optional longer "when to use this" shown in the workflow list. */
  whenToUse?: string
  /** One entry per `phase()` the run will declare (titles matched exactly for grouping). */
  phases?: { title: string; detail?: string }[]
  /** Per-workflow concurrency override (default: plugin config). */
  concurrency?: number
}

/** Options for a single {@link AgentFn} call — one Unit of a Run. */
export interface AgentOpts {
  /** Registered subagent name to run this Unit as. Defaults to `"general"`. */
  subagent?: string
  /** Display label override. */
  label?: string
  /** Progress group for this Unit. */
  phase?: string
  /** Model override `{ providerID, modelID }`; omit to inherit the session model. */
  model?: { providerID: string; modelID: string }
  /**
   * Schema for structured output. NOTE: native `format`/json_schema is **not** available on the opencode
   * v1.15.x SDK route — wiring this is a later ticket. Passing it today throws.
   */
  schema?: unknown
  /** Resume / continue an existing child session instead of creating a new one. */
  reuseSessionID?: string
}

/**
 * Runs one Unit: prompts a (by default freshly-created) child session under the named subagent and resolves
 * to its final assistant text, or `null` if the Unit failed/was skipped.
 */
export type AgentFn = (prompt: string, opts?: AgentOpts) => Promise<string | null>

/** A dropped Unit, surfaced via {@link WorkflowContext.errors} (error model D9 — no silent drops). */
export interface WorkflowError {
  /** Human-facing identifier of the Unit that dropped: its `label`, else the resolved subagent name. */
  unit: string
  /** The prompt the dropped Unit was given. */
  prompt: string
  /** The subagent the dropped Unit ran (or would have run) as. */
  subagent: string
  /** The stringified failure reason. */
  error: string
}

/**
 * Run a list of Units concurrently and wait for all to settle (a **barrier**). Bounded by the workflow's
 * `meta.concurrency` (or the plugin default), so a fan-out never exceeds the limiter. Results are returned
 * **positionally aligned** to `thunks`; a Unit that fails/throws resolves to `null` in its slot (the fan-out
 * is not aborted) and is appended to {@link WorkflowContext.errors}. Pair with {@link CollectFn} to drop the
 * nulls with type-narrowing.
 */
export type ParallelFn = <T>(thunks: Array<() => Promise<T>>) => Promise<Array<T | null>>

/**
 * Drop the `null` slots from a {@link ParallelFn} result **and type-narrow** to the non-null element type
 * (so the result is `T[]`, not `(T | null)[]` — unlike `.filter(Boolean)` under strict null checks). The
 * dropped Units remain visible in {@link WorkflowContext.errors}.
 */
export type CollectFn = <T>(xs: Array<T | null>) => T[]

/**
 * The context handed to a Workflow's `run`. This slice implements `agent`, `parallel`, `collect`, `errors`,
 * `args`, `log`, `phase`; the remaining primitives (`pipeline`, `ask`, `workflow`, `budget`, `signal`,
 * `mergeWorktree`, …) arrive in later tickets and are intentionally omitted so the typed surface never
 * overstates what works.
 */
export interface WorkflowContext<A = unknown> {
  /** Run one Unit as a named subagent (default `"general"`). */
  agent: AgentFn
  /** Fan a list of Units out concurrently (bounded barrier); failures become `null` slots + `errors`. */
  parallel: ParallelFn
  /** Drop `null` slots from a result array and type-narrow to the non-null element type. */
  collect: CollectFn
  /** The Units that have dropped so far (failed/threw), in the order they were recorded. */
  errors: ReadonlyArray<WorkflowError>
  /** The validated/whole `args` value passed to the Run. */
  args: A
  /** Emit a narrator progress line. */
  log: (message: string) => void
  /** Begin a named progress phase; subsequent `agent()` calls group under it. */
  phase: (title: string) => void
}

/** A Workflow definition: declarative `meta` plus the `run` that orchestrates Units. */
export interface DefineWorkflowConfig<A = unknown> {
  meta: WorkflowMeta
  run: (ctx: WorkflowContext<A>) => Promise<unknown>
}

/**
 * Declares a Workflow. Validates `meta` and returns the config unchanged (identity), so the same shape works
 * for durable files (default-exported) and inline ad-hoc modules. No execution happens here — the engine
 * resolves the config and calls `run` with a live context.
 */
export function defineWorkflow<A = unknown>(config: DefineWorkflowConfig<A>): DefineWorkflowConfig<A> {
  if (!config || typeof config !== "object") {
    throw new TypeError("defineWorkflow: expected a { meta, run } config object")
  }
  const { meta, run } = config
  if (!meta || typeof meta !== "object") {
    throw new TypeError("defineWorkflow: `meta` is required")
  }
  if (typeof meta.name !== "string" || meta.name.trim() === "") {
    throw new TypeError("defineWorkflow: `meta.name` must be a non-empty string")
  }
  if (typeof meta.description !== "string" || meta.description.trim() === "") {
    throw new TypeError("defineWorkflow: `meta.description` must be a non-empty string")
  }
  if (typeof run !== "function") {
    throw new TypeError("defineWorkflow: `run` must be a function")
  }
  return config
}
