import { describe, expect, it } from "bun:test"
import { runWorkflow } from "../src/orchestrator"
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
