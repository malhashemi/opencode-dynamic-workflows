/**
 * Live checks for background notification, nested Workflows, worktree isolation and transcripts.
 *
 *     bun test ./packages/plugin/test/live/features.live.ts --timeout 600000
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { existsSync } from "node:fs"
import path from "node:path"

import { startLive, until, type LiveServer } from "./harness"

const CHILD = `import { defineWorkflow, z } from "@malhashemi/opencode-dynamic-workflows/workflow"
export default defineWorkflow({
  meta: { name: "child", description: "one Unit", args: z.object({ word: z.string() }) },
  async run({ agent, args }) { return agent(\`Reply with exactly: \${args.word.toUpperCase()}\`, { label: "shout" }) },
})
`
const PARENT = `import { defineWorkflow } from "@malhashemi/opencode-dynamic-workflows/workflow"
export default defineWorkflow({
  meta: { name: "parent", description: "calls a saved Workflow" },
  async run({ workflow }) { return { nested: await workflow("child", { word: "nested" }) } },
})
`
const EDIT = `import { defineWorkflow } from "@malhashemi/opencode-dynamic-workflows/workflow"
export default defineWorkflow({
  meta: { name: "edit", description: "two Units edit files in their own worktrees" },
  async run({ agent, parallel, worktrees }) {
    await parallel([
      () => agent("Create a file named a.txt containing exactly the word alpha, using the write tool. Then reply: done", { label: "writer a", isolation: "worktree", permissions: [{ action: "edit", resource: "*", effect: "allow" }] }),
      () => agent("Reply with exactly: nothing to change", { label: "reader", isolation: "worktree" }),
    ])
    return worktrees()
  },
})
`

let server: LiveServer
beforeAll(async () => {
  server = await startLive({
    files: {
      ".opencode/workflows/child.ts": CHILD,
      ".opencode/workflows/parent.ts": PARENT,
      ".opencode/workflows/edit.ts": EDIT,
    },
    commit: true,
  })
})
const kept: string[] = []
afterAll(async () => {
  // Kept worktrees live outside the scratch project (OpenCode's worktree dir): remove what this suite made.
  for (const directory of kept)
    await Bun.$`git -C ${server.project} worktree remove --force ${directory}`.quiet().nothrow()
  const { rmdir } = await import("node:fs/promises")
  for (const directory of kept) await rmdir(path.dirname(directory)).catch(() => {}) // only if now empty
  await server?.stop()
})

const w = () => server.workflow as any
const settled = (runId: string) =>
  until(
    async () => {
      const { run } = await w().getRun({ runId })
      return run.status !== "running" && run.status !== "queued" ? run : undefined
    },
    240_000,
    500,
  )

describe("live: features", () => {
  test("ctx.workflow runs a saved Workflow as a step", async () => {
    const { runId } = await w().startRun({ name: "parent" })
    const run = await settled(runId)
    expect(run.status).toBe("succeeded")
    expect((await w().getResult({ runId })).result).toEqual({ nested: "NESTED" })
    expect(run.units[0].label).toBe("child › shout")
  }, 240_000)

  test("worktree Units: an unchanged one is removed, a changed one kept; the checkout is untouched", async () => {
    const { runId } = await w().startRun({ name: "edit" })
    const run = await settled(runId)
    const { result } = await w().getResult({ runId })
    console.log("worktrees kept:", JSON.stringify(result), run.errors)
    expect(run.status).toBe("succeeded")
    kept.push(...result.map((tree: any) => tree.directory))
    expect(result).toHaveLength(1)
    expect(result[0].unit).toBe("writer a")
    expect(result[0].branch).toStartWith("workflow/wf-")
    expect(existsSync(`${result[0].directory}/a.txt`)).toBe(true)
    expect(existsSync(`${server.project}/a.txt`)).toBe(false)
    const reader = run.units.find((u: any) => u.label === "reader")
    expect(existsSync(reader.location)).toBe(false)
  }, 300_000)

  test("a Unit's transcript is served over RPC and the gateway", async () => {
    const { runs } = await w().listRuns({})
    const run = (await w().getRun({ runId: runs.find((r: any) => r.workflow.name === "parent").runId })).run
    const unit = run.units[0]
    const viaRpc = await w().getTranscript({ runId: run.runId, unitId: unit.unitId })
    expect(viaRpc.messages.some((m: any) => m.role === "assistant")).toBe(true)
    const viaHttp = (await (
      await fetch(`http://127.0.0.1:${server.gatewayPort}/v1/runs/${run.runId}/units/${unit.unitId}/transcript`)
    ).json()) as any
    expect(viaHttp.sessionID).toBe(unit.sessionID)
  })

  test("a background Run started by the model posts a notification into its session", async () => {
    const [providerID, id] = (process.env.WF_LIVE_MODEL ?? "claude-work/claude-opus-5-5").split("/", 2) as [
      string,
      string,
    ]
    const session = (await server.client.session.create({
      title: "bg driver",
      agent: "build",
      model: { providerID, id },
      location: { directory: server.project },
    } as never)) as any
    await server.client.session.prompt({
      sessionID: session.id,
      text: 'Call the workflow tool with {"name":"child","args":{"word":"later"},"background":true}. Then reply with exactly: STARTED',
    } as never)
    await server.client.session.wait({ sessionID: session.id })
    const notice = await until(
      async () => {
        const messages = (await server.client.session.context({ sessionID: session.id })) as any[]
        return messages.find((m) => m.type === "user" && String(m.text ?? "").includes("[workflow notification]"))
      },
      120_000,
      1_000,
    )
    const text = String(notice.text)
    console.log(text)
    expect(text).toContain("ended `succeeded`")
    expect(text).toContain("LATER")
  }, 300_000)
})
