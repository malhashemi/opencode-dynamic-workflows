import { describe, expect, it } from "bun:test"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import os from "node:os"
import { loadWorkflowConfig, runWorkflow, runWorkflowFromFile } from "../src/orchestrator"
import { makeFakeClient } from "./fake-client"

const ECHO_WORKFLOW = `
import { defineWorkflow } from "@opencode-ai/workflow"
export default defineWorkflow({
  meta: { name: "echo", description: "run one unit and echo it" },
  async run({ agent, args, log }) {
    log("starting")
    const out = await agent(\`say: \${args.word}\`, { subagent: "general" })
    return { out, word: args.word }
  },
})
`

const TYPED_WORKFLOW = `
import { defineWorkflow, z } from "@opencode-ai/workflow"
export default defineWorkflow({
  meta: { name: "typed", description: "needs a numeric count", args: z.object({ count: z.number() }) },
  async run({ agent, args }) {
    return await agent(\`n=\${args.count}\`)
  },
})
`

// The capstone demo: typed args → a no-barrier pipeline of per-item Subagent chains → a deliberately-failing
// item drops to null without aborting the rest → collect the survivors → one synthesis Unit emits the result.
// Exercises phase()/log() observability too. The fake client echoes each prompt, so outputs are predictable.
const DEMO_WORKFLOW = `
import { defineWorkflow, z } from "@opencode-ai/workflow"
export default defineWorkflow({
  meta: { name: "review-each", description: "review + verify each file", args: z.object({ files: z.array(z.string()) }) },
  async run({ agent, pipeline, collect, log, phase, args }) {
    phase("Review")
    const reviewed = await pipeline(
      args.files,
      (file) => { if (file === "bad") throw new Error("cannot review " + file); return agent("review:" + file) },
      (review) => agent("verify:" + review),
    )
    const survivors = collect(reviewed)
    if (reviewed.length !== survivors.length) log(\`dropped \${reviewed.length - survivors.length} file(s) from the pipeline\`)
    phase("Synthesize")
    const final = await agent("synthesize:" + survivors.join("|"))
    return { final, survivors: survivors.length }
  },
})
`

describe("runWorkflow (inline source → run → result)", () => {
  it("imports inline source, runs the workflow, and returns its result", async () => {
    const client = makeFakeClient({ reply: "HELLO" })
    const out = await runWorkflow({
      source: ECHO_WORKFLOW,
      args: { word: "hi" },
      client,
      parentSessionID: "parent-xyz",
    })

    expect(out.meta.name).toBe("echo")
    expect(out.result).toEqual({ out: "HELLO", word: "hi" })
    expect(out.state.logs).toEqual(["starting"])
    expect(out.state.unitCount).toBe(1)

    // the Unit ran as a child of the invoking session, under `general`
    expect(client.createCalls[0]?.body).toEqual({ parentID: "parent-xyz", title: "wf:general" })
    expect(client.promptCalls[0]?.body?.agent).toBe("general")
    expect(client.promptCalls[0]?.body?.parts).toEqual([{ type: "text", text: "say: hi" }])
  })

  it("cleans up the temp module after running", async () => {
    const before = await tmpFileCount()
    await runWorkflow({
      source: ECHO_WORKFLOW,
      args: { word: "x" },
      client: makeFakeClient({ reply: "y" }),
      parentSessionID: "p",
    })
    const after = await tmpFileCount()
    expect(after).toBe(before)
  })

  it("throws a clear error when source has no default defineWorkflow export", async () => {
    await expect(
      runWorkflow({
        source: `export const nope = 1`,
        client: makeFakeClient(),
        parentSessionID: "p",
      }),
    ).rejects.toThrow(/defineWorkflow/)
  })

  it("surfaces a failed Unit via state.errors without throwing", async () => {
    const out = await runWorkflow({
      source: ECHO_WORKFLOW,
      args: { word: "z" },
      client: makeFakeClient({ promptError: "kaboom" }),
      parentSessionID: "p",
    })
    expect(out.result).toEqual({ out: null, word: "z" })
    expect(out.state.errors[0]?.error).toContain("kaboom")
  })

  it("validates args against meta.args BEFORE any Unit launches, naming the offending field (D7)", async () => {
    const client = makeFakeClient({ reply: "ok" })
    await expect(
      runWorkflow({ source: TYPED_WORKFLOW, args: { count: "not-a-number" }, client, parentSessionID: "p" }),
    ).rejects.toThrow(/count/) // the error names the offending field
    expect(client.promptCalls).toHaveLength(0) // failed before launching any Unit
  })

  it("passes validated args through to a typed ctx.args when input satisfies the schema", async () => {
    const client = makeFakeClient({ reply: "ok" })
    const out = await runWorkflow({ source: TYPED_WORKFLOW, args: { count: 7 }, client, parentSessionID: "p" })
    expect(out.result).toBe("ok")
    expect(client.promptCalls[0]?.body?.parts).toEqual([{ type: "text", text: "n=7" }])
  })

  it("runs the demo end-to-end: typed args, pipeline with a dropped item, collect, and a synthesis Unit", async () => {
    const client = makeFakeClient()
    const out = await runWorkflow({
      source: DEMO_WORKFLOW,
      args: { files: ["a", "bad", "b"] },
      client,
      parentSessionID: "p",
    })

    // The failing item ("bad") dropped without aborting the others; survivors flowed to a single synthesis Unit.
    expect(out.result).toEqual({ final: "synthesize:verify:review:a|verify:review:b", survivors: 2 })
    expect(out.state.errors).toHaveLength(1)
    expect(out.state.errors[0]?.unit).toBe("pipeline#1") // "bad" was index 1
    // Observable progress: both phase titles recorded, and a log line naming the dropped item (exact text).
    expect(out.state.phases).toEqual(["Review", "Synthesize"])
    expect(out.state.logs).toContain("dropped 1 file(s) from the pipeline")
    // "bad" never reached a Subagent (its stage threw before agent()); the rest did.
    const prompts = client.promptCalls.map((p) => p.body?.parts?.[0]?.text)
    expect(prompts).not.toContain("review:bad")
    expect(prompts).toContain("review:a")
    expect(prompts).toContain("review:b")
  })
})

describe("durable file loading (runWorkflowFromFile / loadWorkflowConfig)", () => {
  async function durableDir(): Promise<string> {
    return mkdtemp(path.join(os.tmpdir(), "wf-durable-"))
  }

  it("runs a durable workflow file by path (read bytes → run)", async () => {
    const dir = await durableDir()
    try {
      const file = path.join(dir, "echo.ts")
      await writeFile(file, ECHO_WORKFLOW, "utf8")
      const client = makeFakeClient({ reply: "HELLO" })
      const out = await runWorkflowFromFile(file, { args: { word: "hi" }, client, parentSessionID: "p" })
      expect(out.meta.name).toBe("echo")
      expect(out.result).toEqual({ out: "HELLO", word: "hi" })
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  // The load-bearing in-session-edit behavior: a durable file edited between runs (SAME path) must run its NEW
  // content. Bun caches imports by resolved real path, so this only works because runWorkflowFromFile re-reads
  // the bytes and materialize() writes them to a fresh unique temp filename each call.
  it("picks up an in-session EDIT to the same durable path (fresh bytes, not the stale module)", async () => {
    const dir = await durableDir()
    try {
      const file = path.join(dir, "ver.ts")
      const mk = (body: string) =>
        `import { defineWorkflow } from "@opencode-ai/workflow"\n` +
        `export default defineWorkflow({ meta: { name: "ver", description: "v" }, async run() { return ${JSON.stringify(body)} } })\n`
      await writeFile(file, mk("V1"), "utf8")
      const r1 = await runWorkflowFromFile(file, { client: makeFakeClient(), parentSessionID: "p" })
      expect(r1.result).toBe("V1")

      await writeFile(file, mk("V2"), "utf8") // edit the SAME path mid-session
      const r2 = await runWorkflowFromFile(file, { client: makeFakeClient(), parentSessionID: "p" })
      expect(r2.result).toBe("V2")
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it("loadWorkflowConfig returns meta + run without executing (no prompts, temp cleaned)", async () => {
    const before = await tmpFileCount()
    const config = await loadWorkflowConfig(ECHO_WORKFLOW)
    expect(config.meta.name).toBe("echo")
    expect(typeof config.run).toBe("function")
    expect(await tmpFileCount()).toBe(before) // module imported into memory, temp removed
  })

  it("does not leak a temp file when the source import throws", async () => {
    const before = await tmpFileCount()
    await expect(loadWorkflowConfig(`export const nope = 1`)).rejects.toThrow(/defineWorkflow/)
    expect(await tmpFileCount()).toBe(before)
  })
})

import { readdir } from "node:fs/promises"
import path from "node:path"

async function tmpFileCount(): Promise<number> {
  const dir = path.join(import.meta.dir, "..", ".wf-tmp")
  try {
    return (await readdir(dir)).length
  } catch {
    return 0
  }
}
