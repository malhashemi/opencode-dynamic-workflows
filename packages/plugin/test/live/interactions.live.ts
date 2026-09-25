/**
 * Live checks for everything that waits on a person, plus stop/resume and Gateway auth, on a real OpenCode V2
 * host. A surface is "attached" through the RPC `attach` method (what the TUI does every ~20 s).
 *
 *     bun test ./packages/plugin/test/live/interactions.live.ts --timeout 300000
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { readFile } from "node:fs/promises"
import path from "node:path"
import { drive, startLive, toolOutput, until, type LiveServer } from "./harness"

const ASK = `import { defineWorkflow } from "opencode-dynamic-workflows/workflow"
export default defineWorkflow({
  meta: { name: "ask", description: "asks the person one question" },
  async run({ ask }) {
    const [[depth]] = await ask(
      { header: "Depth", prompt: "How deep?", options: [{ label: "Fast", description: "quick" }, { label: "Thorough", description: "slow" }] },
      { fallback: [["Fast"]] },
    )
    return depth
  },
})
`

const UNIT_QUESTION = `import { defineWorkflow } from "opencode-dynamic-workflows/workflow"
export default defineWorkflow({
  meta: { name: "unit-question", description: "a Unit asks the person through the question tool" },
  async run({ agent }) {
    return agent("Use the question tool exactly once to ask the user which colour they prefer, with the options red and blue. Then reply with exactly: COLOUR=<their answer>, or COLOUR=none if nobody answered.")
  },
})
`

const PERMISSION = `import { defineWorkflow } from "opencode-dynamic-workflows/workflow"
export default defineWorkflow({
  meta: { name: "permission", description: "a Unit needs a permission decision" },
  async run({ agent }) {
    return agent("Read the file notes.txt in the project root with the read tool, then reply with exactly: CONTENT=<its first line>, or CONTENT=denied if you were not allowed.", {
      permissions: [{ action: "read", resource: "*", effect: "ask" }],
    })
  },
})
`

const SLOW = `import { defineWorkflow } from "opencode-dynamic-workflows/workflow"
export default defineWorkflow({
  meta: { name: "slow", description: "two Units, the second waits on a question" },
  async run({ agent, ask }) {
    const first = await agent("Reply with exactly: FIRST")
    const [[go]] = await ask({ header: "Go on?", prompt: "Continue?", options: [{ label: "Yes", description: "" }] }, { fallback: [["Yes"]] })
    const second = await agent("Reply with exactly: SECOND")
    return { first, go, second }
  },
})
`

const NOASK = `import { defineWorkflow } from "opencode-dynamic-workflows/workflow"
export default defineWorkflow({ meta: { name: "noask", description: "returns at once" }, async run() { return "done" } })
`

let server: LiveServer
const w = () => server.workflow as any

async function settled(runId: string, ms = 180_000) {
  return until(async () => {
    const { run } = await w().getRun({ runId })
    return run.status !== "running" && run.status !== "queued" ? run : undefined
  }, ms, 500)
}

async function pending(runId: string, ms = 120_000) {
  return until(async () => {
    const { run } = await w().getRun({ runId })
    return run.interactions[0]
  }, ms, 300)
}

beforeAll(async () => {
  server = await startLive({
    files: {
      ".opencode/workflows/ask.ts": ASK,
      ".opencode/workflows/unit-question.ts": UNIT_QUESTION,
      ".opencode/workflows/permission.ts": PERMISSION,
      ".opencode/workflows/slow.ts": SLOW,
      ".opencode/workflows/noask.ts": NOASK,
      "notes.txt": "secret-line-42\n",
    },
  })
})
afterAll(async () => {
  await server?.stop()
})

describe("live: headless (no surface attached)", () => {
  test("ctx.ask answers with the fallback at once", async () => {
    const { runId } = await w().startRun({ name: "ask" })
    const run = await settled(runId, 30_000)
    expect(run.status).toBe("succeeded")
    expect((await w().getResult({ runId })).result).toBe("Fast")
  })

  test("a Unit's question gets 'nobody available' and the Unit proceeds", async () => {
    const { runId } = await w().startRun({ name: "unit-question" })
    const run = await settled(runId)
    const { result } = await w().getResult({ runId })
    console.log("headless unit question:", run.status, result)
    expect(run.status).toBe("succeeded")
    expect(String(result)).toContain("COLOUR=")
  }, 240_000)

  test("a permission ask is denied with a legible message instead of hanging", async () => {
    const { runId } = await w().startRun({ name: "permission" })
    const run = await settled(runId)
    const { result } = await w().getResult({ runId })
    console.log("headless permission:", run.status, result)
    expect(run.status).toBe("succeeded")
    expect(String(result)).not.toContain("secret-line-42")
  }, 240_000)

  test("an inline Workflow is refused when nobody can approve it", async () => {
    const source = `import { defineWorkflow } from "opencode-dynamic-workflows/workflow"\nexport default defineWorkflow({ meta: { name: "inline-x", description: "d" }, async run() { return "ran" } })`
    const { runId } = await w().startRun({ source })
    const run = await settled(runId, 30_000)
    expect(run.status).toBe("failed")
    expect(run.logs.join("\n")).toContain("no one approved the inline Workflow")
  })
})

describe("live: attached surface", () => {
  const attach = () => w().attach({ surface: "live-test", ttlMs: 120_000 })

  test("ctx.ask is published and a reply resumes the Run", async () => {
    await attach()
    const { runId } = await w().startRun({ name: "ask" })
    const interaction = await pending(runId)
    expect(interaction.origin).toBe("script")
    await expect(w().replyInteraction({ runId, interactionId: interaction.interactionId, answers: [["Mars"]] })).rejects.toThrow()
    await w().replyInteraction({ runId, interactionId: interaction.interactionId, answers: [["thorough"]] })
    await settled(runId, 30_000)
    expect((await w().getResult({ runId })).result).toBe("Thorough")
    const { run } = await w().getRun({ runId })
    expect(run.resolved[0]).toMatchObject({ by: "human", answers: [["Thorough"]] })
  }, 60_000)

  test("a Unit's question tool call becomes a Run interaction (question-tool wrapper)", async () => {
    await attach()
    const { runId } = await w().startRun({ name: "unit-question" })
    const interaction = await pending(runId)
    console.log("unit question interaction:", JSON.stringify(interaction.questions))
    expect(interaction.origin).toBe("agent")
    expect(interaction.unitId).toBeTruthy()
    await w().replyInteraction({ runId, interactionId: interaction.interactionId, answers: interaction.questions.map(() => ["blue"]) })
    await settled(runId)
    const { result } = await w().getResult({ runId })
    console.log("attached unit question:", result)
    expect(String(result).toLowerCase()).toContain("blue")
  }, 240_000)

  test("a permission ask is published and 'Allow once' lets the Unit read", async () => {
    await attach()
    const { runId } = await w().startRun({ name: "permission" })
    const interaction = await pending(runId)
    expect(interaction.kind).toBe("permission")
    expect(interaction.permission.action).toBe("read")
    await w().replyInteraction({ runId, interactionId: interaction.interactionId, answers: [["Allow once"]] })
    await settled(runId)
    const { result } = await w().getResult({ runId })
    console.log("attached permission:", result)
    expect(String(result)).toContain("secret-line-42")
  }, 240_000)

  test("an inline Workflow waits for approval; 'Run once' runs it", async () => {
    await attach()
    const source = `import { defineWorkflow } from "opencode-dynamic-workflows/workflow"\nexport default defineWorkflow({ meta: { name: "inline-y", description: "d" }, async run() { return "approved-ran" } })`
    const { runId } = await w().startRun({ source })
    const interaction = await pending(runId)
    expect(interaction.kind).toBe("approval")
    expect(interaction.approval.preview).toContain("inline-y")
    expect((await w().getRun({ runId })).run.status).toBe("queued")
    await w().replyInteraction({ runId, interactionId: interaction.interactionId, answers: [["Run once"]] })
    await settled(runId, 30_000)
    expect((await w().getResult({ runId })).result).toBe("approved-ran")
  }, 60_000)

  test("stop mid-run, then resume replays the finished Unit and the recorded answer", async () => {
    await attach()
    const { runId } = await w().startRun({ name: "slow" })
    await pending(runId)
    await w().stopRun({ runId })
    const stopped = await settled(runId, 30_000)
    expect(stopped.status).toBe("stopped")
    const journal = JSON.parse(await readFile(path.join(server.project, ".opencode/workflows/runs", runId, "run.json"), "utf8"))
    expect(journal.run.status).toBe("stopped")

    const resumed = await w().resumeRun({ runId })
    const interaction = await pending(resumed.runId)
    await w().replyInteraction({ runId: resumed.runId, interactionId: interaction.interactionId, answers: [["Yes"]] })
    const run = await settled(resumed.runId)
    expect(run.status).toBe("succeeded")
    expect(run.resumeOf).toBe(runId)
    expect(run.units[0].status).toBe("replayed")
    expect(run.units[1].status).toBe("succeeded")
  }, 240_000)
})

describe("live: gateway", () => {
  const base = () => `http://127.0.0.1:${server.gatewayPort}`

  test("loopback reads work without a token; control needs one; foreign origins are refused", async () => {
    const info = (await (await fetch(`${base()}/v1/info`)).json()) as any
    expect(info.protocol).toBe(1)
    expect(info.locations).toHaveLength(1)
    const runs = (await (await fetch(`${base()}/v1/runs`)).json()) as any
    expect(runs.runs.length).toBeGreaterThan(0)

    expect((await fetch(`${base()}/v1/runs`, { method: "POST", body: JSON.stringify({ name: "noask" }) })).status).toBe(401)
    expect((await fetch(`${base()}/v1/pair/local`, { method: "POST", headers: { origin: "http://evil.example" } })).status).toBe(403)
    expect((await fetch(`${base()}/v1/info`, { headers: { host: "evil.example" } })).status).toBe(403)

    const paired = (await (await fetch(`${base()}/v1/pair/local`, { method: "POST", headers: { origin: base() } })).json()) as any
    expect(paired.token).toStartWith("wfg_")
    const started = await fetch(`${base()}/v1/runs`, { method: "POST", headers: { authorization: `Bearer ${paired.token}`, "content-type": "application/json" }, body: JSON.stringify({ name: "noask" }) })
    expect(started.status).toBe(202)
    const { runId } = (await started.json()) as any
    await settled(runId, 30_000)
  })

  test("SSE streams protocol events and resumes from Last-Event-ID", async () => {
    const controller = new AbortController()
    const response = await fetch(`${base()}/v1/events`, { signal: controller.signal, headers: { "last-event-id": "0" } })
    expect(response.headers.get("content-type")).toContain("text/event-stream")
    const reader = response.body!.getReader()
    let text = ""
    const deadline = Date.now() + 5_000
    while (!text.includes("event: run.started") && Date.now() < deadline) {
      const { value, done } = await reader.read()
      if (done) break
      text += new TextDecoder().decode(value)
    }
    controller.abort()
    expect(text).toContain("event: run.started")
    expect(text).toMatch(/id: [0-9a-f]+\.\d+/)

    // An id from another epoch (a restarted service) is answered with resync.required, not a silent replay.
    const stale = new AbortController()
    const again = await fetch(`${base()}/v1/events`, { signal: stale.signal, headers: { "last-event-id": "deadbeef.1" } })
    const staleReader = again.body!.getReader()
    let more = ""
    for (let i = 0; i < 5 && !more.includes("resync.required"); i++) more += new TextDecoder().decode((await staleReader.read()).value)
    stale.abort()
    expect(more).toContain("event: resync.required")
    expect(more).toContain("the service restarted")
  })

  test("the tool result links to the run page, which the gateway serves", async () => {
    const { messages } = await drive(server, 'Call the workflow tool with {"name":"noask"}. Then reply with its summary line only.')
    const output = toolOutput(messages, "workflow") ?? ""
    const link = output.match(/http:\/\/127\.0\.0\.1:\d+\/runs\/[0-9a-f-]{36}/)?.[0]
    expect(link).toBeTruthy()
    const page = await fetch(link!)
    expect(page.status).toBe(200)
    expect(page.headers.get("content-security-policy")).toContain("default-src 'self'")
  }, 240_000)
})

describe("live: service restart", () => {
  test("a Run killed with the service reads back interrupted and resumes from its journal", async () => {
    await w().attach({ surface: "live-test", ttlMs: 120_000 })
    const { runId } = await w().startRun({ name: "slow" })
    await pending(runId)
    await server.restart()
    const run = await until(async () => {
      try {
        const { run } = await w().getRun({ runId })
        return run.status === "interrupted" ? run : undefined
      } catch {
        return undefined
      }
    }, 60_000, 500)
    expect(run.units[0].status).toBe("succeeded")

    await w().attach({ surface: "live-test", ttlMs: 120_000 })
    const resumed = await w().resumeRun({ runId })
    const interaction = await pending(resumed.runId)
    await w().replyInteraction({ runId: resumed.runId, interactionId: interaction.interactionId, answers: [["Yes"]] })
    const done = await settled(resumed.runId)
    expect(done.status).toBe("succeeded")
    expect(done.units[0].status).toBe("replayed")
  }, 240_000)
})
