/**
 * The Workflow loader — turns Workflow source into a live `defineWorkflow` config, without `eval`.
 *
 * Proven in P0 spike S6 against an installed (non-workspace) package inside the host's embedded Bun:
 *
 * - A Workflow's `import … from "<authoring package>"` cannot rely on the user's project: the authoring module
 *   ships inside this plugin. Every known authoring specifier is rewritten to this plugin's own resolved module,
 *   so the Workflow and the engine share ONE module instance (and one zod).
 * - Each module is written to a fresh directory named by its content hash. The host's resolver caches directory
 *   listings, so a new file in an already-read directory is not found; a new directory always is. The same bytes
 *   map to the same directory, so re-running an unchanged Workflow reuses its module.
 * - A durable Workflow that imports its own relative files is bundled with `Bun.build` from its real path, with
 *   the authoring specifiers redirected (and kept external) — its relative imports keep working.
 * - Runtime `Bun.plugin` resolvers do not work in the host; they are not used.
 *
 * Inline source is model-authored code. Loading it runs it with the service's full privileges; the gate in
 * front of this (`workflow_inline` approval) is where that risk is managed, not here.
 */
import { createHash } from "node:crypto"
import { existsSync } from "node:fs"
import { mkdir, rename, rm, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { pathToFileURL } from "node:url"

import type { DefineWorkflowConfig } from "./workflow"

/** The import specifier that means "the authoring API". */
export const AUTHORING_SPECIFIERS = ["@malhashemi/opencode-dynamic-workflows/workflow"] as const

/** This plugin's own authoring module, wherever the host installed the package. */
export const AUTHORING_PATH = path.join(import.meta.dir, "workflow", "index.ts")

/** Bump when the loader's output for the same bytes would differ. */
const LOADER_VERSION = "2"

export function defaultCacheDir(): string {
  const xdg = process.env.XDG_CACHE_HOME
  const base = xdg && xdg.length > 0 ? xdg : path.join(os.homedir(), ".cache")
  return path.join(base, "opencode-dynamic-workflows", "workflows")
}

const SPECIFIER_PATTERN = new RegExp(
  `(from\\s*|import\\s*\\(\\s*|import\\s+)(["'])(${AUTHORING_SPECIFIERS.map((s) => s.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&")).join("|")})\\2`,
  "g",
)

/** Point every authoring import at this plugin's module. Other imports are untouched. */
export function rewriteAuthoringImports(source: string, target = AUTHORING_PATH): string {
  // Forward slashes: a Windows path's backslashes would be read as escapes inside the string literal.
  const specifier = target.replaceAll("\\", "/")
  return source.replace(
    SPECIFIER_PATTERN,
    (_match, lead: string, quote: string) => `${lead}${quote}${specifier}${quote}`,
  )
}

export function hasRelativeImports(source: string): boolean {
  return /(?:from\s*|import\s*\(\s*|import\s+)["']\.\.?\//.test(source)
}

export function isWorkflowConfig(value: unknown): value is DefineWorkflowConfig {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as DefineWorkflowConfig).run === "function" &&
    typeof (value as DefineWorkflowConfig).meta === "object"
  )
}

export interface LoadOptions {
  cacheDir?: string
  /** The Workflow's real file, for durable Workflows (enables relative imports). */
  sourcePath?: string
}

export interface LoadedWorkflow {
  config: DefineWorkflowConfig
  /** The module file actually imported. */
  file: string
  sha256: string
}

export function sha256(text: string): string {
  return createHash("sha256").update(text).digest("hex")
}

async function writeOnce(file: string, contents: string): Promise<void> {
  if (existsSync(file)) return
  const temp = `${file}.${crypto.randomUUID()}.tmp`
  await writeFile(temp, contents, "utf8")
  try {
    await rename(temp, file)
  } catch (error) {
    await rm(temp, { force: true }).catch(() => {})
    if (!existsSync(file)) throw error
  }
}

async function bundle(sourcePath: string, outFile: string): Promise<void> {
  const build = await Bun.build({
    entrypoints: [sourcePath],
    target: "bun",
    format: "esm",
    plugins: [
      {
        name: "workflow-authoring",
        setup(builder) {
          const filter = new RegExp(
            `^(${AUTHORING_SPECIFIERS.map((s) => s.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&")).join("|")})$`,
          )
          builder.onResolve({ filter }, () => ({ path: AUTHORING_PATH, external: true }))
        },
      },
    ],
  })
  if (!build.success) throw new Error(build.logs.map(String).join("\n") || "bundling the Workflow failed")
  const output = build.outputs[0]
  if (!output) throw new Error("bundling the Workflow produced no output")
  // `external` keeps the original specifier in the output; point it at this plugin's module like inline source.
  await writeOnce(outFile, rewriteAuthoringImports(await output.text()))
}

/**
 * Materialize and import a Workflow module. Throws with a legible message when the source does not
 * `export default defineWorkflow({ meta, run })`.
 */
export async function loadWorkflow(source: string, options: LoadOptions = {}): Promise<LoadedWorkflow> {
  const cacheDir = options.cacheDir ?? defaultCacheDir()
  const useBundle = options.sourcePath !== undefined && hasRelativeImports(source)
  const digest = sha256(`${LOADER_VERSION}\0${AUTHORING_PATH}\0${useBundle ? options.sourcePath : ""}\0${source}`)
  const directory = path.join(cacheDir, digest.slice(0, 32))
  await mkdir(directory, { recursive: true })
  const file = path.join(directory, useBundle ? "workflow.js" : "workflow.ts")
  if (useBundle) await bundle(options.sourcePath!, file)
  else await writeOnce(file, rewriteAuthoringImports(source))

  const mod = (await import(pathToFileURL(file).href)) as Record<string, unknown>
  const config = mod.default ?? mod.workflow
  if (!isWorkflowConfig(config)) throw new Error("workflow source must `export default defineWorkflow({ meta, run })`")
  return { config, file, sha256: sha256(source) }
}

/** Load a Workflow's config without running it (discovery, validation before a save). */
export async function loadWorkflowConfig(source: string, options: LoadOptions = {}): Promise<DefineWorkflowConfig> {
  return (await loadWorkflow(source, options)).config
}
