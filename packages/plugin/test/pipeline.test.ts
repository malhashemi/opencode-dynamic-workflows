/**
 * `ctx.pipeline(items, ...stages)` runs each item down the stage chain independently — no barrier between items
 * (D4); a throwing stage drops that item to null and records it (D9); `collect` narrows; and pipeline and
 * parallel draw Units from ONE shared limiter (D5).
 */
import { describe, expect, test } from "bun:test"

import { makeCtx } from "./helpers"

describe("ctx.pipeline", () => {
  test("runs each item through the stage chain with no barrier between items", async () => {
    const { ctx } = makeCtx()
    let release0!: () => void
    const item0Parked = new Promise<void>((resolve) => (release0 = resolve))
    const reachedStage2: number[] = []
    const resultsP = ctx.pipeline(
      [0, 1],
      async (prev: number, _item, index) => {
        if (index === 0) await item0Parked
        return prev + 10
      },
      async (prev: number, _item, index) => {
        reachedStage2.push(index)
        return prev + 100
      },
    )
    await new Promise((r) => setTimeout(r, 5))
    expect(reachedStage2).toEqual([1])
    release0()
    expect(await resultsP).toEqual([110, 111])
    expect(reachedStage2.toSorted()).toEqual([0, 1])
  })

  test("a stage that throws drops that item to null + records it; other items complete", async () => {
    const { ctx, state } = makeCtx()
    const results = await ctx.pipeline(
      ["a", "boom", "c"],
      (item: string) => {
        if (item === "boom") throw new Error(`stage blew up on ${item}`)
        return item.toUpperCase()
      },
      (prev: string) => `${prev}!`,
    )
    expect(results).toEqual(["A!", null, "C!"])
    expect(state.errors).toHaveLength(1)
    expect(state.errors[0]?.unit).toBe("pipeline#1")
    expect(state.errors[0]?.error).toContain("stage blew up on boom")
  })

  test("collect over pipeline results drops the dropped item", async () => {
    const { ctx } = makeCtx()
    const results = await ctx.pipeline(["keep", "drop", "keep2"], (item: string) => {
      if (item === "drop") throw new Error("nope")
      return item
    })
    expect(ctx.collect(results)).toEqual(["keep", "keep2"])
  })

  test("parallel and pipeline draw from ONE shared limiter — in-flight Units never exceed the cap", async () => {
    const { ctx, state, host } = makeCtx({ delayMs: 5 }, { concurrency: 2 })
    await Promise.all([
      ctx.parallel([() => ctx.agent("a"), () => ctx.agent("b"), () => ctx.agent("c"), () => ctx.agent("d")]),
      ctx.pipeline([1, 2, 3, 4], (n: number) => ctx.agent(`p${n}`)),
    ])
    expect(host.meter.peak).toBeLessThanOrEqual(2)
    expect(host.meter.peak).toBe(2)
    expect(state.unitCount).toBe(8)
  })

  test("refuses more items than limits.maxItemsPerCall", async () => {
    const { ctx } = makeCtx({}, { limits: { maxItemsPerCall: 2 } })
    await expect(ctx.pipeline([1, 2, 3], (n: number) => n)).rejects.toThrow("maxItemsPerCall")
    await expect(ctx.parallel([async () => 1, async () => 2, async () => 3])).rejects.toThrow("maxItemsPerCall")
  })
})
