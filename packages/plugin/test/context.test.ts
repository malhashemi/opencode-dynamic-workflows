import { describe, expect, it } from "bun:test"
import { z, type AskQuestion } from "@opencode-ai/workflow"
import { createAskRegistry, createEngineState, createWorkflowContext } from "../src/context"
import { createRunStore, type RunSnapshot } from "../src/runs"
import { makeFakeClient } from "./fake-client"

describe("createWorkflowContext", () => {
  it("exposes args verbatim", () => {
    const state = createEngineState()
    const ctx = createWorkflowContext({
      client: makeFakeClient(),
      parentSessionID: "p",
      args: { topic: "auth" },
      state,
    })
    expect(ctx.args).toEqual({ topic: "auth" })
  })

  it("agent() returns the Unit text and counts the Unit", async () => {
    const state = createEngineState()
    const ctx = createWorkflowContext({
      client: makeFakeClient({ reply: "DONE" }),
      parentSessionID: "p",
      args: undefined,
      state,
    })
    const out = await ctx.agent("go", { subagent: "general" })
    expect(out).toBe("DONE")
    expect(state.unitCount).toBe(1)
    expect(state.errors).toHaveLength(0)
  })

  it("agent() returns null and records an error when the Unit fails", async () => {
    const state = createEngineState()
    const ctx = createWorkflowContext({
      client: makeFakeClient({ promptError: "boom" }),
      parentSessionID: "p",
      args: undefined,
      state,
    })
    const out = await ctx.agent("go", { subagent: "writer" })
    expect(out).toBeNull()
    expect(state.errors).toEqual([{ unit: "writer", prompt: "go", subagent: "writer", error: "boom" }])
  })

  it("records `unit` as the label when one is given, else the subagent", async () => {
    const state = createEngineState()
    const ctx = createWorkflowContext({
      client: makeFakeClient({ promptError: "x" }),
      parentSessionID: "p",
      args: undefined,
      state,
    })
    await ctx.agent("a", { subagent: "writer", label: "draft-intro" })
    await ctx.agent("b", { subagent: "writer" })
    expect(state.errors.map((e) => e.unit)).toEqual(["draft-intro", "writer"])
    expect(ctx.errors).toBe(state.errors) // live view, not a copy
  })

  it("log() and phase() accumulate into state and fire events", () => {
    const state = createEngineState()
    const logged: string[] = []
    const phased: string[] = []
    const ctx = createWorkflowContext({
      client: makeFakeClient(),
      parentSessionID: "p",
      args: undefined,
      state,
      events: { onLog: (m) => logged.push(m), onPhase: (t) => phased.push(t) },
    })
    ctx.phase("Scan")
    ctx.log("looking")
    expect(state.phases).toEqual(["Scan"])
    expect(state.currentPhase).toBe("Scan")
    expect(state.logs).toEqual(["looking"])
    expect(logged).toEqual(["looking"])
    expect(phased).toEqual(["Scan"])
  })

  it("fires onUnitStart with the resolved subagent and current phase", async () => {
    const state = createEngineState()
    const starts: { subagent: string; phase: string | null }[] = []
    const ctx = createWorkflowContext({
      client: makeFakeClient({ reply: "x" }),
      parentSessionID: "p",
      args: undefined,
      state,
      events: { onUnitStart: (i) => starts.push({ subagent: i.subagent, phase: i.phase }) },
    })
    ctx.phase("Review")
    await ctx.agent("y")
    expect(starts).toEqual([{ subagent: "general", phase: "Review" }])
  })
})

describe("ctx.agent — structured output", () => {
  const Finding = z.object({ title: z.string(), score: z.number() })

  it("resolves to the typed object and a downstream stage computes on its fields without re-parsing", async () => {
    const state = createEngineState()
    const ctx = createWorkflowContext({
      client: makeFakeClient({ structured: { title: "Race", score: 7 } }),
      parentSessionID: "p",
      args: undefined,
      state,
    })
    const finding = await ctx.agent("rate it", { schema: Finding })
    expect(finding).not.toBeNull()
    // No re-parse: read the fields straight off the result (the typed-return AC).
    expect(finding && finding.score * 2).toBe(14)
    expect(finding?.title.toUpperCase()).toBe("RACE")
    expect(state.unitCount).toBe(1)
    expect(state.errors).toHaveLength(0)
  })

  it("drops to null + records ctx.errors when structured output never complies (after retries)", async () => {
    const state = createEngineState()
    const ctx = createWorkflowContext({
      client: makeFakeClient({ structuredError: "would not call the tool" }),
      parentSessionID: "p",
      args: undefined,
      state,
    })
    const out = await ctx.agent("rate it", { schema: Finding, label: "rater", retries: 1 })
    expect(out).toBeNull()
    expect(state.errors).toHaveLength(1)
    expect(state.errors[0]).toMatchObject({ unit: "rater", prompt: "rate it" })
    expect(state.errors[0]?.error).toContain("would not call the tool")
    expect(state.units[0]).toMatchObject({ ok: false })
  })

  it("threads `retries` through to the engine retry loop", async () => {
    const state = createEngineState()
    const client = makeFakeClient({ structuredError: "nope" })
    const ctx = createWorkflowContext({ client, parentSessionID: "p", args: undefined, state })
    await ctx.agent("x", { schema: Finding, retries: 2 })
    expect(client.promptCalls).toHaveLength(3) // 1 + 2 retries — proves the option reached runAgent
  })
})

describe("ctx.parallel", () => {
  it("runs thunks concurrently and returns results positionally aligned", async () => {
    const state = createEngineState()
    const ctx = createWorkflowContext({
      client: makeFakeClient(),
      parentSessionID: "p",
      args: undefined,
      state,
    })
    const out = await ctx.parallel([
      async () => "a",
      async () => "b",
      async () => "c",
    ])
    expect(out).toEqual(["a", "b", "c"])
  })

  it("turns a failed agent() Unit into a null slot recorded with a rich ctx.errors entry", async () => {
    const state = createEngineState()
    const ctx = createWorkflowContext({
      client: makeFakeClient({ promptError: "down" }),
      parentSessionID: "p",
      args: undefined,
      state,
    })
    const out = await ctx.parallel([
      () => ctx.agent("first", { label: "u1", subagent: "writer" }),
      () => ctx.agent("second", { label: "u2", subagent: "writer" }),
    ])
    expect(out).toEqual([null, null])
    expect(ctx.errors.map((e) => e.unit)).toEqual(["u1", "u2"])
    expect(ctx.errors.every((e) => e.error.includes("down") && e.subagent === "writer")).toBe(true)
  })

  it("captures a thunk that THROWS as a null slot + a ctx.errors entry (fan-out not aborted)", async () => {
    const state = createEngineState()
    const ctx = createWorkflowContext({
      client: makeFakeClient(),
      parentSessionID: "p",
      args: undefined,
      state,
    })
    const out = await ctx.parallel<string>([
      async () => "ok",
      async () => {
        throw new Error("kaboom")
      },
    ])
    expect(out[0]).toBe("ok")
    expect(out[1]).toBeNull()
    expect(ctx.errors).toHaveLength(1)
    expect(ctx.errors[0]?.error).toContain("kaboom")
    expect(ctx.errors[0]?.unit).toContain("parallel")
  })

  it("falls back to the default cap (never drops) when concurrency is non-finite", async () => {
    const state = createEngineState()
    const ctx = createWorkflowContext({
      client: makeFakeClient(),
      parentSessionID: "p",
      args: undefined,
      state,
      concurrency: Number.NaN,
    })
    const out = await ctx.parallel([async () => "a", async () => "b", async () => "c"])
    expect(out).toEqual(["a", "b", "c"]) // not [null, null, null]
    expect(ctx.errors).toHaveLength(0)
  })

  it("bounds in-flight Units (agent calls) to meta.concurrency via the shared limiter", async () => {
    const state = createEngineState()
    const client = makeFakeClient({ delayMs: 5 })
    const ctx = createWorkflowContext({
      client,
      parentSessionID: "p",
      args: undefined,
      state,
      concurrency: 2,
    })
    // The cap lives on the Unit (every agent() draws from the one shared limiter), so a fan-out of six Units
    // never runs more than two prompts at once — regardless of how the thunks are issued.
    await ctx.parallel(Array.from({ length: 6 }, (_unused, i) => () => ctx.agent(`u${i}`)))
    expect(client.meter.peak).toBe(2)
  })
})

describe("ctx.collect", () => {
  it("drops null slots from a parallel result", () => {
    const state = createEngineState()
    const ctx = createWorkflowContext({
      client: makeFakeClient(),
      parentSessionID: "p",
      args: undefined,
      state,
    })
    expect(ctx.collect(["a", null, "b", null, "c"])).toEqual(["a", "b", "c"])
    expect(ctx.collect<string>([])).toEqual([])
  })
})

describe("ctx unit tracking (out-of-band visibility)", () => {
  it("records each Unit's child session id, label, ok, and fires onUnitSettled", async () => {
    const state = createEngineState()
    const seen: { sessionID: string | null; ok: boolean }[] = []
    const ctx = createWorkflowContext({
      client: makeFakeClient({ reply: "x", idPrefix: "ses" }),
      parentSessionID: "p",
      args: undefined,
      state,
      events: { onUnitSettled: (u) => seen.push({ sessionID: u.sessionID, ok: u.status === "ok" }) },
    })
    await ctx.agent("a", { subagent: "writer", label: "intro" })
    expect(state.units).toEqual([{ sessionID: "ses-1", label: "intro", subagent: "writer", phase: null, ok: true }])
    expect(seen).toEqual([{ sessionID: "ses-1", ok: true }])
  })

  it("records a failed Unit's session id with ok:false (created but prompt failed)", async () => {
    const state = createEngineState()
    const ctx = createWorkflowContext({
      client: makeFakeClient({ promptError: "boom", idPrefix: "ses" }),
      parentSessionID: "p",
      args: undefined,
      state,
    })
    await ctx.agent("a", { subagent: "writer" })
    expect(state.units[0]).toMatchObject({ sessionID: "ses-1", ok: false, subagent: "writer" })
  })

  it("accumulates units across a parallel fan-out", async () => {
    const state = createEngineState()
    const ctx = createWorkflowContext({
      client: makeFakeClient({ reply: "ok", idPrefix: "ses" }),
      parentSessionID: "p",
      args: undefined,
      state,
    })
    await ctx.parallel([() => ctx.agent("a"), () => ctx.agent("b"), () => ctx.agent("c")])
    expect(state.units).toHaveLength(3)
    expect(state.units.every((u) => u.ok && u.sessionID)).toBe(true)
    expect(new Set(state.units.map((u) => u.sessionID)).size).toBe(3) // distinct child sessions
  })
})

/**
 * `ctx.ask` — the script's own question, and the reason the primitive exists.
 *
 * `meta.args` is fixed before a run starts, so it can offer "fast or thorough?" but not *"planning found 6
 * areas — 12 units — fast or thorough?"*. These cover the four ways that question can end: a human answers it,
 * the grace runs out, nobody is attached, or the run is stopped. The last three all resolve to the fallback,
 * which is exactly what makes the primitive safe to put in a workflow that will also run in CI.
 */
describe("ctx.ask", () => {
  const FORM: AskQuestion[] = [
    {
      header: "Depth",
      prompt: "Planning found 6 areas. Fast or thorough?",
      options: [
        { label: "fast", description: "One unit per area" },
        { label: "thorough", description: "Two units per area" },
      ],
    },
  ]

  function harness(options: { attached?: boolean; signal?: AbortSignal } = {}) {
    const store = createRunStore()
    const run: RunSnapshot = {
      runId: "run-ask",
      workflow: "planner",
      provenance: "inline",
      parentSessionID: "ses_parent",
      status: "running",
      phases: [],
      phasesDeclared: false,
      currentPhase: null,
      units: [],
      logs: [],
      errors: [],
      interactions: [],
      tokensSpent: 0,
      startedAt: Date.now(),
      endedAt: null,
    }
    store.create(run)
    const registry = createAskRegistry({
      store,
      attached: () => options.attached ?? true,
      signal: options.signal ?? new AbortController().signal,
      defaultGraceMs: 50,
    })
    const ctx = createWorkflowContext({
      client: makeFakeClient(),
      parentSessionID: "ses_parent",
      args: undefined,
      state: createEngineState(),
      ask: registry,
      runId: "run-ask",
    })
    const pending = () => store.get("run-ask")?.interactions ?? []
    return { store, registry, ctx, pending }
  }

  it("publishes the question as run state, then resolves to the human's answer", async () => {
    const { registry, ctx, pending } = harness()
    const answered = ctx.ask(FORM, { fallback: [["fast"]], graceMs: 10_000 })
    await Bun.sleep(5)

    expect(pending()).toHaveLength(1)
    const interaction = pending()[0]!
    // A script question is the SAME shape as an agent one — one pane renders both.
    expect(interaction.origin).toBe("script")
    expect(interaction.kind).toBe("question")
    expect(interaction.unitId).toBeNull()
    expect(interaction.depth).toBe(1)
    expect(interaction.questions[0]?.prompt).toContain("6 areas")
    expect(interaction.graceEndsAt).toBeGreaterThan(interaction.raisedAt)

    expect(registry.resolve(interaction.requestID, [["thorough"]])).toBe(true)
    expect(await answered).toEqual([["thorough"]])
    // Answered means gone: no surface should keep offering a question nobody is waiting on.
    expect(pending()).toHaveLength(0)
  })

  it("matches an answer to the offered labels, and refuses one that is not among them", async () => {
    const { registry, ctx, pending } = harness()
    const answered = ctx.ask(FORM, { fallback: [["fast"]], graceMs: 10_000 })
    await Bun.sleep(5)
    const requestID = pending()[0]!.requestID

    expect(registry.resolve(requestID, [["sideways"]])).toBe(false)
    expect(registry.resolve(requestID, [["fast", "thorough"]])).toBe(false) // not a multiple-choice question
    expect(pending()).toHaveLength(1) // still the human's to answer

    // Case-insensitive in, canonical out — the host's own reply contract.
    expect(registry.resolve(requestID, [["THOROUGH"]])).toBe(true)
    expect(await answered).toEqual([["thorough"]])
  })

  it("falls back when the grace expires, without failing the run", async () => {
    const { ctx, pending } = harness()
    const answered = await ctx.ask(FORM, { fallback: [["fast"]], graceMs: 20 })
    expect(answered).toEqual([["fast"]])
    expect(pending()).toHaveLength(0)
  })

  it("falls back immediately when nothing is attached, and publishes nothing", async () => {
    const { ctx, pending } = harness({ attached: false })
    // No wait at all: a background run, `opencode serve`, and CI all have nobody to ask, and a workflow that
    // hangs waiting for an answer nobody will give is worse than one that proceeds on a stated default.
    expect(await ctx.ask(FORM, { fallback: [["thorough"]], graceMs: 60_000 })).toEqual([["thorough"]])
    expect(pending()).toHaveLength(0)
  })

  it("falls back when the run is aborted mid-question", async () => {
    const controller = new AbortController()
    const { ctx, pending } = harness({ signal: controller.signal })
    const answered = ctx.ask(FORM, { fallback: [["fast"]], graceMs: 60_000 })
    await Bun.sleep(5)
    expect(pending()).toHaveLength(1)
    controller.abort()
    expect(await answered).toEqual([["fast"]])
    expect(pending()).toHaveLength(0)
  })

  it("hands a question back to its declared fallback on `reject`", async () => {
    const { registry, ctx, pending } = harness()
    const answered = ctx.ask(FORM, { fallback: [["fast"]], graceMs: 60_000 })
    await Bun.sleep(5)
    expect(registry.reject(pending()[0]!.requestID)).toBe(true)
    expect(await answered).toEqual([["fast"]])
  })

  it("rejects a fallback that is not itself a valid answer", async () => {
    const { ctx } = harness()
    // An authoring bug, and one that would otherwise only surface headlessly — i.e. in production.
    await expect(ctx.ask(FORM, { fallback: [["maybe"]] })).rejects.toThrow(/offered labels/)
    await expect(ctx.ask(FORM, { fallback: [] })).rejects.toThrow(/offered labels/)
  })

  it("returns one entry per question, in order, for a multi-part form", async () => {
    const { registry, ctx, pending } = harness()
    const form: AskQuestion[] = [
      { header: "A", prompt: "first?", options: [{ label: "a1", description: "" }] },
      { header: "B", prompt: "second?", options: [{ label: "b1", description: "" }] },
    ]
    const answered = ctx.ask(form, { fallback: [["a1"], ["b1"]], graceMs: 10_000 })
    await Bun.sleep(5)
    expect(pending()[0]?.questions).toHaveLength(2)
    expect(registry.resolve(pending()[0]!.requestID, [["a1"], ["b1"]])).toBe(true)
    expect(await answered).toEqual([["a1"], ["b1"]])
  })

  it("resolves to the fallback with no registry at all — the headless contract, stated once", async () => {
    const ctx = createWorkflowContext({
      client: makeFakeClient(),
      parentSessionID: "p",
      args: undefined,
      state: createEngineState(),
    })
    expect(await ctx.ask(FORM[0] as AskQuestion, { fallback: [["fast"]] })).toEqual([["fast"]])
  })
})
