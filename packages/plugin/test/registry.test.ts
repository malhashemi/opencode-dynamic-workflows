import { afterEach, describe, expect, it } from "bun:test"
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import {
  buildRegistry,
  configDirs,
  globalConfigDir,
  namespaceSegments,
  scanWorkflowFiles,
  workflowKey,
} from "../src/registry"

/** A minimal real durable Workflow module (imports defineWorkflow from our workspace). */
const wf = (name: string, ret = "x") =>
  `import { defineWorkflow } from "@opencode-ai/workflow"\n` +
  `export default defineWorkflow({ meta: { name: ${JSON.stringify(name)}, description: "d" }, async run() { return ${JSON.stringify(ret)} } })\n`

async function tmp(prefix: string): Promise<string> {
  return mkdtemp(path.join(os.tmpdir(), prefix))
}
async function write(dir: string, rel: string, contents: string): Promise<string> {
  const abs = path.join(dir, rel)
  await mkdir(path.dirname(abs), { recursive: true })
  await writeFile(abs, contents, "utf8")
  return abs
}

describe("namespaceSegments / workflowKey (pure)", () => {
  it("keys a top-level file by meta.name alone", () => {
    expect(namespaceSegments("workflows/foo.ts")).toEqual([])
    expect(workflowKey("workflows/foo.ts", "greet")).toBe("greet")
    expect(workflowKey("workflow/foo.ts", "greet")).toBe("greet") // singular root too
  })
  it("namespaces a one-level subfolder", () => {
    expect(namespaceSegments("workflows/deep-research/foo.ts")).toEqual(["deep-research"])
    expect(workflowKey("workflows/deep-research/foo.ts", "dr")).toBe("deep-research:dr")
  })
  it("namespaces multi-level subfolders, joined with ':'", () => {
    expect(namespaceSegments("workflows/a/b/foo.ts")).toEqual(["a", "b"])
    expect(workflowKey("workflows/a/b/foo.ts", "x")).toBe("a:b:x")
  })
  it("handles windows-style separators", () => {
    expect(workflowKey("workflows\\a\\foo.ts", "x")).toBe("a:x")
  })
})

describe("configDirs (scope resolution, mirrors ConfigPaths.directories)", () => {
  const KEYS = ["OPENCODE_TEST_HOME", "XDG_CONFIG_HOME", "OPENCODE_DISABLE_PROJECT_CONFIG", "OPENCODE_CONFIG_DIR"] as const
  const saved: Record<string, string | undefined> = {}
  for (const k of KEYS) saved[k] = process.env[k]
  afterEach(() => {
    for (const k of KEYS) {
      if (saved[k] === undefined) delete process.env[k]
      else process.env[k] = saved[k]
    }
  })

  it("returns [global, project-walked-up, ~/.opencode] in load order, existing dirs only", async () => {
    const home = await tmp("wf-home-")
    try {
      process.env.OPENCODE_TEST_HOME = home
      process.env.XDG_CONFIG_HOME = path.join(home, ".config")
      delete process.env.OPENCODE_DISABLE_PROJECT_CONFIG
      delete process.env.OPENCODE_CONFIG_DIR

      const worktree = path.join(home, "proj")
      await mkdir(path.join(worktree, ".opencode"), { recursive: true })
      await mkdir(path.join(worktree, "sub"), { recursive: true })
      await mkdir(path.join(home, ".opencode"), { recursive: true })

      const dirs = configDirs(path.join(worktree, "sub"), worktree)

      expect(dirs[0]).toBe(path.join(home, ".config", "opencode")) // global config always first
      expect(globalConfigDir()).toBe(path.join(home, ".config", "opencode"))
      expect(dirs).toContain(path.join(worktree, ".opencode")) // project, walked up from sub → worktree
      expect(dirs).toContain(path.join(home, ".opencode")) // user ~/.opencode
      // project scope is listed AFTER global (last-wins ⇒ project shadows global)
      expect(dirs.indexOf(path.join(worktree, ".opencode"))).toBeGreaterThan(0)
    } finally {
      await rm(home, { recursive: true, force: true })
    }
  })

  it("drops the project scope when OPENCODE_DISABLE_PROJECT_CONFIG is set, and appends OPENCODE_CONFIG_DIR last", async () => {
    const home = await tmp("wf-home-")
    try {
      process.env.OPENCODE_TEST_HOME = home
      process.env.XDG_CONFIG_HOME = path.join(home, ".config")
      process.env.OPENCODE_DISABLE_PROJECT_CONFIG = "1"
      const envDir = path.join(home, "envcfg")
      process.env.OPENCODE_CONFIG_DIR = envDir

      const worktree = path.join(home, "proj")
      await mkdir(path.join(worktree, ".opencode"), { recursive: true })

      const dirs = configDirs(worktree, worktree)
      expect(dirs).not.toContain(path.join(worktree, ".opencode")) // project config disabled
      expect(dirs[dirs.length - 1]).toBe(envDir) // env override appended last (highest precedence)
    } finally {
      await rm(home, { recursive: true, force: true })
    }
  })
})

describe("scanWorkflowFiles (recursive glob, symlinks)", () => {
  it("returns [] for a non-existent scope dir", async () => {
    expect(await scanWorkflowFiles(path.join(os.tmpdir(), "definitely-not-here-xyz"))).toEqual([])
  })

  it("finds top-level AND nested .ts files under workflow(s)/", async () => {
    const dir = await tmp("wf-scan-")
    try {
      await write(dir, "workflows/top.ts", wf("top"))
      await write(dir, "workflows/a/b/deep.ts", wf("deep"))
      await write(dir, "workflow/singular.ts", wf("sing")) // singular root accepted
      await write(dir, "workflows/notes.md", "ignored") // non-.ts ignored
      const rels = (await scanWorkflowFiles(dir)).map((f) => f.relMatch).sort()
      expect(rels).toContain("workflows/top.ts")
      expect(rels).toContain("workflows/a/b/deep.ts")
      expect(rels).toContain("workflow/singular.ts")
      expect(rels.some((r) => r.endsWith(".md"))).toBe(false)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})

describe("buildRegistry (discovery → keying → precedence)", () => {
  it("keys by [...namespace, meta.name], follows a symlinked dir, and surfaces collisions + failures", async () => {
    const globalScope = await tmp("wf-global-")
    const projectScope = await tmp("wf-project-")
    const external = await tmp("wf-external-")
    try {
      // global scope: a unique workflow + one that the project will shadow
      await write(globalScope, "workflows/shared.ts", wf("shared", "GLOBAL_SHARED"))
      const globalDup = await write(globalScope, "workflows/dup.ts", wf("dup", "GLOBAL_DUP"))

      // project scope (listed AFTER global ⇒ wins): same `dup` key + a nested namespaced workflow + a broken file
      const projectDup = await write(projectScope, "workflows/dup.ts", wf("dup", "PROJECT_DUP"))
      await write(projectScope, "workflows/deep-research/dr.ts", wf("dr"))
      await write(projectScope, "workflows/broken.ts", `export const nope = 1`) // no default defineWorkflow → failure

      // a symlinked DIRECTORY inside the project workflows root (followSymlinks must traverse it)
      await write(external, "ext.ts", wf("fromlink"))
      await symlink(external, path.join(projectScope, "workflows", "linked"), "dir")

      const reg = await buildRegistry({
        directory: projectScope,
        worktree: projectScope,
        dirs: [globalScope, projectScope], // explicit precedence: global first, project second (wins)
      })

      const keys = [...reg.entries.keys()].sort()
      expect(keys).toContain("shared")
      expect(keys).toContain("dup")
      expect(keys).toContain("deep-research:dr")
      expect(keys).toContain("linked:fromlink") // symlinked dir traversed + namespaced by the link name

      // last-wins: the PROJECT `dup` shadows the GLOBAL one, and the shadow is surfaced (not silent)
      expect(reg.entries.get("dup")?.absPath).toBe(projectDup)
      expect(reg.collisions).toContainEqual({
        key: "dup",
        kept: projectDup,
        keptScope: projectScope,
        shadowed: globalDup,
        shadowedScope: globalScope,
        sameScope: false,
      })

      // the malformed file is surfaced as a failure, not dropped silently, and never registered
      expect(reg.failures.some((f) => f.absPath.endsWith("broken.ts") && /defineWorkflow/.test(f.error))).toBe(true)
      expect(keys.some((k) => k === "broken" || k.endsWith(":broken"))).toBe(false)
    } finally {
      await rm(globalScope, { recursive: true, force: true })
      await rm(projectScope, { recursive: true, force: true })
      await rm(external, { recursive: true, force: true })
    }
  })

  it("surfaces a SAME-scope key clash deterministically (sorted last-wins), labeled sameScope", async () => {
    const scope = await tmp("wf-same-")
    try {
      const aFile = await write(scope, "workflows/aaa.ts", wf("twin", "AAA"))
      const zFile = await write(scope, "workflows/zzz.ts", wf("twin", "ZZZ"))
      const reg = await buildRegistry({ directory: scope, worktree: scope, dirs: [scope] })
      // scan is sorted ascending + last-wins, so the alphabetically-last file wins deterministically
      expect(reg.entries.get("twin")?.absPath).toBe(zFile)
      expect(reg.collisions).toContainEqual({
        key: "twin",
        kept: zFile,
        keptScope: scope,
        shadowed: aFile,
        shadowedScope: scope,
        sameScope: true,
      })
    } finally {
      await rm(scope, { recursive: true, force: true })
    }
  })
})
