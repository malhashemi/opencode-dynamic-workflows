/**
 * `@malhashemi/opencode-dynamic-workflows/workflow` — the author-facing surface (the legacy `@opencode-ai/workflow` import
 * still resolves: the engine rewrites it when it loads a Workflow).
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
import { z } from "zod"

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
  /** Units in flight at once for this Workflow. Can lower the plugin's `maxConcurrentUnits` (default 5), not raise it. */
  concurrency?: number
  /**
   * Optional per-Unit prompt deadline (ms) for this Workflow's Units (a Unit's own `agent({ timeoutMs })`
   * overrides it). On expiry the Unit is cancelled and fails `null` rather than hanging the Run.
   *
   * **Omit it and Units run for as long as they take** — there is no engine default, because a Unit that
   * legitimately runs for hours is the normal case here, not the pathological one. Set this only when you want
   * a Unit to fail fast, and size it to the work rather than to your patience: a timeout is not retried.
   */
  unitTimeout?: number
  /**
   * Output-token ceiling, surfaced to `run` as `ctx.budget.total`. A number is ADVISORY: it informs author
   * decisions (loop until `ctx.budget.remaining()` is low) and over-budget Units still run. `{ tokens, hard: true }`
   * makes it a hard stop: once spent, the Run ends with a legible "budget exhausted" error.
   */
  budget?: number | { tokens: number; hard?: boolean }
  /**
   * Permission rules applied to every Unit session of this Workflow, after the subagent's own rules (last match
   * wins). Use them to allow exactly what the Units need, e.g. `{ action: "edit", resource: "src/**", effect: "allow" }`.
   */
  permissions?: PermissionRule[]
  /** Hard limits (defaults: 1000 Units per Run, 4096 items per parallel/pipeline call, 250 model steps per Unit). */
  limits?: { maxUnits?: number; maxItemsPerCall?: number; maxUnitSteps?: number }
  /**
   * Zod schema for the Run's `args`. When present, the caller's `args` are validated against it before any Unit
   * launches — invalid input fails the Run immediately, naming the offending field — and `ctx.args` is typed
   * as the schema's inferred type. Omit it for an untyped/unchecked `args` (`ctx.args` is then `unknown`).
   */
  args?: S
  /** How this Workflow's interactions are routed between a human and the engine's automation. */
  interaction?: InteractionPolicy
}

/**
 * How a Run's interactions are routed — per Workflow, overriding the engine's defaults.
 *
 * The engine's default is human-first: when a surface is attached, a nested Question is published and left for
 * a person indefinitely; with nobody attached, or once an opt-in {@link InteractionPolicy.graceMs} expires, the
 * watcher's proxy → escalate → reject ladder runs exactly as it does headlessly.
 */
export interface InteractionPolicy {
  /**
   * - `human` — publish and wait for the grace, then hand back to automation (the default).
   * - `proxy` — never wait for a person; run the automation ladder immediately, as a headless Run does.
   * - `proxy-then-human` — same as `proxy`, but a question the proxy cannot ground is offered to a human
   *   for the grace period before it is rejected.
   */
  questions?: "human" | "proxy" | "proxy-then-human"
  /**
   * What happens when a Unit's tool call hits an `ask` permission rule:
   * - `ask` (default) — with a surface attached, a person decides (TUI panel, web app); headless, it is denied
   *   with a message the Unit can act on. Never hangs a headless Run.
   * - `auto` — allowed once, silently (opt-in; prefer explicit `meta.permissions` rules).
   * - `deny` — always denied with a message.
   * `human` is accepted as a legacy alias of `ask`.
   */
  permissions?: "ask" | "auto" | "deny" | "human"
  /**
   * How long a human has before automation takes an interaction back — **opt-in, with no default**.
   *
   * Omit it and a published question waits until a person answers it, hands it to automation on purpose, or
   * the Run is stopped. That is the right default because most questions worth interrupting someone for are
   * worth waiting for: a deadline hands the decision to a machine precisely when the person it was asked of
   * stepped away, which is the situation asking existed to avoid. Set it when the answer genuinely expires —
   * a deploy window, a batch that must go out tonight.
   *
   * A Run with nobody attached never publishes at all: `ctx.ask` resolves to its declared `fallback` at once,
   * so this knob has nothing to do with headless safety.
   */
  graceMs?: number
}

/** One permission rule, OpenCode's own shape. Later rules win. */
export interface PermissionRule {
  action: string
  resource: string
  effect: "allow" | "deny" | "ask"
}

/** A plain JSON Schema object, accepted wherever a zod schema is (D7 alias). */
export type JsonSchemaInput = { type?: unknown; [key: string]: unknown }

/** One question a script asks. The same shape the host uses, so both origins render through one pane. */
export interface AskQuestion {
  /** Short display header — the pane's panel title. */
  header: string
  /** The complete question text. */
  prompt: string
  /** The closed set of answers. A reply is matched by LABEL, per the host's own contract. */
  options: { label: string; description: string }[]
  /** Whether more than one label may be chosen. Defaults to false. */
  multiple?: boolean
  /** Whether a free-text answer is accepted alongside the offered labels. Defaults to false. */
  custom?: boolean
}

export interface AskOptions {
  /**
   * The answer to use when nobody can be asked — REQUIRED, not optional.
   *
   * A background run, `opencode serve`, and a CI run all have no one attached, and a Workflow that hangs
   * waiting for an answer nobody will give is worse than one that proceeds on a stated default. Declaring it
   * also makes the headless path a decision the author made rather than one the engine invented. Shaped like a
   * reply: one entry per question, each a list of chosen labels.
   */
  fallback: string[][]
  /**
   * How long to wait for a human before falling back, for THIS question only.
   *
   * Falls back to the Run's `meta.interaction.graceMs`, and with neither declared there is no deadline: the
   * question waits for the person it was asked of. See {@link InteractionPolicy.graceMs}.
   */
  graceMs?: number
}

/**
 * Ask the human a question mid-run, and block until they answer (or the grace expires).
 *
 * The point is the questions args cannot express: `meta.args` is fixed before the Run starts, so it can offer
 * "fast or thorough?" but not *"planning found 6 areas — 12 units — fast or thorough?"*. Same two options, far
 * better decision, and only answerable once the Run has computed something.
 *
 * Answers are matched by LABEL, per the host's own reply contract — so the offered labels are a closed set,
 * which is what makes the fallback well-typed and a later replay exact. The resolved value is always one entry
 * per question, in the order they were asked.
 */
export type AskFn = (form: AskQuestion | AskQuestion[], options: AskOptions) => Promise<string[][]>

/**
 * Options for a single {@link AgentFn} call — one Unit of a Run. Generic over the optional `schema`: when a
 * zod schema is supplied, the Unit returns its inferred type instead of text (see {@link AgentFn}).
 */
export interface AgentOpts<S extends z.ZodType | JsonSchemaInput | undefined = undefined> {
  /** Registered subagent name to run this Unit as. Defaults to `"general"`. */
  subagent?: string
  /** Alias of `subagent` (Claude Code naming). */
  agentType?: string
  /** Display label override. */
  label?: string
  /** Progress group for this Unit. */
  phase?: string
  /**
   * Model override `{ providerID, modelID }`.
   *
   * Omit it and the unit runs on the **subagent's own configured model** — the engine passes `agent:` to the
   * host, which resolves the model from that agent's config, so `subagent` already decides the model. This
   * only overrides that.
   *
   * Not validated against the host's model list: a typo resolves however the host resolves an unknown id.
   */
  model?: { providerID: string; modelID: string; variant?: string } | string
  /** Reasoning-effort shorthand: sets the model variant (e.g. `"high"`) when `model` names none. */
  effort?: string
  /**
   * Zod schema for a typed result. The Unit gets a `workflow_result` tool whose input is this schema; the engine
   * validates each call (the model can correct itself in the same turn), repairs in the same session when needed,
   * and resolves the Unit to the schema's inferred type (not text).
   */
  schema?: S
  /**
   * How many repair turns (in the same Unit session) to allow when no valid result arrived. Defaults to `2`.
   * Ignored when no `schema` is supplied.
   */
  retries?: number
  /**
   * Wall-clock ceiling (ms) for THIS Unit's prompt. On expiry the child prompt is cancelled and the Unit
   * resolves to `null` (recorded in {@link WorkflowContext.errors}) — so a hung subagent never blocks the Run.
   * Overrides the Run default ({@link WorkflowMeta.unitTimeout}). Omit to inherit it.
   */
  timeoutMs?: number
  /**
   * Run this Unit in another directory — typically a git worktree created for it. The directory must be an
   * OpenCode location where this plugin is active (commit the plugin config, or install it globally).
   */
  location?: string
  /**
   * `"worktree"`: run this Unit in a fresh git worktree of the project (for Units that edit files in parallel).
   * Removed afterwards when the Unit changed nothing; otherwise kept — see `ctx.worktrees()` to merge the work.
   * The plugin must be active in the worktree (configure it in a COMMITTED opencode.json, or globally).
   */
  isolation?: "worktree"
  /** Permission rules for this Unit's session, applied after the Workflow's `meta.permissions`. */
  permissions?: PermissionRule[]
}

/**
 * Runs one Unit: prompts a (by default freshly-created) child session under the named subagent. With a
 * `schema`, it resolves to that schema's inferred type (validated structured output); without one, to the
 * Unit's final assistant text. Either way `null` on failure/skip (the drop is recorded in
 * {@link WorkflowContext.errors}).
 */
/**
 * A zod schema types the result; a JSON Schema returns `unknown` (validated at run time); none returns text.
 *
 * In a refinement loop (`draft = await agent(\`…${draft}\`)`), declare the loop variable as `string`, not
 * `string | null`: TypeScript otherwise reports circular inference for the values computed inside the loop.
 */
export type AgentFn = <S extends z.ZodType | JsonSchemaInput | undefined = undefined>(
  prompt: string,
  opts?: AgentOpts<S>,
) => Promise<(S extends z.ZodType ? z.infer<S> : S extends undefined ? string : unknown) | null>

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

/** What `ctx.$` resolves to. A non-zero `exitCode` is a value, not a throw. */
export interface ShellResult {
  stdout: string
  stderr: string
  exitCode: number
}

/**
 * Project-confined helpers, stopped with the Run and recorded in its activity. Not a sandbox: see the security
 * docs. Disabled for inline Workflows when the plugin option `inlineCapabilities` is `false`.
 */
export interface WorkflowCapabilities {
  /**
   * Run a shell command in the project (`sh -c`). As a tagged template, interpolations are shell-quoted:
   * ``await $`git log -1 ${ref}` ``. Options: `cwd` (inside the project), `timeoutMs` (default 120 s), `env`.
   */
  $: {
    (command: string, options?: { cwd?: string; timeoutMs?: number; env?: Record<string, string> }): Promise<ShellResult>
    (strings: TemplateStringsArray, ...values: unknown[]): Promise<ShellResult>
  }
  /** Files inside the project only (paths resolve through symlinks and may not leave it). */
  file: {
    read(path: string): Promise<string>
    write(path: string, content: string): Promise<void>
    exists(path: string): Promise<boolean>
    /** Entry names; directories end in `/`. */
    list(path?: string): Promise<string[]>
    stat(path: string): Promise<{ size: number; isFile: boolean; isDirectory: boolean; modified: number }>
  }
  /** `fetch`, aborted when the Run stops. */
  fetch: (input: string | URL | Request, init?: RequestInit) => Promise<Response>
}

/** The context handed to a Workflow's `run`. */
export interface WorkflowContext<A = unknown> extends WorkflowCapabilities {
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
   * Ask the human a question mid-run, with a REQUIRED headless fallback.
   *
   * Blocks until someone answers, the grace period expires, or the Run aborts — whichever comes first. With no
   * surface attached it resolves to `options.fallback` immediately rather than stalling a headless Run.
   */
  ask: AskFn
  /**
   * Token budget: `total` is the ceiling (or null), `spent()` the running output-token sum, `remaining()` is
   * `max(0, total - spent())` (or Infinity when uncapped). Advisory unless `meta.budget` is `{ tokens, hard: true }`.
   */
  budget: { total: number | null; spent(): number; remaining(): number }
  /**
   * Run a SAVED Workflow (by key) as one step of this Run and get its result. It shares this Run's concurrency cap,
   * budget, errors and stop signal; its Units and phases show as `name › …`. Its args are validated against its
   * `meta.args` (an invalid call throws). One level only: calling `workflow` inside it throws.
   */
  workflow: (name: string, args?: unknown) => Promise<unknown>
  /** Worktrees kept by `isolation: "worktree"` Units that changed something, in the order they finished. */
  worktrees: () => ReadonlyArray<{ unit: string; directory: string; branch: string | null }>
  /** The Run's abort signal (D11). Aborting stops launching queued Units AND interrupts in-flight Unit sessions; each dropped Unit is recorded in {@link errors}. */
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
