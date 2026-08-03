/**
 * The orchestrator — turns inline Workflow source into a Run.
 *
 * Ad-hoc Workflows run via **write-temp-`.ts` + dynamic `import()`** — never `eval` (ADR-0001). The temp
 * module must live inside THIS package's tree so its `import { defineWorkflow } from "@opencode-ai/workflow"`
 * resolves via our workspace `node_modules`, independent of the host project (verified gotcha). Bun caches
 * imports by URL, so each Run gets a unique filename.
 */
import { mkdir, readFile, rm, writeFile } from "node:fs/promises"
import path from "node:path"
import { pathToFileURL } from "node:url"
import type { DefineWorkflowConfig } from "@opencode-ai/workflow"
import type { WorkflowClient } from "./client"
import { createEngineState, createWorkflowContext, runOwnedRoots, type EngineEvents, type EngineState } from "./context"
import type { ControlRegistry } from "./control"
import { createRunStore, type RunSnapshot, type RunStore } from "./runs"
import { DEFAULT_MAX_ESCALATION_HOPS, startWatcher, type Watcher } from "./watcher"

/** Temp modules live beside the engine so `@opencode-ai/workflow` resolves from our node_modules. */
const DEFAULT_TMP_DIR = path.join(import.meta.dir, "..", ".wf-tmp")

/**
 * Default per-Unit prompt timeout (ms). Generous (a Unit may legitimately run minutes) but finite, so a hung
 * subagent prompt — e.g. an unanswered permission ask in a headless child — fails the Unit instead of blocking
 * the whole Run forever. Overridable per-Workflow (`meta.unitTimeout`), per-Run (`input.unitTimeout`), or
 * per-Unit (`agent({ timeoutMs })`). The Run's abort signal also cancels in-flight Units regardless of this.
 */
const DEFAULT_UNIT_TIMEOUT_MS = 300_000

export interface RunWorkflowInput {
  /** Inline Workflow source: a TS module that `export default defineWorkflow({ meta, run })`. */
  source: string
  args?: unknown
  client: WorkflowClient
  parentSessionID: string
  tmpDir?: string
  events?: EngineEvents
  /** Advisory output-token ceiling override; falls back to `meta.budget`, then null (uncapped). */
  budget?: number
  /** The Run's abort signal (the adapter forwards opencode's tool-abort signal). */
  signal?: AbortSignal
  /** Default per-Unit prompt timeout (ms); falls back to `meta.unitTimeout`, then {@link DEFAULT_UNIT_TIMEOUT_MS}. */
  unitTimeout?: number
  /**
   * Whether a human is reachable to answer an escalated depth-1 nested Question. Defaults false
   * (headless-safe) per DR-005: when false, an unanswerable nested question is proxy-answered or rejected
   * without a human-escalation dispatch.
   */
  humanReachable?: boolean
  /** Unique id for the temp module filename (avoids Bun's import-by-URL cache colliding across Runs). */
  runId?: string
  /** Whether the source came from a durable registry entry or an inline tool argument. */
  provenance?: RunSnapshot["provenance"]
  /** Live run store shared by the plugin endpoint and progress mirrors. */
  store?: RunStore
  /**
   * Lets an out-of-band surface stop this run or one of its units.
   *
   * Without it the tool's own abort signal IS the run signal, so nothing outside the invoking session can stop
   * anything. Supplying a registry gives the run a controller of its own, linked to `input.signal` rather than
   * replaced by it: the tool's abort still stops the run, and now so does a keypress in the run browser.
   */
  control?: ControlRegistry
}

export interface RunWorkflowOutput {
  result: unknown
  meta: DefineWorkflowConfig["meta"]
  state: EngineState
}

function isWorkflowConfig(value: unknown): value is DefineWorkflowConfig {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as DefineWorkflowConfig).run === "function" &&
    typeof (value as DefineWorkflowConfig).meta === "object"
  )
}

/**
 * Materialize Workflow `source` as a unique temp `.ts` and `import()` it, returning the validated config plus
 * the temp file path (the caller owns cleanup). The unique `wf-${runId}.ts` filename is the cache-bust: Bun
 * keys its import cache by resolved real path, so a stable path would return the STALE module after an edit —
 * a fresh filename always loads fresh bytes (verified; see discovery-dispatcher-surface research). This is why
 * a durable file edited mid-session is picked up: {@link runWorkflowFromFile} re-reads its bytes each call and
 * routes them through here under a new filename.
 */
async function materialize(source: string, tmpDir: string, runId: string): Promise<{ config: DefineWorkflowConfig; file: string }> {
  await mkdir(tmpDir, { recursive: true })
  const file = path.join(tmpDir, `wf-${runId}.ts`)
  await writeFile(file, source, "utf8")
  try {
    const mod = (await import(pathToFileURL(file).href)) as Record<string, unknown>
    const config = mod.default ?? mod.workflow
    if (!isWorkflowConfig(config)) {
      throw new Error("workflow source must `export default defineWorkflow({ meta, run })`")
    }
    return { config, file }
  } catch (err) {
    // Don't leak the temp file if the import itself threw (syntax error, bad export) — the caller's `finally`
    // never runs because we never returned the path.
    await rm(file, { force: true })
    throw err
  }
}

/**
 * Load a Workflow module's config from `source` WITHOUT running it — used by the registry to read `meta`
 * (name/description/args schema) for discovery + listing. The module is fully imported into memory before the
 * temp file is removed, so the returned config (incl. its live `run` + zod `meta.args`) stays valid.
 */
export async function loadWorkflowConfig(source: string, opts: { tmpDir?: string; runId?: string } = {}): Promise<DefineWorkflowConfig> {
  const tmpDir = opts.tmpDir ?? DEFAULT_TMP_DIR
  const runId = opts.runId ?? crypto.randomUUID()
  const { config, file } = await materialize(source, tmpDir, runId)
  await rm(file, { force: true })
  return config
}

/**
 * Load `source` as a Workflow module, build a live context, run it, and return the result plus the captured
 * engine state. The temp file is always cleaned up.
 */
export async function runWorkflow(input: RunWorkflowInput): Promise<RunWorkflowOutput> {
  const tmpDir = input.tmpDir ?? DEFAULT_TMP_DIR
  const runId = input.runId ?? crypto.randomUUID()
  const provenance = input.provenance ?? "inline"
  const store = input.store ?? createRunStore()
  const { config, file } = await materialize(input.source, tmpDir, runId)
  let watcher: Watcher | null = null
  let state: EngineState | null = null
  let startedAt: number | null = null
  let registered = false
  // The run's OWN controller, composed with (not replaced by) the caller's signal. Both can abort this run:
  // the tool that started it, and any surface holding the control registry. `AbortSignal.any` keeps the
  // linkage garbage-collectable, so a long-lived tool signal never accumulates listeners across runs.
  const stopController = new AbortController()
  const signal = input.signal ? AbortSignal.any([input.signal, stopController.signal]) : stopController.signal
  let terminalStatus: Exclude<RunSnapshot["status"], "running"> = signal.aborted ? "aborted" : "failed"
  let unregisterRun: (() => void) | null = null
  /** Live per-unit cancel-handle disposers, so a settled unit stops being addressable. */
  const unitHandles = new Map<string, () => void>()

  const finishRun = (status: Exclude<RunSnapshot["status"], "running">) => {
    if (!registered || !state || startedAt === null) return
    const current = store.get(runId)
    if (!current || current.status !== "running") return
    store.apply({
      type: "run.ended",
      run: {
        ...current,
        status,
        currentPhase: state.currentPhase,
        logs: [...state.logs],
        errors: state.errors.map((error) => ({ ...error })),
        tokensSpent: state.tokensSpent,
        endedAt: Date.now(),
      },
    })
  }

  try {
    // D7: validate the caller's args against the declared `meta.args` schema BEFORE building the context or
    // launching any Unit. Invalid input fails the Run immediately, naming the offending field(s) — never a
    // half-run. With no schema, args pass through untouched (typed `unknown` to the author).
    let args = input.args
    const argsSchema = config.meta.args
    if (argsSchema) {
      const parsed = argsSchema.safeParse(input.args)
      if (!parsed.success) {
        const detail = parsed.error.issues
          .map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`)
          .join("; ")
        throw new Error(`invalid args: ${detail}`)
      }
      args = parsed.data
    }

    state = createEngineState()
    startedAt = Date.now()
    store.create({
      runId,
      workflow: config.meta.name,
      provenance,
      parentSessionID: input.parentSessionID,
      status: "running",
      phases: (config.meta.phases ?? []).map((phase) => phase.title),
      currentPhase: null,
      units: [],
      logs: [],
      errors: [],
      tokensSpent: 0,
      startedAt,
      endedAt: null,
    })
    registered = true
    // Registered only once the run EXISTS in the store: a surface can never address a run it cannot see, so
    // `stop.run` for an unregistered id is honestly `unknown-run` rather than a silent no-op.
    unregisterRun = input.control?.registerRun(runId, stopController) ?? null
    watcher = startWatcher({
      client: input.client,
      parentSessionID: input.parentSessionID,
      runOwnedRoots: () => runOwnedRoots(state!, input.parentSessionID),
      signal,
      resolutionPolicy: {
        kind: "tiered",
        standInSubagent: "explore",
        maxEscalationHops: DEFAULT_MAX_ESCALATION_HOPS,
        humanReachable: input.humanReachable ?? false,
      },
    })
    const events: EngineEvents = {
      onLog: (message) => {
        store.apply({ type: "run.log", runId, value: message })
        input.events?.onLog?.(message)
      },
      onPhase: (title) => {
        store.apply({ type: "run.phase", runId, value: title })
        input.events?.onPhase?.(title)
      },
      onUnitQueued: (unit) => {
        store.apply({ type: "unit.queued", runId, unit })
        input.events?.onUnitQueued?.({ ...unit })
      },
      onUnitStart: (unit) => {
        store.apply({ type: "unit.started", runId, unit })
        input.events?.onUnitStart?.({ ...unit })
      },
      onUnitSettled: (unit) => {
        // Drop the cancel handle FIRST: once a unit is settled, `stop.unit` must report `unknown-unit` rather
        // than abort a child session the engine has already moved past.
        unitHandles.get(unit.unitId)?.()
        unitHandles.delete(unit.unitId)
        store.apply({ type: "unit.settled", runId, unit })
        input.events?.onUnitSettled?.({ ...unit })
      },
      // Wired only when someone can actually use a handle. The runner builds a per-attempt AbortController the
      // moment this exists, so leaving it undefined keeps a plain `runWorkflow()` on its original prompt path.
      ...(input.control || input.events?.onUnitCancelable
        ? {
            onUnitCancelable: (unitId: string, cancel: () => void) => {
              // A retry attempt supersedes its predecessor's handle — the previous child is already abandoned.
              unitHandles.get(unitId)?.()
              const dispose = input.control?.registerUnit(runId, unitId, cancel)
              if (dispose) unitHandles.set(unitId, dispose)
              input.events?.onUnitCancelable?.(unitId, cancel)
            },
          }
        : {}),
    }
    const ctx = createWorkflowContext({
      client: input.client,
      parentSessionID: input.parentSessionID,
      args,
      state,
      events,
      concurrency: config.meta.concurrency,
      budget: input.budget ?? config.meta.budget ?? null,
      signal,
      unitTimeout: input.unitTimeout ?? config.meta.unitTimeout ?? DEFAULT_UNIT_TIMEOUT_MS,
    })

    const result = await config.run(ctx)
    terminalStatus = signal.aborted ? "aborted" : "done"
    return { result, meta: config.meta, state }
  } catch (error) {
    const aborted = signal.aborted || (error instanceof Error && error.name === "AbortError")
    terminalStatus = aborted ? "aborted" : "failed"
    throw error
  } finally {
    finishRun(terminalStatus)
    watcher?.stop()
    // Unregister before the temp file goes: a terminal run must stop being addressable immediately, or a
    // surface still holding a stale row would get `ok: true` for a stop that can no longer do anything.
    for (const dispose of unitHandles.values()) dispose()
    unitHandles.clear()
    unregisterRun?.()
    await rm(file, { force: true })
  }
}

/**
 * Run a DURABLE Workflow from a file path: read its current bytes and route them through {@link runWorkflow}.
 * Reading fresh each call (rather than `import()`-ing the path directly) is what makes an in-session edit take
 * effect — the bytes go to a fresh temp filename, sidestepping Bun's path-keyed import cache.
 */
export async function runWorkflowFromFile(
  absPath: string,
  input: Omit<RunWorkflowInput, "source">,
): Promise<RunWorkflowOutput> {
  const source = await readFile(absPath, "utf8")
  return runWorkflow({ ...input, source })
}
