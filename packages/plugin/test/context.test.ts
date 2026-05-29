import { describe, expect, it } from "bun:test"
import { createEngineState, createWorkflowContext } from "../src/context"
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

  it("bounds in-flight Units to meta.concurrency", async () => {
    const state = createEngineState()
    const ctx = createWorkflowContext({
      client: makeFakeClient(),
      parentSessionID: "p",
      args: undefined,
      state,
      concurrency: 2,
    })
    let inFlight = 0
    let peak = 0
    const thunks = Array.from({ length: 6 }, () => async () => {
      inFlight += 1
      peak = Math.max(peak, inFlight)
      await Bun.sleep(5)
      inFlight -= 1
      return 1
    })
    await ctx.parallel(thunks)
    expect(peak).toBe(2)
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
  it("records each Unit's child session id, label, ok, and fires onUnit", async () => {
    const state = createEngineState()
    const seen: { sessionID: string | null; ok: boolean }[] = []
    const ctx = createWorkflowContext({
      client: makeFakeClient({ reply: "x", idPrefix: "ses" }),
      parentSessionID: "p",
      args: undefined,
      state,
      events: { onUnit: (u) => seen.push({ sessionID: u.sessionID, ok: u.ok }) },
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
