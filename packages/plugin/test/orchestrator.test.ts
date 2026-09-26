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

describe("audit round 3 — a Run owns every Unit it started", () => {
  it("Units the script did not await are stopped and settled before run.ended", async () => {
    const { promise, store, runId, host, events } = await start(wf(`ctx.agent("stray"); await new Promise((r) => setTimeout(r, 10)); return "done"`), { host: { reply: { hang: true } } })
    expect((await promise).result).toBe("done")
    const run = store.get(runId)!
    expect(run.status).toBe("succeeded")
    expect(run.units[0]?.status).toBe("stopped")
    expect(host.interrupts).toHaveLength(1)
    const ended = events.find((e) => e.type === "run.ended")!.seq
    expect(events.filter((e) => e.type === "unit.updated").every((e) => e.seq < ended)).toBe(true)
    expect(run.logs.join("\n")).toContain("stopping 1 Unit(s) the script did not await")
  })
})

describe("audit round 5 — nothing outlives the Run", () => {
  it("an agent() call made after run returned fails fast (the Run's signal is aborted)", async () => {
    let late: Promise<unknown> | undefined
    const index = createUnitIndex()
    const host = createFakeHost(index)
    const store = createRunStore(project)
    const broker = createBroker({ store, attached: () => false })
    const { config } = await loadWorkflow(wf(`setTimeout(() => { (globalThis as any).__late = ctx.agent("late") }, 20); return "done"`), { cacheDir })
    await runWorkflow({ config, source: "", identity: { key: null, name: "t", description: "", provenance: "inline" }, host, index, broker, store, runId: "late-run", parentSessionID: "p", location: project })
    await new Promise((resolve) => setTimeout(resolve, 40))
    late = (globalThis as any).__late
    expect(await late).toBeNull()
    expect(host.creates).toHaveLength(0)
  })
})

describe("nested Workflows — ctx.workflow", () => {
  async function startWith(parent: string, children: Record<string, string>, host: FakeHostOptions = {}) {
    const index = createUnitIndex()
    const fake = createFakeHost(index, host)
    const store = createRunStore(project)
    const broker = createBroker({ store, attached: () => false })
    const { config } = await loadWorkflow(parent, { cacheDir })
    const runId = crypto.randomUUID()
    const promise = runWorkflow({
      config, source: parent, identity: { key: null, name: config.meta.name, description: "", provenance: "inline" },
      host: fake, index, broker, store, runId, parentSessionID: "p", location: project,
      resolveWorkflow: async (name) => {
        if (!children[name]) throw new Error(`no saved Workflow named "${name}"`)
        return (await loadWorkflow(children[name]!, { cacheDir })).config
      },
    })
    return { promise, store, runId, host: fake }
  }
  const child = (body: string, meta = "") =>
    `import { defineWorkflow, z } from "@opencode-ai/workflow"\nexport default defineWorkflow({ meta: { name: "child", description: "d"${meta} }, async run(ctx) { ${body} } })\n`

  it("runs a saved Workflow as a step, sharing the Run, with prefixed labels and phases", async () => {
    const { promise, store, runId } = await startWith(
      wf(`const r = await ctx.workflow("kid", { n: 2 }); return { r }`),
      { kid: child(`ctx.phase("inner"); return ctx.agent("hello " + ctx.args.n, { label: "greet" })`, `, args: z.object({ n: z.number() })`) },
    )
    expect((await promise).result).toEqual({ r: "hello 2" })
    const run = store.get(runId)!
    expect(run.units.map((u) => [u.label, u.phase, u.ordinal])).toEqual([["kid › greet", "kid › inner", 1]])
    expect(run.logs.join("\n")).toContain("▸ kid")
  })

  it("invalid child args throw into the parent script; nesting deeper throws", async () => {
    const { promise } = await startWith(
      wf(`let a = "", b = ""; try { await ctx.workflow("kid", { n: "x" }) } catch (e) { a = String(e) } try { await ctx.workflow("deep") } catch (e) { b = String(e) } return { a, b }`),
      { kid: child(`return 1`, `, args: z.object({ n: z.number() })`), deep: child(`return ctx.workflow("kid", { n: 1 })`) },
    )
    const { result } = (await promise) as { result: { a: string; b: string } }
    expect(result.a).toContain("invalid args")
    expect(result.b).toContain("one level only")
  })
})
