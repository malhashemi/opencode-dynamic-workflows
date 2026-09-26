/**
 * The Workflow registry — discovers durable Workflow files across opencode's config-dir scopes and keys each
 * by `[...namespace folders, meta.name].join(":")`.
 *
 * Scope resolution mirrors opencode's `ConfigPaths.directories(directory, worktree)` (config/paths.ts:23-41):
 * the global config dir, then every existing project `.opencode` walked UP from `directory` to `worktree`,
 * then `~/.opencode`, then `$OPENCODE_CONFIG_DIR`. Within each scope we recursively glob `.ts` files under a
 * `workflow/` or `workflows/` root (see WORKFLOW_GLOB) — dot-dirs included, symlinks followed — the recursive
 * analog of opencode's custom-tool discovery (`tool/registry.ts:199-213`). A subfolder becomes a `:`-joined
 * namespace, so a file at `workflows/deep-research/x.ts` (meta.name `dr`) keys as `deep-research:dr`.
 *
 * Collision precedence mirrors opencode's own `mergeDeep` over that directory list (config/config.ts:620-663):
 * LATER scopes override earlier ones, so a project workflow shadows a same-keyed global one. Shadowed entries
 * and load failures are SURFACED (collisions/failures), never silently dropped. See the verified research
 * notes discovery-dispatcher-surface + workflow-permission-listing.
 */
import { existsSync } from "node:fs"
import { readFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { loadWorkflowConfig } from "./loader"
import { stringifyError } from "./runner"
import type { DefineWorkflowConfig, WorkflowMeta } from "./workflow"

/** Recursive glob for durable Workflow modules under either a `workflow/` or `workflows/` root in a scope. */
const WORKFLOW_GLOB = "{workflow,workflows}/**/*.ts"

/** opencode's notion of home: the `OPENCODE_TEST_HOME` override else the OS home (core/global.ts:18-20). */
function homeDir(): string {
  return process.env.OPENCODE_TEST_HOME ?? os.homedir()
}

/** The global opencode config dir — `$XDG_CONFIG_HOME/opencode` else `~/.config/opencode` (xdg-basedir). */
export function globalConfigDir(): string {
  const xdg = process.env.XDG_CONFIG_HOME
  const base = xdg && xdg.length > 0 ? xdg : path.join(homeDir(), ".config")
  return path.join(base, "opencode")
}

/**
 * Walk UP from `start` to `stop` (inclusive), collecting existing `join(current, target)` paths — mirrors
 * `AppFileSystem.up` (core/filesystem.ts:141-155). Returns deepest-first (start before its parents).
 */
function upExisting(target: string, start: string, stop?: string): string[] {
  const out: string[] = []
  let current = path.resolve(start)
  const stopAt = stop === undefined ? undefined : path.resolve(stop)
  while (true) {
    const search = path.join(current, target)
    if (existsSync(search)) out.push(search)
    if (stopAt === current) break
    const parent = path.dirname(current)
    if (parent === current) break
    current = parent
  }
  return out
}

/** Truthy env flag, matching opencode's `Flag` semantics (`flag.ts`): only "true"/"1" enable. */
function envFlag(key: string): boolean {
  const v = process.env[key]?.toLowerCase()
  return v === "true" || v === "1"
}

/** Dedupe preserving first occurrence (like remeda `unique`, which `ConfigPaths.directories` uses). */
function unique(xs: string[]): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const x of xs) {
    if (seen.has(x)) continue
    seen.add(x)
    out.push(x)
  }
  return out
}

/**
 * The ordered config-dir scopes to scan, mirroring OpenCode V2 discovery: the global config dir first (lowest
 * precedence), then every existing `.opencode` from the filesystem root DOWN to `directory` (so the nearest one
 * is scanned last and wins a key collision), then `$OPENCODE_CONFIG_DIR`. `worktree` is accepted for callers
 * that pass it but no longer stops the walk: V2 searches every ancestor (opencode.ai/v2/docs/config).
 */
export function configDirs(directory: string, _worktree?: string): string[] {
  const dirs: string[] = [globalConfigDir()]
  if (!envFlag("OPENCODE_DISABLE_PROJECT_CONFIG")) dirs.push(...upExisting(".opencode", directory).toReversed())
  const envDir = process.env.OPENCODE_CONFIG_DIR
  if (envDir && envDir.length > 0) dirs.push(envDir)
  return unique(dirs)
}

/**
 * Namespace segments for a workflow file matched relative to a scope dir: drop the `{workflow,workflows}` root
 * and the filename, keeping the intermediate folders. e.g. `workflows/a/b/foo.ts` → `["a", "b"]`;
 * `workflow/foo.ts` → `[]`.
 */
export function namespaceSegments(relMatch: string): string[] {
  const segs = relMatch.split(/[/\\]+/).filter((s) => s.length > 0)
  return segs.slice(1, -1)
}

/** The registry key: subfolder namespaces joined to `meta.name` with `:`. Top-level files key by name alone. */
export function workflowKey(relMatch: string, metaName: string): string {
  return [...namespaceSegments(relMatch), metaName].join(":")
}

/** A discovered workflow file before its meta is loaded. */
export interface DiscoveredFile {
  absPath: string
  /** Path relative to the scope dir, e.g. `workflows/deep-research/foo.ts` — drives the namespace key. */
  relMatch: string
}

/**
 * The one reserved namespace under a workflows directory: the run journal.
 *
 * `runs/<runId>/script.ts` is a RECORD of a workflow, not a workflow to run. Without this exclusion every
 * journaled run would register itself as `runs:<runId>:<meta.name>` — so a project would accumulate one bogus
 * registry entry per run, `list` would drown, and startup discovery would import every script ever executed.
 * The journal's location is fixed by design (a run's record belongs beside the workflows that produced it), so
 * the reservation is the cost of that decision, stated here rather than left implicit.
 */
const JOURNAL_SEGMENT = "runs"

function isJournalRecord(relMatch: string): boolean {
  const segments = relMatch.split(/[/\\]+/).filter((segment) => segment.length > 0)
  return segments[1] === JOURNAL_SEGMENT
}

/**
 * Glob durable Workflow files within one scope dir (recursive, dot-dirs, symlinks followed). A non-existent
 * scope yields nothing (the global config dir may not exist; a stale `.opencode` may have vanished).
 */
export async function scanWorkflowFiles(dir: string): Promise<DiscoveredFile[]> {
  if (!existsSync(dir)) return []
  const glob = new Bun.Glob(WORKFLOW_GLOB)
  const out: DiscoveredFile[] = []
  for await (const relMatch of glob.scan({ cwd: dir, dot: true, followSymlinks: true, onlyFiles: true })) {
    if (isJournalRecord(relMatch)) continue
    out.push({ absPath: path.join(dir, relMatch), relMatch })
  }
  // Sort so an intra-scope key clash resolves deterministically (last-wins → alphabetically-last file),
  // not by filesystem scan order.
  out.sort((a, b) => a.relMatch.localeCompare(b.relMatch))
  return out
}

/** One registered durable Workflow: its key, file, originating scope dir, and declarative meta. */
export interface RegistryEntry {
  key: string
  absPath: string
  scope: string
  meta: WorkflowMeta
}

export interface Registry {
  /** Resolved key → entry, after last-wins precedence across scopes. */
  entries: Map<string, RegistryEntry>
  /**
   * A key re-seen and overridden — surfaced, not silent. `sameScope` distinguishes the expected cross-scope
   * shadow (project over global) from an author error (two files in ONE scope declaring the same key).
   */
  collisions: Array<{ key: string; kept: string; keptScope: string; shadowed: string; shadowedScope: string; sameScope: boolean }>
  /** Files that failed to load (import/shape error) — surfaced, not silent. */
  failures: Array<{ absPath: string; error: string }>
}

export interface BuildRegistryInput {
  directory: string
  worktree?: string
  /** Override the scanned scopes (tests). Defaults to {@link configDirs}. */
  dirs?: string[]
  /** Load a workflow module's config from its file path (tests). Defaults to read-bytes → {@link loadWorkflowConfig}. */
  loadConfig?: (absPath: string) => Promise<DefineWorkflowConfig>
  /** Loader cache directory (tests). */
  cacheDir?: string
}

/**
 * Build the live registry by scanning every scope (in load order) and keying each file by
 * `[...namespace, meta.name]`. Re-globs + re-loads on every call — discovery is on-demand, so a workflow file
 * written/edited mid-session is found without a restart (opencode's own command/tool registries are frozen
 * per-process; the plugin owns its discovery precisely to beat that). LAST-WINS across scopes ⇒ project beats
 * global; the shadowed file and any load failure are recorded, not dropped.
 */
export async function buildRegistry(input: BuildRegistryInput): Promise<Registry> {
  const dirs = input.dirs ?? configDirs(input.directory, input.worktree)
  const load =
    input.loadConfig ??
    ((absPath: string) => readFile(absPath, "utf8").then((source) => loadWorkflowConfig(source, { sourcePath: absPath, ...(input.cacheDir ? { cacheDir: input.cacheDir } : {}) })))
  const entries = new Map<string, RegistryEntry>()
  const collisions: Registry["collisions"] = []
  const failures: Registry["failures"] = []

  for (const dir of dirs) {
    for (const { absPath, relMatch } of await scanWorkflowFiles(dir)) {
      let config: DefineWorkflowConfig
      try {
        config = await load(absPath)
      } catch (err) {
        failures.push({ absPath, error: stringifyError(err) })
        continue
      }
      const key = workflowKey(relMatch, config.meta.name)
      const prev = entries.get(key)
      if (prev) collisions.push({ key, kept: absPath, keptScope: dir, shadowed: prev.absPath, shadowedScope: prev.scope, sameScope: prev.scope === dir })
      entries.set(key, { key, absPath, scope: dir, meta: config.meta })
    }
  }

  return { entries, collisions, failures }
}
