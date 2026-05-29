/**
 * Budget tests: `ctx.budget` is always present and ADVISORY (D10) — there is no engine hard-stop. `total` is
 * the caller's declared ceiling (or null when unset), `spent()` accumulates completed Units' output tokens,
 * and `remaining()` is `max(0, total - spent())` (or Infinity when no total). Output tokens are reported by the
 * client per prompt; the fake client returns a deterministic count so spent() is observable.
 */
import { describe, expect, test } from "bun:test"
import { createEngineState, createWorkflowContext } from "../src/context"
import { makeFakeClient } from "./fake-client"

describe("ctx.budget (advisory)", () => {
  test("total is null and remaining() is Infinity when the caller declares no budget", async () => {
    const state = createEngineState()
    const ctx = createWorkflowContext({
      client: makeFakeClient({ outputTokens: 10 }),
      parentSessionID: "p",
      args: undefined,
      state,
    })
    expect(ctx.budget.total).toBeNull()
    expect(ctx.budget.remaining()).toBe(Infinity)
    await ctx.agent("go")
    expect(ctx.budget.spent()).toBe(10) // spent still tracked even with no ceiling
    expect(ctx.budget.remaining()).toBe(Infinity)
  })

  test("spent() accumulates completed Units' output tokens; remaining() = total - spent()", async () => {
    const state = createEngineState()
    const ctx = createWorkflowContext({
      client: makeFakeClient({ outputTokens: 30 }),
      parentSessionID: "p",
      args: undefined,
      state,
      budget: 100,
    })
    expect(ctx.budget.total).toBe(100)
    expect(ctx.budget.spent()).toBe(0)
    expect(ctx.budget.remaining()).toBe(100)

    await ctx.agent("a")
    await ctx.agent("b")
    expect(ctx.budget.spent()).toBe(60) // 30 + 30
    expect(ctx.budget.remaining()).toBe(40)
  })

  test("a failed Unit contributes 0 to spent() (only completed Units count)", async () => {
    const state = createEngineState()
    const ctx = createWorkflowContext({
      client: makeFakeClient({ promptError: "down", outputTokens: 50 }),
      parentSessionID: "p",
      args: undefined,
      state,
      budget: 100,
    })
    const out = await ctx.agent("x")
    expect(out).toBeNull()
    expect(ctx.budget.spent()).toBe(0) // the failed Unit did not move the meter
  })

  test("is advisory — remaining() floors at 0 and the engine never hard-stops over-budget Units", async () => {
    const state = createEngineState()
    const ctx = createWorkflowContext({
      client: makeFakeClient({ outputTokens: 80 }),
      parentSessionID: "p",
      args: undefined,
      state,
      budget: 100,
    })
    const a = await ctx.agent("a")
    const b = await ctx.agent("b") // pushes spent to 160 > 100 — must still run, not be refused
    expect(a).not.toBeNull()
    expect(b).not.toBeNull()
    expect(ctx.budget.spent()).toBe(160)
    expect(ctx.budget.remaining()).toBe(0) // floored, not negative
  })
})
