/**
 * Signal tests: `ctx.signal` exposes the Run's abort signal, threaded into the shared limiter AND into each
 * Unit's prompt (D11). Aborting a Run stops launching QUEUED Units (each drops to null + ctx.errors, D9) AND
 * cancels an IN-FLIGHT Unit's prompt via `session.abort` (so a hung subagent is freed, not left blocking) —
 * it too drops to null + ctx.errors. The adapter passes opencode's tool-abort signal in; with none, the engine
 * supplies a never-aborted default.
 */
import { describe, expect, test } from "bun:test"
import { createEngineState, createWorkflowContext } from "../src/context"
import { makeFakeClient } from "./fake-client"

describe("ctx.signal (abort)", () => {
  test("exposes the run's abort signal", () => {
    const controller = new AbortController()
    const state = createEngineState()
    const ctx = createWorkflowContext({
      client: makeFakeClient(),
      parentSessionID: "p",
      args: undefined,
      state,
      signal: controller.signal,
    })
    expect(ctx.signal).toBe(controller.signal)
    expect(ctx.signal.aborted).toBe(false)
  })

  test("defaults to a never-aborted signal when the caller passes none", () => {
    const state = createEngineState()
    const ctx = createWorkflowContext({ client: makeFakeClient(), parentSessionID: "p", args: undefined, state })
    expect(ctx.signal).toBeInstanceOf(AbortSignal)
    expect(ctx.signal.aborted).toBe(false)
  })

  test("aborting cancels the IN-FLIGHT Unit AND drops the queued ones (all null + ctx.errors)", async () => {
    const controller = new AbortController()
    const client = makeFakeClient({ delayMs: 25 })
    const state = createEngineState()
    const ctx = createWorkflowContext({
      client,
      parentSessionID: "p",
      args: undefined,
      state,
      concurrency: 1,
      signal: controller.signal,
    })
    // Unit A grabs the only permit and is in-flight (~25ms); B and C queue behind it on the limiter.
    const pA = ctx.agent("A", { label: "A" })
    const pB = ctx.agent("B", { label: "B" })
    const pC = ctx.agent("C", { label: "C" })
    await new Promise((r) => setTimeout(r, 5)) // A is in-flight; B and C are queued
    controller.abort()
    const [a, b, c] = await Promise.all([pA, pB, pC])

    expect(a).toBeNull() // in-flight prompt is now CANCELLED on abort (session.abort), not left to finish
    expect(b).toBeNull() // queued at abort — dropped
    expect(c).toBeNull()
    expect(ctx.errors.map((e) => e.unit).sort()).toEqual(["A", "B", "C"]) // all recorded, none silently dropped (D9)
    expect(client.promptCalls.map((p) => p.parts[0]?.text)).toEqual(["A"]) // only A ever reached the client
    expect(client.abortCalls).toHaveLength(1) // and A's in-flight child prompt was cancelled
  })

  test("an unexpected throw from an events callback PROPAGATES — not mislabeled as an aborted drop", async () => {
    const state = createEngineState()
    const ctx = createWorkflowContext({
      client: makeFakeClient({ reply: "x" }),
      parentSessionID: "p",
      args: undefined,
      state,
      events: {
        onUnitStart: () => {
          throw new Error("callback bug")
        },
      },
    })
    // The Unit launched (acquire succeeded); a buggy callback throwing must surface honestly, not vanish into a
    // null slot or get recorded as an aborted Unit. Distinguishes the AbortError path from a real engine bug.
    await expect(ctx.agent("go")).rejects.toThrow("callback bug")
    expect(ctx.errors).toHaveLength(0) // not misrecorded as a dropped Unit
  })
})
