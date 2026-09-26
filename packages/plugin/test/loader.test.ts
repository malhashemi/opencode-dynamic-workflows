import { afterAll, describe, expect, it } from "bun:test"
import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { AUTHORING_PATH, hasRelativeImports, loadWorkflow, rewriteAuthoringImports } from "../src/loader"

const cacheDir = await mkdtemp(path.join(os.tmpdir(), "wf-loader-"))
afterAll(() => rm(cacheDir, { recursive: true, force: true }))

const source = (specifier: string, name = "w") =>
  `import { defineWorkflow, z } from "${specifier}"\n` +
  `export default defineWorkflow({ meta: { name: "${name}", description: "d", args: z.object({ n: z.number() }) }, async run({ args }) { return args.n * 2 } })\n`

describe("loader", () => {
  it("rewrites every authoring specifier (static, dynamic, side-effect) and leaves others alone", () => {
    const input = [
      `import { defineWorkflow } from "@opencode-ai/workflow"`,
      `import type { AgentFn } from '@malhashemi/opencode-dynamic-workflows/workflow'`,
      `const m = await import("@opencode-ai/workflow")`,
      `import "@opencode-ai/workflow"`,
      `import fs from "node:fs"`,
    ].join("\n")
    const output = rewriteAuthoringImports(input, "/x/index.ts")
    expect(output.match(/\/x\/index\.ts/g)).toHaveLength(4)
    expect(output).toContain(`import fs from "node:fs"`)
    expect(output).toContain(`from '/x/index.ts'`)
    // A Windows path becomes forward slashes (backslashes would be escapes inside the string literal).
    expect(rewriteAuthoringImports(`import { z } from "@opencode-ai/workflow"`, "C:\\plug\\src\\workflow\\index.ts")).toBe(
      `import { z } from "C:/plug/src/workflow/index.ts"`,
    )
  })

  it("loads inline source that imports either authoring name, sharing the engine's module", async () => {
    for (const specifier of ["@opencode-ai/workflow", "@malhashemi/opencode-dynamic-workflows/workflow"]) {
      const loaded = await loadWorkflow(source(specifier, specifier.replace(/\W/g, "")), { cacheDir })
      expect(await loaded.config.run({ args: { n: 21 } } as never)).toBe(42)
      expect(loaded.config.meta.args?.safeParse({ n: 1 }).success).toBe(true)
    }
  })

  it("writes each distinct source to its own directory and reuses it for identical bytes", async () => {
    const a = await loadWorkflow(source("@opencode-ai/workflow", "a1"), { cacheDir })
    const b = await loadWorkflow(source("@opencode-ai/workflow", "b1"), { cacheDir })
    const again = await loadWorkflow(source("@opencode-ai/workflow", "a1"), { cacheDir })
    expect(path.dirname(a.file)).not.toBe(path.dirname(b.file))
    expect(again.file).toBe(a.file)
  })

  it("bundles a durable file with relative imports and keeps the authoring module external", async () => {
    const project = await mkdtemp(path.join(os.tmpdir(), "wf-durable-"))
    try {
      await mkdir(path.join(project, "lib"), { recursive: true })
      await writeFile(path.join(project, "lib", "helper.ts"), `export const triple = (n: number) => n * 3\n`)
      const file = path.join(project, "flow.ts")
      const text =
        `import { defineWorkflow } from "@opencode-ai/workflow"\nimport { triple } from "./lib/helper"\n` +
        `export default defineWorkflow({ meta: { name: "rel", description: "d" }, async run() { return triple(5) } })\n`
      await writeFile(file, text)
      expect(hasRelativeImports(text)).toBe(true)
      const loaded = await loadWorkflow(text, { cacheDir, sourcePath: file })
      expect(loaded.file.endsWith("workflow.js")).toBe(true)
      expect(await loaded.config.run({} as never)).toBe(15)
      const bundled = await Bun.file(loaded.file).text()
      expect(bundled).toContain(AUTHORING_PATH)
    } finally {
      await rm(project, { recursive: true, force: true })
    }
  })

  it("rejects a module without a defineWorkflow default export", async () => {
    await expect(loadWorkflow(`export const x = 1\n`, { cacheDir })).rejects.toThrow("defineWorkflow")
    expect((await readdir(cacheDir)).length).toBeGreaterThan(0)
  })
})
