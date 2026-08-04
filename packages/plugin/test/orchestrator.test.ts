import { describe, expect, it } from "bun:test"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import os from "node:os"
import type { SessionMessage } from "../src/client"
import type { Journal } from "../src/journal"
import { loadWorkflowConfig, resolveUnitTimeout, runWorkflow, runWorkflowFromFile } from "../src/orchestrator"
import { createRunStore, type RunSnapshot } from "../src/runs"
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
    expect(client.createCalls[0]).toEqual({ parentID: "parent-xyz", title: "wf:general" })
    expect(client.promptCalls[0]?.agent).toBe("general")
    expect(client.promptCalls[0]?.parts).toEqual([{ type: "text", text: "say: hi" }])
  })

  it("registers before execution and records ordered lifecycle plus done terminal state", async () => {
    const store = createRunStore()
    const events: string[] = []
    const unitIds: string[] = []
    store.subscribe((event) => {
      events.push(event.type)
      if (event.type === "unit.queued" || event.type === "unit.started" || event.type === "unit.settled") {
        unitIds.push(event.unit.unitId)
      }
    })
    await runWorkflow({
      source: ECHO_WORKFLOW,
      args: { word: "tracked" },
      client: makeFakeClient({ reply: "ok" }),
      parentSessionID: "parent-tracked",
      runId: "run-tracked",
      provenance: "durable",
      store,
    })

    expect(events).toEqual(["run.started", "run.log", "unit.queued", "unit.started", "unit.settled", "run.ended"])
    expect(new Set(unitIds).size).toBe(1)
    expect(store.get("run-tracked")).toMatchObject({
      workflow: "echo",
      provenance: "durable",
      parentSessionID: "parent-tracked",
      status: "done",
      endedAt: expect.any(Number),
      units: [{ status: "ok", sessionID: "child-1" }],
    })
  })

  it("keeps declared phases ordered while recording the current phase", async () => {
    const store = createRunStore()
    await runWorkflow({
      source: `import { defineWorkflow } from "@opencode-ai/workflow"
export default defineWorkflow({
  meta: { name: "phased", description: "phased", phases: [{ title: "Research" }, { title: "Synthesize" }] },
  async run({ phase }) { phase("Research"); phase("Synthesize"); return "done" },
})`,
      client: makeFakeClient(),
      parentSessionID: "p",
      runId: "run-phased",
      store,
    })

    expect(store.get("run-phased")).toMatchObject({
      status: "done",
      phases: ["Research", "Synthesize"],
      currentPhase: "Synthesize",
    })
  })

  it("marks a registered run failed when workflow author code throws", async () => {
    const store = createRunStore()
    await expect(
      runWorkflow({
        source: `import { defineWorkflow } from "@opencode-ai/workflow"
export default defineWorkflow({ meta: { name: "throws", description: "throws" }, async run() { throw new Error("author failure") } })`,
        client: makeFakeClient(),
        parentSessionID: "p",
        runId: "run-failed",
        store,
      }),
    ).rejects.toThrow("author failure")
    expect(store.get("run-failed")).toMatchObject({ status: "failed", endedAt: expect.any(Number) })
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
    expect(client.promptCalls[0]?.parts).toEqual([{ type: "text", text: "n=7" }])
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
    const prompts = client.promptCalls.map((p) => p.parts[0]?.text)
    expect(prompts).not.toContain("review:bad")
    expect(prompts).toContain("review:a")
    expect(prompts).toContain("review:b")
  })

  it("orchestrator starts watcher on run, stops on teardown", async () => {
    const client = makeFakeClient({
      sessions: [{ id: "nested-question-session", parentID: "p", title: "Nested question" }],
      pendingQuestions: [
        {
          id: "question-run-owned-depth-2",
          sessionID: "nested-question-session",
          questions: [
            {
              question: "Should the nested question be rejected?",
              header: "Nested question",
              options: [{ label: "Reject", description: "Phase-1 watcher floor" }],
            },
          ],
        },
      ],
    })
    const originalPermissionList = client.permission.list.bind(client.permission)
    const originalQuestionList = client.question.list.bind(client.question)
    let permissionListCalls = 0
    let questionListCalls = 0
    client.permission.list = async () => {
      permissionListCalls += 1
      return originalPermissionList()
    }
    client.question.list = async () => {
      questionListCalls += 1
      return originalQuestionList()
    }

    const run = runWorkflow({
      source: `import { defineWorkflow } from "@opencode-ai/workflow"
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
export default defineWorkflow({ meta: { name: "watcher-lifecycle", description: "waits for watcher poll" }, async run() { await sleep(650); return "done" } })`,
      client,
      parentSessionID: "p",
    })

    await waitFor(
      () => permissionListCalls > 0 && questionListCalls > 0 && client.questionRejects.length === 1,
      "watcher did not poll and reject the Run-owned nested question during the Run",
      800,
    )

    await expect(run).resolves.toMatchObject({ result: "done" })
    const callsAfterTeardown = { permissionListCalls, questionListCalls }
    await new Promise((resolve) => setTimeout(resolve, 350))

    expect(client.questionRejects).toEqual([{ requestID: "question-run-owned-depth-2" }])
    expect(permissionListCalls).toBe(callsAfterTeardown.permissionListCalls)
    expect(questionListCalls).toBe(callsAfterTeardown.questionListCalls)
  })

  it("production runWorkflow proxy-answers a Run-owned depth>=2 question through the tiered watcher", async () => {
    const client = makeFakeClient({
      reply: (call) => (call.agent === "explore" ? "EU" : "UNANSWERABLE"),
      sessions: [
        { id: "p", title: "Privacy launch Workflow Run" },
        { id: "launch-unit", parentID: "p", title: "Prepare deployment Unit" },
        { id: "nested-question-session", parentID: "launch-unit", title: "Nested deploy chooser" },
      ],
      sessionMessages: {
        p: firstUserMessage("Run the Workflow for the privacy-sensitive EU launch."),
        "launch-unit": firstUserMessage("Prepare launch using EU data residency because customers are in Germany."),
        "nested-question-session": firstUserMessage("The nested Subagent needs deployment region; the launch context says EU."),
      },
      pendingQuestions: [
        {
          id: "question-production-tiered-proxy",
          sessionID: "nested-question-session",
          questions: [
            {
              question: "Which deployment region should this launch use?",
              header: "Deployment region",
              options: [
                { label: "US", description: "Deploy in the United States" },
                { label: "EU", description: "Deploy in Europe" },
              ],
            },
          ],
        },
      ],
    })

    const run = runWorkflow({
      source: `import { defineWorkflow } from "@opencode-ai/workflow"
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
export default defineWorkflow({ meta: { name: "watcher-tiered-production", description: "waits for watcher poll" }, async run() { await sleep(650); return "done" } })`,
      client,
      parentSessionID: "p",
    })

    await waitFor(
      () => client.questionReplies.length + client.questionRejects.length >= 1,
      "production watcher did not resolve the Run-owned nested question during the Run",
      1_000,
    )

    await expect(run).resolves.toMatchObject({ result: "done" })
    expect(client.promptCalls.some((call) => call.agent === "explore")).toBe(true)
    expect(client.questionReplies).toEqual([{ requestID: "question-production-tiered-proxy", answers: [["EU"]] }])
    expect(client.questionRejects).not.toContainEqual({ requestID: "question-production-tiered-proxy" })
  })

  it("production runWorkflow defaults nested-question escalation to headless-safe reject on proxy abstain", async () => {
    const client = makeFakeClient({
      responses: [{ text: "UNANSWERABLE" }, { text: "EU" }],
      sessions: [
        { id: "p", title: "Headless Workflow Run" },
        { id: "launch-unit", parentID: "p", title: "Prepare deployment Unit" },
        { id: "nested-question-session", parentID: "launch-unit", title: "Nested deploy chooser" },
      ],
      sessionMessages: {
        p: firstUserMessage("Run the Workflow without an attached operator."),
        "launch-unit": firstUserMessage("Prepare launch but no deployment region is known."),
        "nested-question-session": firstUserMessage("The nested Subagent needs deployment region and no context answers it."),
      },
      pendingQuestions: [
        {
          id: "question-production-headless-default",
          sessionID: "nested-question-session",
          questions: [
            {
              question: "Which deployment region should this launch use?",
              header: "Deployment region",
              options: [
                { label: "US", description: "Deploy in the United States" },
                { label: "EU", description: "Deploy in Europe" },
              ],
            },
          ],
        },
      ],
    })

    const run = runWorkflow({
      source: `import { defineWorkflow } from "@opencode-ai/workflow"
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
export default defineWorkflow({ meta: { name: "watcher-tiered-headless-default", description: "waits for watcher poll" }, async run() { await sleep(650); return "done" } })`,
      client,
      parentSessionID: "p",
    })

    await waitFor(
      () => client.questionReplies.length + client.questionRejects.length >= 1,
      "production watcher did not resolve the headless Run-owned nested question during the Run",
      1_000,
    )

    await expect(run).resolves.toMatchObject({ result: "done" })
    expect(client.promptCalls.map((call) => call.agent)).toEqual(["explore"])
    expect(client.createCalls.map((call) => call.title)).toEqual(["wf:explore"])
    expect(client.questionReplies).toEqual([])
    expect(client.questionRejects).toEqual([{ requestID: "question-production-headless-default" }])
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

describe("resolveUnitTimeout — a deadline is opt-in", () => {
  // Guarding a decision, not a computation. A Unit that runs for hours is this engine's normal case: it waits
  // on models, on humans, and across restarts. Reintroducing a default here silently caps all of that, and the
  // failure it produces (fail-fast, no retry, whole fan-out dying on the same second) looks like a model fault
  // rather than a policy — which is exactly how the last one survived as long as it did.
  it("is undefined when neither the Run nor the Workflow sets one", () => {
    expect(resolveUnitTimeout(undefined, undefined)).toBeUndefined()
  })

  it("prefers the Run's override, then the Workflow's", () => {
    expect(resolveUnitTimeout(10, 20)).toBe(10)
    expect(resolveUnitTimeout(undefined, 20)).toBe(20)
    expect(resolveUnitTimeout(10, undefined)).toBe(10)
  })
})

describe("runWorkflow — hung Unit recovery (timeout + abort, no infinite hang)", () => {
  it("times out a hung Unit (meta.unitTimeout) → null + recorded error; the Run still completes", async () => {
    const client = makeFakeClient({ hang: true })
    const out = await runWorkflow({
      source: `import { defineWorkflow } from "@opencode-ai/workflow"
export default defineWorkflow({ meta: { name: "hang", description: "x", unitTimeout: 30 }, async run({ agent }) { return { r: await agent("this will hang") } } })`,
      client,
      parentSessionID: "p",
    })
    expect(out.result).toEqual({ r: null }) // the hung Unit resolved to null instead of blocking
    expect(out.state.errors[0]?.error).toMatch(/exceeded its 30ms timeout/)
    // The message reports what happened and names the knob; it must NOT diagnose a cause the engine cannot
    // observe. Asserting the absence, because the old wording ("a subagent prompt hung") read as a finding and
    // sent a real investigation after a session that was healthy.
    expect(out.state.errors[0]?.error).toMatch(/meta\.unitTimeout/)
    expect(out.state.errors[0]?.error).not.toMatch(/hung|unanswered permission/)
    expect(client.abortCalls.length).toBeGreaterThan(0) // the child prompt was cancelled, not leaked
  })

  it("aborting the Run cancels an IN-FLIGHT hung Unit (not just queued ones)", async () => {
    const client = makeFakeClient({ hang: true })
    const ctrl = new AbortController()
    const store = createRunStore()
    const p = runWorkflow({
      // no short unitTimeout — only the abort can end this hang within the test
      source: `import { defineWorkflow } from "@opencode-ai/workflow"
export default defineWorkflow({ meta: { name: "hang2", description: "x" }, async run({ agent }) { return { r: await agent("hang") } } })`,
      client,
      parentSessionID: "p",
      signal: ctrl.signal,
      runId: "run-aborted",
      store,
    })
    await new Promise((r) => setTimeout(r, 25)) // let the Unit launch + begin its (hanging) prompt
    ctrl.abort()
    const out = await p
    expect(out.result).toEqual({ r: null })
    expect(out.state.errors[0]?.error).toMatch(/aborted/)
    expect(client.abortCalls.length).toBeGreaterThan(0)
    expect(store.get("run-aborted")).toMatchObject({ status: "aborted", endedAt: expect.any(Number) })
  })
})

/**
 * The two ends of a journaled run.
 *
 * The engine writes exactly two records itself — `begin` when the run exists, `finish` when it is terminal —
 * and the shape of both is what the retrieval modes and Phase 6's replay read back. The third property here is
 * the one that matters most: a journal that throws is a journal that gets ignored, not a run that fails.
 */
describe("runWorkflow (journal)", () => {
  interface Recorded {
    begin: { run: RunSnapshot; source: string; args: unknown }[]
    finish: { run: RunSnapshot; result: unknown }[]
    appended: string[]
  }

  function recorder(overrides: Partial<Journal> = {}): Journal & { recorded: Recorded } {
    const recorded: Recorded = { begin: [], finish: [], appended: [] }
    return {
      recorded,
      root: "/tmp/journal",
      async begin(run, input) {
        recorded.begin.push({ run, source: input.source, args: input.args })
      },
      async append(event) {
        recorded.appended.push(event.type)
      },
      async finish(run, result) {
        recorded.finish.push({ run, result })
      },
      async read() {
        return null
      },
      async list() {
        return []
      },
      ...overrides,
    }
  }

  it("opens the record with the run as registered and closes it with the terminal snapshot plus the result", async () => {
    const journal = recorder()
    const store = createRunStore()
    await runWorkflow({
      source: ECHO_WORKFLOW,
      args: { word: "hi" },
      client: makeFakeClient({ reply: "HELLO" }),
      parentSessionID: "p",
      runId: "run-journaled",
      store,
      journal,
    })

    expect(journal.recorded.begin).toHaveLength(1)
    expect(journal.recorded.begin[0]?.source).toBe(ECHO_WORKFLOW)
    expect(journal.recorded.begin[0]?.args).toEqual({ word: "hi" })
    expect(journal.recorded.begin[0]?.run).toMatchObject({ runId: "run-journaled", status: "running", units: [] })

    expect(journal.recorded.finish).toHaveLength(1)
    const closed = journal.recorded.finish[0]
    expect(closed?.result).toEqual({ out: "HELLO", word: "hi" })
    // The terminal snapshot, not the one `begin` saw: status, timing, units, and logs are all settled by now.
    expect(closed?.run).toMatchObject({ runId: "run-journaled", status: "done", logs: ["starting"] })
    expect(closed?.run.units).toHaveLength(1)
    expect(closed?.run.endedAt).toEqual(expect.any(Number))
    // Unit transitions are the store subscriber's job; the engine writes only the two ends.
    expect(journal.recorded.appended).toEqual([])
  })

  it("records the VALIDATED args, so a replay reproduces this run rather than a similar one", async () => {
    const journal = recorder()
    await runWorkflow({
      source: TYPED_WORKFLOW,
      args: { count: 3 },
      client: makeFakeClient(),
      parentSessionID: "p",
      journal,
    })
    expect(journal.recorded.begin[0]?.args).toEqual({ count: 3 })
  })

  it("records a failed run as failed, with no result", async () => {
    const journal = recorder()
    await expect(
      runWorkflow({
        source: `import { defineWorkflow } from "@opencode-ai/workflow"
export default defineWorkflow({ meta: { name: "boom", description: "x" }, async run() { throw new Error("nope") } })`,
        client: makeFakeClient(),
        parentSessionID: "p",
        journal,
      }),
    ).rejects.toThrow("nope")
    expect(journal.recorded.finish[0]?.run.status).toBe("failed")
    expect(journal.recorded.finish[0]?.result).toBeUndefined()
  })

  it("never lets a throwing journal fail the run", async () => {
    const journal = recorder({
      begin() {
        throw new Error("disk is on fire")
      },
      async finish() {
        throw new Error("still on fire")
      },
    })
    const out = await runWorkflow({
      source: ECHO_WORKFLOW,
      args: { word: "hi" },
      client: makeFakeClient({ reply: "HELLO" }),
      parentSessionID: "p",
      journal,
    })
    expect(out.result).toEqual({ out: "HELLO", word: "hi" })
  })

  it("writes nothing for a run that never registered — a rejected args set is not a run", async () => {
    const journal = recorder()
    await expect(
      runWorkflow({ source: TYPED_WORKFLOW, args: { count: "three" }, client: makeFakeClient(), parentSessionID: "p", journal }),
    ).rejects.toThrow(/invalid args/)
    expect(journal.recorded.begin).toEqual([])
    expect(journal.recorded.finish).toEqual([])
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

async function waitFor(predicate: () => boolean | Promise<boolean>, message: string, timeoutMs = 200): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await predicate()) return
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
  throw new Error(message)
}

function firstUserMessage(text: string): SessionMessage[] {
  return [{ info: { role: "user" }, parts: [{ type: "text", text }] }]
}
