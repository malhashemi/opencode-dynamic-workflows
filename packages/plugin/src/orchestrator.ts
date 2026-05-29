/**
 * The orchestrator — turns inline Workflow source into a Run.
 *
 * Ad-hoc Workflows run via **write-temp-`.ts` + dynamic `import()`** — never `eval` (ADR-0001). The temp
 * module must live inside THIS package's tree so its `import { defineWorkflow } from "@opencode-ai/workflow"`
 * resolves via our workspace `node_modules`, independent of the host project (verified gotcha). Bun caches
 * imports by URL, so each Run gets a unique filename.
 */
import { mkdir, rm, writeFile } from "node:fs/promises"
import path from "node:path"
import { pathToFileURL } from "node:url"
import type { DefineWorkflowConfig } from "@opencode-ai/workflow"
import type { WorkflowClient } from "./client"
import { createEngineState, createWorkflowContext, type EngineEvents, type EngineState } from "./context"

/** Temp modules live beside the engine so `@opencode-ai/workflow` resolves from our node_modules. */
const DEFAULT_TMP_DIR = path.join(import.meta.dir, "..", ".wf-tmp")

export interface RunWorkflowInput {
  /** Inline Workflow source: a TS module that `export default defineWorkflow({ meta, run })`. */
  source: string
  args?: unknown
  client: WorkflowClient
  parentSessionID: string
  tmpDir?: string
  events?: EngineEvents
  /** Unique id for the temp module filename (avoids Bun's import-by-URL cache colliding across Runs). */
  runId?: string
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
 * Load inline `source` as a Workflow module, build a live context, run it, and return the result plus the
 * captured engine state. The temp file is always cleaned up.
 */
export async function runWorkflow(input: RunWorkflowInput): Promise<RunWorkflowOutput> {
  const tmpDir = input.tmpDir ?? DEFAULT_TMP_DIR
  const runId = input.runId ?? crypto.randomUUID()
  await mkdir(tmpDir, { recursive: true })
  const file = path.join(tmpDir, `wf-${runId}.ts`)
  await writeFile(file, input.source, "utf8")

  try {
    const mod = (await import(pathToFileURL(file).href)) as Record<string, unknown>
    const config = mod.default ?? mod.workflow
    if (!isWorkflowConfig(config)) {
      throw new Error("workflow source must `export default defineWorkflow({ meta, run })`")
    }

    const state = createEngineState()
    const ctx = createWorkflowContext({
      client: input.client,
      parentSessionID: input.parentSessionID,
      args: input.args,
      state,
      events: input.events,
    })

    const result = await config.run(ctx)
    return { result, meta: config.meta, state }
  } finally {
    await rm(file, { force: true })
  }
}
