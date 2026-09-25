/**
 * Live end-to-end checks on a real OpenCode V2 host (private server, cheap model). Run with:
 *
 *     bun test ./packages/plugin/test/live/core.live.ts --timeout 300000
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { drive, startLive, toolOutput, until, type LiveServer } from "./harness"

const FANOUT = `import { defineWorkflow, z } from "opencode-dynamic-workflows/workflow"
export default defineWorkflow({
  meta: {
    name: "fanout",
    description: "three short facts and one typed rating",
    phases: [{ title: "facts" }, { title: "rate" }],
    args: z.object({ topic: z.string() }),
  },
  async run({ agent, parallel, collect, phase, args, log }) {
    phase("facts")
    const facts = collect(await parallel([1, 2, 3].map((n) => () =>
      agent(\`Reply with one short sentence: fact number \${n} about \${args.topic}. Do not use tools.\`, { label: \`fact \${n}\` }))))
    log(\`got \${facts.length} facts\`)
    phase("rate")
    const Rating = z.object({ score: z.number().int().min(1).max(10), reason: z.string().min(3) })
    const rating = await agent(\`Rate how interesting these facts are from 1 to 10:\\n\${facts.join("\\n")}\`, { label: "rating", schema: Rating })
    return { facts, rating }
  },
})
`

const CAPS = `import { defineWorkflow } from "opencode-dynamic-workflows/workflow"
export default defineWorkflow({
  meta: { name: "caps", description: "capabilities in the host" },
  async run({ $, file }) {
    const pwd = await $("pwd")
    await file.write("out/hello.txt", "hi")
    let escaped = "no"
    try { await file.read("../../etc/hosts") ; escaped = "yes" } catch (e) { escaped = String(e.message) }
    return { pwd: pwd.stdout.trim(), wrote: await file.read("out/hello.txt"), escaped }
  },
})
`

let server: LiveServer
beforeAll(async () => {
  server = await startLive({ files: { ".opencode/workflows/fanout.ts": FANOUT, ".opencode/workflows/caps.ts": CAPS }, pluginOptions: { inline: "allow" } })
})
afterAll(async () => {
  await server?.stop()
})

describe("live: core", () => {
  test("RPC info and the durable registry", async () => {
    const info = (await server.workflow.info({})) as any
    expect(info.protocol).toBe(1)
    expect(info.location).toContain("project")
    const listing = (await server.workflow.listWorkflows({})) as any
    expect(listing.workflows.map((w: any) => w.key)).toEqual(["caps", "fanout"])
    expect(listing.workflows[1].args.properties.topic.type).toBe("string")
    const agents = (await server.client.agent.list({ location: { directory: server.project } } as never)) as any
    console.log("agents:", (agents.data ?? agents).map((a: any) => `${a.id ?? a.name}:${a.mode}`).join(", "))
  })

  test("a durable Workflow runs from RPC: parallel text Units + a typed Unit", async () => {
    const { runId } = (await server.workflow.startRun({ name: "fanout", args: { topic: "octopuses" } })) as any
    const run = await until(async () => {
      const { run } = (await server.workflow.getRun({ runId })) as any
      return run.status !== "running" && run.status !== "queued" ? run : undefined
    }, 180_000, 1_000)
    console.log(JSON.stringify({ status: run.status, units: run.units.map((u: any) => [u.label, u.status, u.resultPath, u.sessionID, u.model.resolved]), errors: run.errors, usage: run.usage }, null, 1))
    expect(run.status).toBe("succeeded")
    expect(run.units).toHaveLength(4)
    expect(run.units.every((u: any) => u.sessionID)).toBe(true)
    const typed = run.units.find((u: any) => u.label === "rating")
    expect(typed.schema).toBe(true)
    expect(["tool", "text-json", "extract"]).toContain(typed.resultPath)
    const { result } = (await server.workflow.getResult({ runId })) as any
    expect(result.facts).toHaveLength(3)
    expect(result.rating.score).toBeGreaterThanOrEqual(1)
    const session = (await server.client.session.get({ sessionID: typed.sessionID })) as any
    expect(session.title).toBe("⟡ wf · fanout · rating")
    expect(session.metadata.workflow.runId).toBe(runId)
  }, 240_000)

  test("the workflow tool runs a durable Workflow in the foreground and relays the summary", async () => {
    const { messages } = await drive(server, 'Call the workflow tool with {"name":"fanout","args":{"topic":"bees"}}. Then reply with its summary line only.')
    const output = toolOutput(messages, "workflow")
    console.log(output)
    expect(output).toContain("fanout · succeeded · 4/4 units")
    expect(output).toMatch(/run [0-9a-f-]{36}/)
  }, 240_000)

  test("workflow_inline runs model-authored source (inline allowed by option)", async () => {
    const source = `import { defineWorkflow } from "opencode-dynamic-workflows/workflow"\nexport default defineWorkflow({ meta: { name: "hello-inline", description: "one unit" }, async run({ agent }) { return agent("Reply with exactly: INLINE-OK") } })`
    const { messages } = await drive(server, `Call the workflow_inline tool with this exact source and no args:\n\n${source}\n\nThen reply with its output.`)
    const output = toolOutput(messages, "workflow_inline")
    console.log(output)
    expect(output).toContain("INLINE-OK")
    expect(output).toContain("hello-inline · succeeded")
  }, 240_000)

  test("capabilities run confined to the project and are audited", async () => {
    const { runId } = (await server.workflow.startRun({ name: "caps" })) as any
    await until(async () => {
      const { run } = (await server.workflow.getRun({ runId })) as any
      return run.status !== "running" && run.status !== "queued" ? run : undefined
    }, 60_000, 300)
    const { result } = (await server.workflow.getResult({ runId })) as any
    expect(result.pwd).toBe(server.project)
    expect(result.wrote).toBe("hi")
    expect(result.escaped).toContain("escapes the project")
    const { entries } = (await server.workflow.getActivity({ runId })) as any
    expect(entries.filter((e: any) => e.kind === "capability").map((e: any) => e.message)).toEqual(["$ pwd", "write out/hello.txt (2 bytes)", "read out/hello.txt"])
  })
})
