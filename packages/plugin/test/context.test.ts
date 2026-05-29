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
    expect(state.errors).toEqual([{ prompt: "go", subagent: "writer", error: "boom" }])
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
