/**
 * A disposable, real OpenCode project for live probes.
 *
 * Every live phase needs the same three things before it can assert anything: a Git worktree (so `directory`
 * and `worktree` resolve to one concrete root instead of the non-VCS global-project `/` case), this package
 * installed through the REAL installer (so the probe proves dual-target detection rather than assuming it),
 * and the phase's workflow fixtures on disk where the registry will find them.
 *
 * The install runs `opencode plugin <path>`, not a hand-written config file, on purpose: the installer is the
 * thing under test. It inspects `exports["./server"]` and `exports["./tui"]` and patches BOTH `opencode.json`
 * and `tui.json` in one operation — a regression there (a dropped export, a renamed entrypoint) silently
 * halves the plugin, and a hand-written config would hide it.
 */
import { cp, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { readDescriptors, type EndpointDescriptor } from "../../../src/discovery"
import { opencodeStatePath } from "../../../src/index"

/** This repository's plugin package — the default install target. */
export const PLUGIN_PACKAGE_PATH = path.resolve(import.meta.dir, "..", "..", "..")

/** Checked-in workflow fixtures live here; `fixtures` entries resolve against it when not absolute. */
export const FIXTURES_DIR = path.resolve(import.meta.dir, "..", "fixtures")

/**
 * The stock agent a pinned probe drives its PARENT session with.
 *
 * Pinning only `model` leaves the parent session on the developer's `default_agent`, which carries its own
 * model — so the prompt that starts the run still spends their daily driver even though every subagent was
 * redirected.
 */
const PROBE_DEFAULT_AGENT = "build"

/** Agents a pinned probe forces onto the chosen model: the parent's, plus every subagent the fixtures use. */
const PINNED_AGENTS = [PROBE_DEFAULT_AGENT, "general", "explore"] as const

export interface ScratchProject {
  root: string
  worktree: string
  /** `<root>/.opencode` */
  opencodeDir: string
  /** `<root>/.opencode/workflows` */
  workflowsDir: string
  /** The exact spec the installer wrote into both config files. */
  pluginSpec: string
  /**
   * An isolated `XDG_STATE_HOME` for the host under test, and the OpenCode state directory inside it.
   *
   * Two reasons, both learned the hard way. First, OpenCode's TUI persists display preferences in that
   * directory's `kv.json` — including `sidebar: "hide"`, which suppresses the sidebar's auto-open at any
   * width. A probe that inherits the developer's preferences asserts against the developer's screen, not the
   * product's defaults. Second, the workflow endpoint descriptor also lives there, so isolation keeps this
   * probe from discovering (or leaving litter for) the developer's own running OpenCode sessions.
   */
  stateHome: string
  /** `<stateHome>/opencode` — where the server target publishes its endpoint descriptor. */
  statePath: string
/**
   * A scratch `XDG_CONFIG_HOME`, used only when {@link ScratchProjectOptions.isolateConfig} is set.
   *
   * Isolating config makes a probe hermetic: it otherwise inherits the developer's global `opencode.json`,
   * including `default_agent` and every per-agent `model` pin, which decides *which credentials the run
   * spends*. A probe can then fail with "No Claude account is available" while the code under test is
   * perfectly healthy, and "the fixture runs on a real host" quietly means "…on *this developer's* host".
   *
   * It is off by default because that same global config is also where credential brokers and custom
   * providers are wired up, and isolating it can remove the very thing that makes a model reachable. Prefer
   * {@link ScratchProjectOptions.model} first; reach for this when a probe must not see the developer's
   * agents at all.
   */
  configHome: string
  /** Environment for the host process: isolated state and config, with `OPENCODE_PURE` guaranteed absent. */
  hostEnv: Record<string, string>
  cleanup(): Promise<void>
}

export interface ScratchProjectOptions {
  /** Defaults to this package's absolute path. */
  pluginPath?: string
  /** Workflow files to copy into `workflowsDir`; bare names resolve against {@link FIXTURES_DIR}. */
  fixtures?: string[]
  /** Fail the install if it takes longer than this. A cold npm-dependency prepare dominates. */
  installTimeoutMs?: number
  /**
   * The model the scratch host should use, e.g. `anthropic/claude-haiku-4-5-20251001`.
   *
   * Defaults to `$OPENCODE_LIVE_MODEL`, and to the host's own default when that is unset. Every probe drives
   * a real child session, and the fixtures only ever ask a model to echo a token — so there is no reason for
   * them to burn the daily-driver model, and good reason not to: a probe that shares a credential pool with
   * interactive work fails whenever that pool is exhausted, for reasons that have nothing to do with the code
   * under test.
   */
  model?: string
  /**
   * Boot the host on stock configuration, ignoring the developer's global `opencode.json` entirely.
   *
   * Defaults to `$OPENCODE_LIVE_ISOLATE_CONFIG === "1"`, i.e. off. See {@link ScratchProject.configHome} for
   * why this is a tradeoff rather than a straight improvement.
   */
  isolateConfig?: boolean
}

async function run(
  command: string[],
  options: { cwd: string; timeoutMs: number },
): Promise<{ ok: boolean; stdout: string; stderr: string }> {
  const proc = Bun.spawn(command, { cwd: options.cwd, stdout: "pipe", stderr: "pipe", stdin: "ignore" })
  const timer = setTimeout(() => proc.kill(), options.timeoutMs)
  try {
    const [stdout, stderr, code] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ])
    return { ok: code === 0, stdout, stderr }
  } finally {
    clearTimeout(timer)
  }
}

/**
 * Merge a `model` into the config the installer just wrote, leaving its `plugin` array untouched.
 *
 * The subagents the fixtures dispatch to are pinned too, not just the top-level default. A per-agent `model`
 * in the developer's global config **outranks** a project-level `model`, so pinning only the latter looks
 * like it worked while the unit still runs on the developer's own daily driver — which is exactly how a probe
 * ends up failing on an exhausted credential pool that has nothing to do with the code under test.
 */
async function setConfigModel(configFile: string, model: string): Promise<void> {
  const parsed = JSON.parse(await readFile(configFile, "utf8")) as Record<string, unknown>
  const agent = (parsed.agent ?? {}) as Record<string, unknown>
  const pinned = Object.fromEntries(PINNED_AGENTS.map((name) => [name, { ...((agent[name] as object) ?? {}), model }]))
  const next = {
    ...parsed,
    model,
    default_agent: PROBE_DEFAULT_AGENT,
    agent: { ...agent, ...pinned },
  }
  await writeFile(configFile, `${JSON.stringify(next, null, 2)}\n`, "utf8")
}

async function pluginList(configFile: string): Promise<string[]> {
  try {
    const parsed = JSON.parse(await readFile(configFile, "utf8")) as { plugin?: unknown }
    if (!Array.isArray(parsed.plugin)) return []
    // The installer writes either a bare spec or a `[spec, options]` tuple when a target declares defaults.
    return parsed.plugin.map((entry) => (Array.isArray(entry) ? String(entry[0]) : String(entry)))
  } catch {
    return []
  }
}

export async function createScratchProject(options: ScratchProjectOptions = {}): Promise<ScratchProject> {
  const pluginPath = options.pluginPath ?? PLUGIN_PACKAGE_PATH
  // realpath matters on macOS, where `$TMPDIR` lives under the `/var → /private/var` symlink: OpenCode reports
  // the resolved worktree, so an unresolved root would never match a published descriptor.
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "oc-workflow-live-")))
  const opencodeDir = path.join(root, ".opencode")
  const workflowsDir = path.join(opencodeDir, "workflows")
  const stateHome = path.join(root, "xdg-state")
  const statePath = path.join(stateHome, "opencode")
  const configHome = path.join(root, "xdg-config")
  const isolateConfig = options.isolateConfig ?? process.env.OPENCODE_LIVE_ISOLATE_CONFIG === "1"

  const cleanup = async () => {
    await rm(root, { recursive: true, force: true })
  }

  try {
    const git = await run(["git", "init", "-q"], { cwd: root, timeoutMs: 30_000 })
    if (!git.ok) throw new Error(`git init failed in the scratch project: ${git.stderr.trim()}`)
    await mkdir(workflowsDir, { recursive: true })
    await mkdir(statePath, { recursive: true })
    await mkdir(path.join(configHome, "opencode"), { recursive: true })

    for (const fixture of options.fixtures ?? []) {
      const source = path.isAbsolute(fixture) ? fixture : path.join(FIXTURES_DIR, fixture)
      await cp(source, path.join(workflowsDir, path.basename(source)))
    }

    const install = await run(["opencode", "plugin", pluginPath], {
      cwd: root,
      timeoutMs: options.installTimeoutMs ?? 180_000,
    })
    if (!install.ok) {
      throw new Error(`\`opencode plugin ${pluginPath}\` failed:\n${install.stdout}\n${install.stderr}`)
    }

    // Applied AFTER the installer, so the installer still writes the config it would write in production and
    // the dual-target assertion below still describes the installer's own output.
    const model = options.model ?? process.env.OPENCODE_LIVE_MODEL
    if (model) await setConfigModel(path.join(opencodeDir, "opencode.json"), model)

    const [serverPlugins, tuiPlugins] = await Promise.all([
      pluginList(path.join(opencodeDir, "opencode.json")),
      pluginList(path.join(opencodeDir, "tui.json")),
    ])
    if (!serverPlugins.includes(pluginPath) || !tuiPlugins.includes(pluginPath)) {
      throw new Error(
        "the installer did not detect BOTH targets — one `opencode plugin` must patch opencode.json and tui.json.\n" +
          `  opencode.json plugins: ${JSON.stringify(serverPlugins)}\n` +
          `  tui.json plugins:      ${JSON.stringify(tuiPlugins)}`,
      )
    }

    return {
      root,
      worktree: root,
      opencodeDir,
      workflowsDir,
      pluginSpec: pluginPath,
      stateHome,
      statePath,
      configHome,
      hostEnv: {
        XDG_STATE_HOME: stateHome,
        ...(isolateConfig ? { XDG_CONFIG_HOME: configHome } : {}),
      },
      cleanup,
    }
  } catch (error) {
    await cleanup()
    throw error
  }
}

/** OpenCode's canonical state directory — the same computation the server target publishes into. */
export function liveStatePath(): string {
  return opencodeStatePath()
}

/**
 * The live endpoint descriptor for a given worktree, or `null` while none is published.
 *
 * Several OpenCode hosts routinely run on one machine (the developer's own sessions among them), so a probe
 * must select by worktree rather than take the newest entry. `readDescriptors` has already pruned malformed,
 * PID-mismatched, and dead-process records by the time this filters.
 */
export async function readLiveDescriptor(
  statePath: string,
  match: { worktree: string },
): Promise<EndpointDescriptor | null> {
  const wanted = path.resolve(match.worktree)
  const descriptors = await readDescriptors(statePath)
  return descriptors.find((descriptor) => path.resolve(descriptor.worktree) === wanted) ?? null
}

/** Poll {@link readLiveDescriptor} until the host publishes one, or fail with a legible timeout. */
export async function waitForLiveDescriptor(
  statePath: string,
  match: { worktree: string },
  opts: { timeoutMs?: number; intervalMs?: number } = {},
): Promise<EndpointDescriptor> {
  const timeoutMs = opts.timeoutMs ?? 120_000
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const descriptor = await readLiveDescriptor(statePath, match)
    if (descriptor) return descriptor
    await Bun.sleep(opts.intervalMs ?? 500)
  }
  throw new Error(
    `no workflow endpoint descriptor for worktree ${match.worktree} appeared under ${statePath} within ${timeoutMs}ms.\n` +
      "the server target either failed to activate or never reached `writeDescriptor` (check that the host was " +
      "launched WITHOUT OPENCODE_PURE, and that `opencode.json` lists this package).",
  )
}
