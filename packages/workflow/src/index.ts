/**
 * `@opencode-ai/workflow` — the author-facing surface.
 *
 * A Workflow is a TypeScript module that exports `defineWorkflow({ meta, run })`. Authors import
 * `defineWorkflow` and `z` from here; the plugin engine injects a live {@link WorkflowContext} at run time.
 *
 * This package is intentionally thin and dependency-light (just `zod`): it is what BOTH durable workflow
 * files (`.opencode/workflows/*.ts`) and inline ad-hoc temp modules import, so it must resolve everywhere a
 * Workflow runs. The orchestration primitives themselves live in the plugin engine, not here.
 *
 * We re-export the **zod 4** API (`zod/v4`, shipped inside the same `zod` dependency) rather than the legacy
 * v3 default, because v4 carries a built-in `z.toJSONSchema` — the engine's Schema-bridge needs it to turn an
 * author's `schema` into the native `format:{json_schema}` request, with no extra dependency.
 */
import { z } from "zod/v4"

export { z }

/**
 * Declares a Workflow: its identity plus optional UX/typing metadata. Generic over the optional `args` zod
 * schema `S`: when supplied, the Run's `args` are validated against it before any Unit launches and `ctx.args`
 * is typed as `z.infer<S>` (see {@link DefineWorkflowConfig}).
 */
export interface WorkflowMeta<S extends z.ZodType = z.ZodType> {
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
  /**
   * Default per-Unit prompt timeout (ms) for this Workflow's Units (a Unit's own `agent({ timeoutMs })`
   * overrides it). On expiry the Unit fails `null` instead of hanging the Run. Omit to inherit the engine
   * default. Raise it for legitimately long Units, or set a small value to fail fast.
   */
  unitTimeout?: number
  /**
   * Advisory output-token ceiling, surfaced to `run` as `ctx.budget.total`. There is NO engine hard-stop — it
   * informs author decisions (e.g. loop until `ctx.budget.remaining()` is low); over-budget Units still run.
   */
  budget?: number
  /**
   * Zod schema for the Run's `args`. When present, the caller's `args` are validated against it before any Unit
   * launches — invalid input fails the Run immediately, naming the offending field — and `ctx.args` is typed
   * as the schema's inferred type. Omit it for an untyped/unchecked `args` (`ctx.args` is then `unknown`).
   */
  args?: S
}

/**
 * Options for a single {@link AgentFn} call — one Unit of a Run. Generic over the optional `schema`: when a
 * zod schema is supplied, the Unit returns its inferred type instead of text (see {@link AgentFn}).
 */
export interface AgentOpts<S extends z.ZodType | undefined = undefined> {
  /** Registered subagent name to run this Unit as. Defaults to `"general"`. */
  subagent?: string
  /** Display label override. */
  label?: string
  /** Progress group for this Unit. */
  phase?: string
  /** Model override `{ providerID, modelID }`; omit to inherit the session model. */
  model?: { providerID: string; modelID: string }
  /**
   * Zod schema for structured output. The engine converts it to a native `format:{type:"json_schema"}`
   * request; opencode forces its validated `StructuredOutput` tool and the engine parses the result back
   * through this schema, so the Unit resolves to the schema's inferred type (not text).
   */
  schema?: S
  /**
   * How many extra attempts to make when structured output fails (a `StructuredOutputError`, or a payload
   * that fails this zod schema). Core itself does not retry; the engine does. Defaults to `2`. Ignored when
   * no `schema` is supplied.
   */
  retries?: number
  /**
   * Wall-clock ceiling (ms) for THIS Unit's prompt. On expiry the child prompt is cancelled and the Unit
   * resolves to `null` (recorded in {@link WorkflowContext.errors}) — so a hung subagent never blocks the Run.
   * Overrides the Run default ({@link WorkflowMeta.unitTimeout}). Omit to inherit it.
   */
  timeoutMs?: number
  /** Resume / continue an existing child session instead of creating a new one. */
  reuseSessionID?: string
}

/**
 * Runs one Unit: prompts a (by default freshly-created) child session under the named subagent. With a
 * `schema`, it resolves to that schema's inferred type (validated structured output); without one, to the
 * Unit's final assistant text. Either way `null` on failure/skip (the drop is recorded in
 * {@link WorkflowContext.errors}).
 */
export type AgentFn = <S extends z.ZodType | undefined = undefined>(
  prompt: string,
  opts?: AgentOpts<S>,
) => Promise<(S extends z.ZodType ? z.infer<S> : string) | null>

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
 * One {@link PipelineFn} stage. Receives the running value (`prev` — the previous stage's result, or the
 * original item for stage 1), the original `item`, and its `index`. Returns the next running value (sync or
 * async). A stage that **throws** collapses that item to `null` and skips its remaining stages (D9); other
 * items keep flowing. (A Unit that *fails* via `agent()` returns `null` without throwing, so it flows on as
 * `null` rather than dropping the item.)
 */
export type PipelineStage<P, R, I> = (prev: P, item: I, index: number) => R | Promise<R>

/**
 * Run each item down a chain of stages **independently — no barrier between items** (the default for staged
 * work): item A can be in stage 3 while item B is still in stage 1. The overloads thread each stage's resolved
 * return type into the next stage's `prev`, so a typed chain stays typed end-to-end; the result is
 * `Array<lastStageResult | null>` (the `| null` is the per-item drop). Past four stages it falls back to the
 * variadic form (results typed loosely). Bounding is uniform with everything else: a stage's Units go through
 * {@link AgentFn}, which draws from the one shared limiter.
 */
export interface PipelineFn {
  <I, A>(items: I[], s1: PipelineStage<I, A, I>): Promise<Array<Awaited<A> | null>>
  <I, A, B>(
    items: I[],
    s1: PipelineStage<I, A, I>,
    s2: PipelineStage<Awaited<A>, B, I>,
  ): Promise<Array<Awaited<B> | null>>
  <I, A, B, C>(
    items: I[],
    s1: PipelineStage<I, A, I>,
    s2: PipelineStage<Awaited<A>, B, I>,
    s3: PipelineStage<Awaited<B>, C, I>,
  ): Promise<Array<Awaited<C> | null>>
  <I, A, B, C, D>(
    items: I[],
    s1: PipelineStage<I, A, I>,
    s2: PipelineStage<Awaited<A>, B, I>,
    s3: PipelineStage<Awaited<B>, C, I>,
    s4: PipelineStage<Awaited<C>, D, I>,
  ): Promise<Array<Awaited<D> | null>>
  <I>(items: I[], ...stages: Array<PipelineStage<any, any, I>>): Promise<Array<unknown>>
}

/**
 * The context handed to a Workflow's `run`. This slice implements `agent`, `parallel`, `pipeline`, `collect`,
 * `errors`, `args`, `log`, `phase`, `budget`, `signal`; the remaining primitives (`ask`, `workflow`,
 * `mergeWorktree`, …) arrive in later tickets and are intentionally omitted so the typed surface never
 * overstates what works.
 */
export interface WorkflowContext<A = unknown> {
  /** Run one Unit as a named subagent (default `"general"`). */
  agent: AgentFn
  /** Fan a list of Units out concurrently (bounded barrier); failures become `null` slots + `errors`. */
  parallel: ParallelFn
  /** Run each item down a stage chain independently — NO barrier between items (the default for staged work). */
  pipeline: PipelineFn
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
  /**
   * Advisory token budget (D10): `total` is the caller's ceiling (or null), `spent()` the running output-token
   * sum, `remaining()` is `max(0, total - spent())` (or Infinity when uncapped). No engine hard-stop.
   */
  budget: { total: number | null; spent(): number; remaining(): number }
  /** The Run's abort signal (D11). Aborting stops launching queued Units AND cancels in-flight Units (their child prompt is `session.abort`-ed); each dropped Unit is recorded in {@link errors}. */
  signal: AbortSignal
}

/**
 * A Workflow definition: declarative `meta` plus the `run` that orchestrates Units. Generic over the `meta.args`
 * schema `S` so `run`'s `ctx.args` is typed as `z.infer<S>` (or `unknown` when no schema is declared).
 */
export interface DefineWorkflowConfig<S extends z.ZodType = z.ZodType> {
  meta: WorkflowMeta<S>
  run: (ctx: WorkflowContext<z.infer<S>>) => Promise<unknown>
}

/**
 * Declares a Workflow. Validates `meta` and returns the config unchanged (identity), so the same shape works
 * for durable files (default-exported) and inline ad-hoc modules. No execution happens here — the engine
 * resolves the config and calls `run` with a live context. The `meta.args` schema (if any) drives both the
 * compile-time type of `ctx.args` and the engine's runtime validation of the caller's input.
 */
export function defineWorkflow<S extends z.ZodType = z.ZodType>(config: DefineWorkflowConfig<S>): DefineWorkflowConfig<S> {
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
  // `:` joins the registry-key namespace and `/`/whitespace are reserved by the slash-command mapping, so a
  // name containing them would make the key non-injective or silently collide on a command — reject at the
  // single chokepoint (both durable + ad-hoc workflows pass through here).
  if (/[:/\\\s]/.test(meta.name)) {
    throw new TypeError(
      `defineWorkflow: \`meta.name\` must not contain ':', '/', '\\\\', or whitespace (got ${JSON.stringify(meta.name)})`,
    )
  }
  if (typeof meta.description !== "string" || meta.description.trim() === "") {
    throw new TypeError("defineWorkflow: `meta.description` must be a non-empty string")
  }
  if (typeof run !== "function") {
    throw new TypeError("defineWorkflow: `run` must be a function")
  }
  return config
}
