import { afterEach, describe, expect, test } from "bun:test"
import { configureLimits, resetEngineGlobal, unitSlot } from "../src/engine-global"
import { makeCtx } from "./helpers"

afterEach(() => resetEngineGlobal())

describe("limits across Runs", () => {
  test("the process-wide cap holds even when a Run's own cap is higher", async () => {
    configureLimits(1, {})
    const { ctx, host } = makeCtx({ delayMs: 10 }, { concurrency: 4, slot: unitSlot })
    await ctx.parallel([1, 2, 3].map((n) => () => ctx.agent(`u${n}`)))
    expect(host.meter.peak).toBe(1)
  })

  test("a provider cap applies to that provider only", async () => {
    configureLimits(10, { capped: 1 })
    const { ctx, host } = makeCtx({ delayMs: 10 }, { concurrency: 6, slot: unitSlot })
    await ctx.parallel([
      ...[1, 2, 3].map((n) => () => ctx.agent(`c${n}`, { model: "capped/m" })),
      ...[1, 2, 3].map((n) => () => ctx.agent(`f${n}`, { model: "free/m" })),
    ])
    const cappedPeak = host.meter.peak
    expect(cappedPeak).toBeGreaterThanOrEqual(3) // the free ones ran alongside
    expect(cappedPeak).toBeLessThanOrEqual(4) // …but at most one capped Unit at a time
  })

  test("a stop while waiting for a slot ends the Unit and interrupts its idle session", async () => {
    configureLimits(1, {})
    const hold = await unitSlot(undefined, new AbortController().signal)
    const controller = new AbortController()
    const { ctx, host, state } = makeCtx({}, { signal: controller.signal, slot: unitSlot })
    const pending = ctx.agent("waits")
    await new Promise((resolve) => setTimeout(resolve, 10))
    controller.abort()
    expect(await pending).toBeNull()
    expect(host.prompts).toHaveLength(0)
    expect(host.interrupts).toEqual(["ses_fake_1"])
    expect(state.errors[0]?.error).toContain("aborted")
    hold()
  })
})
