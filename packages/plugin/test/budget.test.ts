/**
 * `ctx.budget` is ADVISORY by default (D10): `total` is the declared ceiling (or null), `spent()` accumulates
 * completed Units' output tokens, `remaining()` floors at 0. A hard budget stops the Run once spent.
 */
import { describe, expect, test } from "bun:test"
import { makeCtx } from "./helpers"

describe("ctx.budget", () => {
  test("total is null and remaining() is Infinity when the caller declares no budget", async () => {
    const { ctx } = makeCtx({ outputTokens: 10 })
    expect(ctx.budget.total).toBeNull()
    expect(ctx.budget.remaining()).toBe(Infinity)
    await ctx.agent("go")
    expect(ctx.budget.spent()).toBe(10)
    expect(ctx.budget.remaining()).toBe(Infinity)
  })

  test("spent() accumulates completed Units' output tokens; remaining() = total - spent()", async () => {
    const { ctx } = makeCtx({ outputTokens: 30 }, { budget: 100 })
    expect(ctx.budget.total).toBe(100)
    await ctx.agent("a")
    await ctx.agent("b")
    expect(ctx.budget.spent()).toBe(60)
    expect(ctx.budget.remaining()).toBe(40)
  })

  test("is advisory — remaining() floors at 0 and over-budget Units still run", async () => {
    const { ctx } = makeCtx({ outputTokens: 80 }, { budget: 100 })
    expect(await ctx.agent("a")).not.toBeNull()
    expect(await ctx.agent("b")).not.toBeNull()
    expect(ctx.budget.spent()).toBe(160)
    expect(ctx.budget.remaining()).toBe(0)
  })

  test("a hard budget reports the limit once spent", async () => {
    const messages: string[] = []
    const { ctx } = makeCtx({ outputTokens: 80 }, { budget: 100, hardBudget: true, onLimit: (m) => messages.push(m) })
    await ctx.agent("a")
    await ctx.agent("b")
    expect(messages[0]).toContain("budget exhausted")
  })
})
