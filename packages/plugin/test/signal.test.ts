/**
 * `ctx.signal` is the Run's abort signal, threaded into the shared limiter AND into each Unit (D11): aborting
 * drops QUEUED Units and interrupts the IN-FLIGHT Unit's session; each drops to null + ctx.errors (D9).
 */
import { describe, expect, test } from "bun:test"

import { makeCtx } from "./helpers"

describe("ctx.signal (abort)", () => {
  test("exposes the run's abort signal", () => {
    const controller = new AbortController()
    const { ctx } = makeCtx({}, { signal: controller.signal })
    expect(ctx.signal).toBe(controller.signal)
    expect(ctx.signal.aborted).toBe(false)
  })

  test("defaults to a never-aborted signal when the caller passes none", () => {
    const { ctx } = makeCtx()
    expect(ctx.signal).toBeInstanceOf(AbortSignal)
    expect(ctx.signal.aborted).toBe(false)
  })

  test("aborting interrupts the IN-FLIGHT Unit AND drops the queued ones (all null + ctx.errors)", async () => {
    const controller = new AbortController()
    const { ctx, host, state } = makeCtx({ reply: { hang: true } }, { concurrency: 1, signal: controller.signal })
    const pA = ctx.agent("A", { label: "A" })
    const pB = ctx.agent("B", { label: "B" })
    const pC = ctx.agent("C", { label: "C" })
    await new Promise((r) => setTimeout(r, 5))
    controller.abort()
    const [a, b, c] = await Promise.all([pA, pB, pC])
    expect([a, b, c]).toEqual([null, null, null])
    expect(ctx.errors.map((e) => e.unit).toSorted()).toEqual(["A", "B", "C"])
    expect(host.prompts.map((p) => p.text)).toEqual(["A"])
    expect(host.interrupts).toHaveLength(1)
    expect(state.errors.find((e) => e.unit === "A")?.error).toBe("unit aborted before completion")
  })

  test("an unexpected throw from an events callback PROPAGATES — not mislabeled as an aborted drop", async () => {
    const { ctx } = makeCtx(
      { reply: { text: "x" } },
      {
        events: {
          onUnit: (unit) => {
            if (unit.status === "running") throw new Error("callback bug")
          },
        },
      },
    )
    await expect(ctx.agent("go")).rejects.toThrow("callback bug")
    expect(ctx.errors).toHaveLength(0)
  })
})
