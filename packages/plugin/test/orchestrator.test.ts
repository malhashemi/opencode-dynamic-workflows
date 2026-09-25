import { afterAll, describe, expect, it } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { createBroker } from "../src/broker"
import { createJournal, journalRoot, subscribeJournal } from "../src/journal"
import { loadWorkflow } from "../src/loader"
import {
  InvalidArgsError,
  previewResult,
  resolveAskGrace,
  resolveBudget,
  resolvePermissionPolicy,
  resolveUnitTimeout,
  runWorkflow,
} from "../src/orchestrator"
import type { ProtocolEvent } from "../src/protocol"
import { createRunStore } from "../src/runs"
import { createUnitIndex } from "../src/units"
import { createFakeHost, type FakeHostOptions } from "./fake-host"

const cacheDir = await mkdtemp(path.join(os.tmpdir(), "wf-orch-"))
const project = await mkdtemp(path.join(os.tmpdir(), "wf-orch-project-"))
afterAll(async () => {
  await rm(cacheDir, { recursive: true, force: true })
  await rm(project, { recursive: true, force: true })
})

async function start(source: string, options: { args?: unknown; host?: FakeHostOptions; journal?: boolean; attached?: boolean } = {}) {
  const index = createUnitIndex()
  const host = createFakeHost(index, options.host)
  const store = createRunStore(project)
  const journal = options.journal ? createJournal(journalRoot(project), { onError: () => {} }) : null
  if (journal) subscribeJournal(store, journal)
  const broker = createBroker({ store, attached: () => options.attached ?? false })
  const events: ProtocolEvent[] = []
  store.subscribe((event) => events.push(event))
  const { config } = await loadWorkflow(source, { cacheDir })
  const runId = crypto.randomUUID()
  let stop: ((reason?: string) => void) | undefined
  const promise = runWorkflow({
    config,
    source,
    identity: { key: null, name: config.meta.name, description: config.meta.description, provenance: "inline" },
    args: options.args,
    host,
    index,
    broker,
    store,
    journal,
    runId,
    parentSessionID: "ses_parent",
    location: project,
    instance: "test",
    onRegister: (_id, s) => (stop = s),
  })
  return { promise, store, runId, host, events, journal, stop: () => stop?.("stopped by test") }
}

const wf = (body: string, meta = "") =>
  `import { defineWorkflow, z } from "@opencode-ai/workflow"\nexport default defineWorkflow({ meta: { name: "t", description: "d"${meta} }, async run(ctx) { ${body} } })\n`

describe("runWorkflow", () => {
  it("runs, records Units, ends succeeded with a result preview", async () => {
    const { promise, store, runId, events } = await start(wf(`const a = await ctx.agent("one"); ctx.log("did one"); return { a }`))
    const out = await promise
    expect(out.result).toEqual({ a: "one" })
    const run = store.get(runId)!
    expect(run.status).toBe("succeeded")
    expect(run.error).toBeNull()
    expect(run.units).toHaveLength(1)
    expect(run.resultPreview).toBe('{"a":"one"}')
    expect(run.logs).toEqual(["did one"])
    expect(events.map((e) => e.type)).toContain("run.ended")
  })

  it("validates args before any Unit launches", async () => {
    const { promise, store, runId, host } = await start(wf(`return ctx.agent("x")`, `, args: z.object({ n: z.number() })`), { args: { n: "no" } })
    await expect(promise).rejects.toBeInstanceOf(InvalidArgsError)
    expect(host.creates).toHaveLength(0)
    expect(store.get(runId)!.status).toBe("failed")
    expect(store.get(runId)!.logs.at(-1)).toContain("invalid args: n:")
  })

  it("no args runs a Workflow whose args all have defaults", async () => {
    const { promise } = await start(wf(`return ctx.args`, `, args: z.object({ n: z.number().default(3) })`))
    expect((await promise).result).toEqual({ n: 3 })
  })

  it("a throwing run fails the Run and rethrows", async () => {
    const { promise, store, runId } = await start(wf(`throw new Error("author bug")`))
    await expect(promise).rejects.toThrow("author bug")
    expect(store.get(runId)!.status).toBe("failed")
    expect(store.get(runId)!.error).toBe("author bug")
  })

  it("stop ends the Run as stopped and interrupts in-flight Units", async () => {
    const { promise, store, runId, host, stop } = await start(wf(`return ctx.agent("hang")`), { host: { reply: { hang: true } } })
    await new Promise((resolve) => setTimeout(resolve, 10))
    stop()
    await promise
    expect(store.get(runId)!.status).toBe("stopped")
    expect(host.interrupts).toHaveLength(1)
    expect(store.get(runId)!.units[0]?.status).toBe("stopped")
  })

  it("limits.maxUnits fails a runaway loop with a legible error", async () => {
    const { promise, store, runId } = await start(wf(`for (let i = 0; i < 50; i++) await ctx.agent("x" + i); return "done"`, `, limits: { maxUnits: 3 }`))
    await promise.catch(() => {})
    const run = store.get(runId)!
    expect(run.status).toBe("failed")
    expect(run.logs.join("\n")).toContain("limit reached: this Run tried to start more than 3 Units")
    expect(run.units.filter((u) => u.status === "succeeded")).toHaveLength(3)
  })

  it("journals the Run so it reads back after the process is gone", async () => {
    const { promise, runId, journal } = await start(wf(`return ctx.agent("hi")`), { journal: true })
    await promise
    await journal!.flush()
    const record = await journal!.read(runId)
    expect(record?.run.status).toBe("succeeded")
    expect(record?.result).toBe("hi")
    expect(record?.run.units[0]?.output).toBe("hi")
  })
})

describe("policy resolution", () => {
  it("has no default Unit timeout or ask grace", () => {
    expect(resolveUnitTimeout(undefined, undefined)).toBeUndefined()
    expect(resolveUnitTimeout(5, 9)).toBe(5)
    expect(resolveAskGrace(undefined)).toBeNull()
    expect(resolveAskGrace(-5)).toBe(0)
  })
  it("permission policy defaults to ask; `human` is a legacy alias", () => {
    expect(resolvePermissionPolicy({})).toBe("ask")
    expect(resolvePermissionPolicy({ interaction: { permissions: "human" } })).toBe("ask")
    expect(resolvePermissionPolicy({ interaction: { permissions: "auto" } })).toBe("auto")
  })
  it("budget: numbers are advisory, objects may be hard", () => {
    expect(resolveBudget({ budget: 10 })).toEqual({ total: 10, hard: false })
    expect(resolveBudget({ budget: { tokens: 10, hard: true } })).toEqual({ total: 10, hard: true })
    expect(resolveBudget({}, 7)).toEqual({ total: 7, hard: false })
  })
  it("previews long results", () => {
    expect(previewResult("x".repeat(500))).toHaveLength(400)
    expect(previewResult(undefined)).toBeNull()
  })
})
