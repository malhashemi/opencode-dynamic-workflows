/**
 * Pipeline tests: `ctx.pipeline(items, ...stages)` runs each item down the stage chain independently — no
 * barrier between items (D4). These assert the no-barrier interleaving, the per-item throw→null+record model
 * (D9), that `collect` narrows the nulls away, and that pipeline + parallel draw Units from ONE shared limiter.
 */
import { describe, expect, test } from "bun:test"
import { createEngineState, createWorkflowContext } from "../src/context"
import { makeFakeClient, type FakeClientOptions } from "./fake-client"

function makeCtx(clientOpts?: FakeClientOptions, concurrency?: number) {
  const state = createEngineState()
  const client = makeFakeClient(clientOpts)
  const ctx = createWorkflowContext({ client, parentSessionID: "ses_parent", args: undefined, state, concurrency })
  return { ctx, state, client }
}

describe("ctx.pipeline", () => {
  test("runs each item through the stage chain with no barrier between items", async () => {
    const { ctx } = makeCtx()
    // A manual gate on item 0's stage 1: item 1 must be able to reach stage 2 while item 0 is still parked
    // in stage 1. If pipeline were a barrier, item 1 could not advance until item 0 cleared stage 1.
    let release0!: () => void
    const item0Parked = new Promise<void>((resolve) => (release0 = resolve))
    const reachedStage2: number[] = []

    const resultsP = ctx.pipeline(
      [0, 1],
      async (prev: number, _item, index) => {
        if (index === 0) await item0Parked // park item 0 in stage 1 until we release it
        return prev + 10
      },
      async (prev: number, _item, index) => {
        reachedStage2.push(index)
        return prev + 100
      },
    )

    // Give the event loop turns: item 1 should sail through stage 1 → stage 2 while item 0 is parked.
    await new Promise((r) => setTimeout(r, 5))
    expect(reachedStage2).toEqual([1]) // only item 1 has reached stage 2; item 0 is still parked (no barrier)

    release0()
    const results = await resultsP
    expect(results).toEqual([110, 111]) // 0+10+100, 1+10+100 — input order preserved
    expect(reachedStage2.sort()).toEqual([0, 1])
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
    expect(results).toEqual(["A!", null, "C!"]) // the failing item is null; order preserved; others complete
    expect(state.errors).toHaveLength(1)
    expect(state.errors[0]?.unit).toBe("pipeline#1") // identified by its index
    expect(state.errors[0]?.error).toContain("stage blew up on boom")
  })

  test("collect over pipeline results drops the dropped item, leaving a clean array for synthesis", async () => {
    const { ctx } = makeCtx()
    const results = await ctx.pipeline(
      ["keep", "drop", "keep2"],
      (item: string) => {
        if (item === "drop") throw new Error("nope")
        return item
      },
    )
    const survivors = ctx.collect(results)
    expect(survivors).toEqual(["keep", "keep2"]) // null dropped → typed string[] fit to feed a synthesis Unit
  })

  test("parallel and pipeline draw from ONE shared limiter — in-flight Units never exceed the cap", async () => {
    const { ctx, state, client } = makeCtx({ delayMs: 5 }, 2)

    // Two primitives launching Units at the same time, 8 Units total. With a single shared cap of 2, no more
    // than 2 prompts may be in flight at any instant — even though parallel and pipeline run concurrently.
    await Promise.all([
      ctx.parallel([() => ctx.agent("a"), () => ctx.agent("b"), () => ctx.agent("c"), () => ctx.agent("d")]),
      ctx.pipeline([1, 2, 3, 4], (n: number) => ctx.agent(`p${n}`)),
    ])

    expect(client.meter.peak).toBeLessThanOrEqual(2)
    expect(client.meter.peak).toBe(2) // with 8 Units + a real wait, the cap is actually reached
    expect(state.unitCount).toBe(8) // all eight Units actually ran
  })
})
