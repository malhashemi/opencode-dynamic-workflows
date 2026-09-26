import { afterEach, describe, expect, test } from "bun:test"

import { configureLimits, resetEngineGlobal, runSlot, unitSlot } from "../src/engine-global"
import { resolveConcurrency } from "../src/orchestrator"
import { makeCtx } from "./helpers"

afterEach(() => resetEngineGlobal())

describe("limits", () => {
  test("Units per Run default to 5; meta.concurrency can lower the cap, never raise it", () => {
    expect(resolveConcurrency(undefined)).toBe(5)
    expect(resolveConcurrency(2)).toBe(2)
    expect(resolveConcurrency(12)).toBe(5)
    expect(resolveConcurrency(12, 20)).toBe(12)
  })

  test("Run slots: the next Run waits until one ends, and a stop while waiting rejects", async () => {
    configureLimits(1, {})
    const first = await runSlot(new AbortController().signal)
    let second = false
    const waiting = runSlot(new AbortController().signal).then((release) => ((second = true), release))
    await new Promise((resolve) => setTimeout(resolve, 5))
    expect(second).toBe(false)
    first()
    ;(await waiting)()
    expect(second).toBe(true)
    const hold = await runSlot(new AbortController().signal)
    const controller = new AbortController()
    const stopped = runSlot(controller.signal)
    controller.abort()
    await expect(stopped).rejects.toThrow()
    hold()
  })

  test("a provider cap holds across Runs, and does not slow other providers", async () => {
    configureLimits(5, { capped: 1 })
    const a = makeCtx({ delayMs: 20 }, { concurrency: 3, slot: unitSlot })
    const b = makeCtx({ delayMs: 20 }, { concurrency: 3, slot: unitSlot })
    const started = Date.now()
    await Promise.all([
      a.ctx.parallel([1, 2].map((n) => () => a.ctx.agent(`c${n}`, { model: "capped/m" }))),
      b.ctx.parallel([1, 2].map((n) => () => b.ctx.agent(`c${n}`, { model: "capped/m" }))),
    ])
    expect(Date.now() - started).toBeGreaterThanOrEqual(75) // four capped Units, one at a time
    const free = Date.now()
    await a.ctx.parallel([1, 2, 3].map((n) => () => a.ctx.agent(`f${n}`, { model: "free/m" })))
    expect(Date.now() - free).toBeLessThan(55) // uncapped provider: in parallel
  })

  test("a stop while waiting for a provider slot ends the Unit and interrupts its idle session", async () => {
    configureLimits(5, { capped: 1 })
    const hold = await unitSlot("capped", new AbortController().signal)
    const controller = new AbortController()
    const { ctx, host, state } = makeCtx({}, { signal: controller.signal, slot: unitSlot })
    const pending = ctx.agent("waits", { model: "capped/m" })
    await new Promise((resolve) => setTimeout(resolve, 10))
    controller.abort()
    expect(await pending).toBeNull()
    expect(host.prompts).toHaveLength(0)
    expect(host.interrupts).toEqual(["ses_fake_1"])
    expect(state.errors[0]?.error).toContain("aborted")
    hold()
  })
})
