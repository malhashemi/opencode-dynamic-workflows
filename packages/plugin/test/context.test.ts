/**
 * `ctx.agent` end to end over the fake host: Unit sessions, typed results through `workflow_result`, the text and
 * extract fallbacks, same-session repair, limits, stopping, and resume replay.
 */
import { describe, expect, test } from "bun:test"
import { z } from "../src/workflow"
import type { Unit } from "../src/protocol"
import type { ReplayPlan } from "../src/context"
import { makeCtx } from "./helpers"

describe("ctx.agent — text Units", () => {
  test("creates one titled Unit session with create-time identity and engine rules, returns the final text", async () => {
    const { ctx, host } = makeCtx({ reply: { text: "hello back" } })
    const out = await ctx.agent("hello", { label: "greeter" })
    expect(out).toBe("hello back")
    expect(host.creates).toHaveLength(1)
    const create = host.creates[0]!
    expect(create.title).toBe("⟡ wf · test · greeter")
    expect(create.agent).toBe("general")
    expect(create.metadata).toMatchObject({ workflow: { protocol: 1, runId: "run-test", ordinal: 1, parentSessionID: "ses_parent" } })
    expect(create.permissions.slice(-4).map((rule) => `${rule.action}:${rule.effect}`)).toEqual([
      "workflow_result:allow",
      "question:allow",
      "workflow:deny",
      "workflow_inline:deny",
    ])
    expect(host.prompts).toEqual([{ sessionID: "ses_fake_1", text: "hello", turn: 0 }])
  })

  test("model strings, effort and agentType are aliases the host understands", async () => {
    const { ctx, host } = makeCtx()
    await ctx.agent("a", { model: "anthropic/claude-x#high" })
    await ctx.agent("b", { model: { providerID: "openai", modelID: "gpt" }, effort: "low", agentType: "explore" })
    expect(host.creates[0]!.model).toEqual({ providerID: "anthropic", id: "claude-x", variant: "high" })
    expect(host.creates[1]!.model).toEqual({ providerID: "openai", id: "gpt", variant: "low" })
    expect(host.creates[1]!.agent).toBe("explore")
  })

  test("Workflow and Unit permission rules precede the engine rules", async () => {
    const { ctx, host } = makeCtx({}, { permissions: [{ action: "edit", resource: "*", effect: "allow" }] })
    await ctx.agent("x", { permissions: [{ action: "shell", resource: "*", effect: "deny" }] })
    expect(host.creates[0]!.permissions.map((rule) => rule.action)).toEqual(["edit", "shell", "workflow_result", "question", "workflow", "workflow_inline"])
  })

  test("a provider failure resolves to null and is recorded", async () => {
    const { ctx, state } = makeCtx({ reply: { error: "rate limited" } })
    expect(await ctx.agent("x", { label: "L" })).toBeNull()
    expect(state.errors).toEqual([{ unit: "L", prompt: "x", subagent: "general", error: "rate limited" }])
  })

  test("a create failure resolves to null with the reason", async () => {
    const { ctx, state } = makeCtx({ createError: "nope" })
    expect(await ctx.agent("x")).toBeNull()
    expect(state.errors[0]?.error).toContain("could not create the Unit session: nope")
  })

  test("usage is read from the Unit session and summed", async () => {
    const { ctx, state } = makeCtx({ outputTokens: 7, cost: 0.5 })
    await ctx.agent("a")
    await ctx.agent("b")
    expect(state.usage.tokens.output).toBe(14)
    expect(state.usage.cost).toBe(1)
  })

  test("emits queued → running → succeeded with the session and resolved model", async () => {
    const units: Unit[] = []
    const { ctx } = makeCtx({ model: { providerID: "p", id: "m" } }, { events: { onUnit: (unit) => units.push(unit) } })
    await ctx.agent("go")
    expect(units.map((unit) => unit.status)).toEqual(["queued", "running", "running", "succeeded"])
    const done = units.at(-1)!
    expect(done.sessionID).toBe("ses_fake_1")
    expect(done.model.resolved).toBe("p/m")
    expect(done.output).toBe("go")
    expect(done.resultPath).toBe("text")
  })
})

describe("ctx.agent — typed Units", () => {
  const Rating = z.object({ score: z.number().int().min(0).max(10), reason: z.string() })

  test("a valid workflow_result call resolves to the parsed value", async () => {
    const units: Unit[] = []
    const { ctx } = makeCtx({ reply: { result: { score: 7, reason: "ok" } } }, { events: { onUnit: (u) => units.push(u) } })
    const out = await ctx.agent("rate", { schema: Rating })
    expect(out).toEqual({ score: 7, reason: "ok" })
    expect(units.at(-1)?.resultPath).toBe("tool")
    expect(units.at(-1)?.schema).toBe(true)
  })

  test("an invalid call followed by a valid one in the same turn succeeds without a repair turn", async () => {
    const { ctx, host } = makeCtx({ reply: { results: [{ score: 99, reason: "x" }, { score: 9, reason: "fixed" }] } })
    expect(await ctx.agent("rate", { schema: Rating })).toEqual({ score: 9, reason: "fixed" })
    expect(host.prompts).toHaveLength(1)
  })

  test("no tool call → a repair turn in the SAME session", async () => {
    const units: Unit[] = []
    const { ctx, host } = makeCtx(
      { replies: [{ text: "I think it is a 7." }, { result: { score: 7, reason: "late" } }] },
      { events: { onUnit: (u) => units.push(u) } },
    )
    expect(await ctx.agent("rate", { schema: Rating })).toEqual({ score: 7, reason: "late" })
    expect(host.creates).toHaveLength(1)
    expect(host.prompts.map((p) => p.sessionID)).toEqual(["ses_fake_1", "ses_fake_1"])
    expect(host.prompts[1]!.text).toContain("workflow_result")
    expect(units.map((u) => u.status)).toContain("repairing")
    expect(units.at(-1)?.attempts.map((a) => `${a.path}:${a.ok}`)).toEqual(["tool:false", "tool:true"])
  })

  test("JSON in the reply text is accepted when it validates (text-json path)", async () => {
    const units: Unit[] = []
    const { ctx } = makeCtx({ reply: { text: 'Here:\n```json\n{"score": 4, "reason": "meh"}\n```' } }, { events: { onUnit: (u) => units.push(u) } })
    expect(await ctx.agent("rate", { schema: Rating })).toEqual({ score: 4, reason: "meh" })
    expect(units.at(-1)?.resultPath).toBe("text-json")
  })

  test("after the repairs, extraction is the last resort", async () => {
    const units: Unit[] = []
    const { ctx, host } = makeCtx(
      { reply: { text: "score four, because meh" }, generate: () => '{"score": 4, "reason": "meh"}' },
      { events: { onUnit: (u) => units.push(u) } },
    )
    expect(await ctx.agent("rate", { schema: Rating, retries: 1 })).toEqual({ score: 4, reason: "meh" })
    expect(host.prompts).toHaveLength(2)
    expect(host.generates[0]).toContain("score four")
    expect(units.at(-1)?.resultPath).toBe("extract")
  })

  test("every path failing resolves to null with a legible error", async () => {
    const { ctx, state } = makeCtx({ reply: { text: "no idea" } })
    expect(await ctx.agent("rate", { schema: Rating, retries: 1 })).toBeNull()
    expect(state.errors[0]?.error).toContain("structured output failed after 1 repair turn(s)")
  })

  test("a plain JSON Schema works as `schema` (D7 alias)", async () => {
    const { ctx, index } = makeCtx({ reply: { results: [{ n: "x" }, { n: 3 }] } })
    const out = await ctx.agent("count", {
      schema: { type: "object", properties: { n: { type: "integer", minimum: 0 } }, required: ["n"], additionalProperties: false },
    })
    expect(out).toEqual({ n: 3 })
    expect(index.size()).toBe(0) // bindings are released when the Unit settles
  })

  test("a schema that is neither zod nor JSON Schema fails the Unit, not the Run", async () => {
    const { ctx, state } = makeCtx()
    expect(await ctx.agent("x", { schema: "nope" as never })).toBeNull()
    expect(state.errors[0]?.error).toContain("not a zod schema or a JSON Schema")
  })
})

describe("ctx.agent — stopping and limits", () => {
  test("a Unit timeout interrupts the session and fails the Unit", async () => {
    const { ctx, host, state } = makeCtx({ reply: { hang: true } })
    expect(await ctx.agent("slow", { timeoutMs: 20 })).toBeNull()
    expect(host.interrupts).toEqual(["ses_fake_1"])
    expect(state.errors[0]?.error).toContain("20ms timeout")
  })

  test("the per-Unit stop handle stops only that Unit", async () => {
    const units: Unit[] = []
    const stops = new Map<string, () => void>()
    const { ctx } = makeCtx(
      { reply: (call) => (call.text === "hang" ? { hang: true } : { text: "fine" }) },
      { events: { onUnit: (u) => units.push(u), onUnitSession: (unitId, _sid, stop) => stops.set(unitId, stop) } },
    )
    const hanging = ctx.agent("hang", { label: "H" })
    const fine = ctx.agent("ok")
    await new Promise((r) => setTimeout(r, 5))
    const hangId = units.find((u) => u.label === "H")!.unitId
    stops.get(hangId)!()
    expect(await hanging).toBeNull()
    expect(await fine).toBe("fine")
    expect(units.filter((u) => u.unitId === hangId).at(-1)?.status).toBe("stopped")
  })

  test("the step guard stops a runaway Unit", async () => {
    const { ctx, state } = makeCtx({ stepsPerPrompt: 5, reply: { hang: true } }, { limits: { maxUnitSteps: 3 } })
    expect(await ctx.agent("loop")).toBeNull()
    expect(state.errors[0]?.error).toContain("step limit (3 model requests)")
  })

  test("limits.maxUnits reports the limit so the orchestrator can stop the Run", async () => {
    const limits: string[] = []
    const { ctx } = makeCtx({}, { limits: { maxUnits: 2 }, onLimit: (m) => limits.push(m) })
    await ctx.agent("1")
    await ctx.agent("2")
    await ctx.agent("3")
    expect(limits).toEqual(["limit reached: this Run tried to start more than 2 Units (limits.maxUnits)"])
  })
})

describe("ctx.agent — resume replay", () => {
  const plan = (overrides: Partial<ReplayPlan> = {}): ReplayPlan => ({
    units: new Map([
      [1, { prompt: "first", status: "succeeded", output: "one", schema: false, subagent: "general" }],
      [2, { prompt: "second", status: "succeeded", output: '{"n": 2}', schema: true, subagent: "general" }],
      [3, { prompt: "third", status: "failed", schema: false, subagent: "general" }],
    ]),
    answers: [],
    rerunFailed: true,
    diverged: false,
    ...overrides,
  })

  test("finished Units come back from the record without a session; failed ones re-run", async () => {
    const units: Unit[] = []
    const { ctx, host } = makeCtx({ reply: { text: "live" } }, { replay: plan(), events: { onUnit: (u) => units.push(u) } })
    expect(await ctx.agent("first")).toBe("one")
    expect(await ctx.agent("second", { schema: z.object({ n: z.number() }) })).toEqual({ n: 2 })
    expect(await ctx.agent("third")).toBe("live")
    expect(host.prompts.map((p) => p.text)).toEqual(["third"])
    expect(units.filter((u) => u.status === "replayed")).toHaveLength(2)
  })

  test("a different prompt at a recorded ordinal diverges and everything after runs live", async () => {
    const diverged: string[] = []
    const { ctx, host } = makeCtx({ reply: { text: "live" } }, { replay: plan({ onDiverge: (m) => diverged.push(m) }) })
    expect(await ctx.agent("CHANGED")).toBe("live")
    expect(await ctx.agent("second")).toBe("live")
    expect(diverged[0]).toContain("resume diverged at Unit 1")
    expect(host.prompts.map((p) => p.text)).toEqual(["CHANGED", "second"])
  })

  test("recorded ctx.ask answers replay in order", async () => {
    const { ctx } = makeCtx({}, { replay: plan({ answers: [[["Thorough"]]] }) })
    const answer = await ctx.ask(
      { header: "Depth", prompt: "How deep?", options: [{ label: "Fast", description: "" }, { label: "Thorough", description: "" }] },
      { fallback: [["Fast"]] },
    )
    expect(answer).toEqual([["Thorough"]])
  })

  test("a recorded hand-back (null) replays the fallback", async () => {
    const { ctx } = makeCtx({}, { replay: plan({ answers: [null] }) })
    const answer = await ctx.ask(
      { header: "Depth", prompt: "How deep?", options: [{ label: "Fast", description: "" }, { label: "Thorough", description: "" }] },
      { fallback: [["Fast"]] },
    )
    expect(answer).toEqual([["Fast"]])
  })
})

describe("ctx.ask and Unit questions", () => {
  const form = { header: "Region", prompt: "Where?", options: [{ label: "EU", description: "" }, { label: "US", description: "" }] }

  test("with no broker the fallback answers at once (headless contract)", async () => {
    const { ctx } = makeCtx()
    expect(await ctx.ask(form, { fallback: [["us"]] })).toEqual([["US"]])
  })

  test("a fallback outside the offered labels is an authoring error", async () => {
    const { ctx } = makeCtx()
    await expect(ctx.ask(form, { fallback: [["Mars"]] })).rejects.toThrow("fallback")
  })

  test("a Unit's own question tool call is routed to askAgent", async () => {
    const asked: string[] = []
    const { ctx } = makeCtx(
      { reply: { question: { header: "Color", prompt: "red or blue?", options: ["red", "blue"] } } },
      {
        askAgent: (unitId, sessionID) => async (questions) => {
          asked.push(`${unitId.length > 0}:${sessionID}:${questions[0]?.prompt}`)
          return { answers: [["blue"]], by: "human" }
        },
      },
    )
    expect(await ctx.agent("ask something")).toBe("ANSWER: blue")
    expect(asked).toEqual(["true:ses_fake_1:red or blue?"])
  })
})

describe("audit regressions — a Unit never outlives its stop, and never throws", () => {
  test("stopped while the session was being created: the new session is interrupted", async () => {
    const controller = new AbortController()
    const { ctx, host } = makeCtx({ createDelayMs: 30 }, { signal: controller.signal })
    const pending = ctx.agent("x")
    setTimeout(() => controller.abort(), 5)
    expect(await pending).toBeNull()
    await new Promise((resolve) => setTimeout(resolve, 40)) // the session appears later; it is stopped then
    expect(host.interrupts).toEqual(["ses_fake_1"])
    expect(host.prompts).toHaveLength(0)
  })

  test("a hung prompt admission still honours the Unit timeout, and the session is interrupted", async () => {
    const { ctx, host, state } = makeCtx({ promptHang: true })
    expect(await ctx.agent("x", { timeoutMs: 20 })).toBeNull()
    expect(state.errors[0]?.error).toContain("20ms timeout")
    expect(host.interrupts).toEqual(["ses_fake_1"])
  })

  test("a rejected prompt interrupts the session it may have started", async () => {
    const { ctx, host, state } = makeCtx({ promptError: "boom" })
    expect(await ctx.agent("x")).toBeNull()
    expect(state.errors[0]?.error).toBe("could not prompt the Unit session: boom")
    expect(host.interrupts).toEqual(["ses_fake_1"])
  })

  test("a rejected wait is a failed Unit (recorded, interrupted), not a thrown error", async () => {
    const units: Unit[] = []
    const { ctx, host, state } = makeCtx({ waitError: "socket closed" }, { events: { onUnit: (u) => units.push(u) } })
    expect(await ctx.agent("x")).toBeNull()
    expect(state.errors[0]?.error).toBe("waiting for the Unit session failed: socket closed")
    expect(host.interrupts).toEqual(["ses_fake_1"])
    expect(units.at(-1)?.status).toBe("failed")
  })
})

describe("audit regressions — hard budget covers repairs and extraction", () => {
  const Rating = z.object({ score: z.number() })

  test("no repair turn once a hard budget is spent", async () => {
    const { ctx, host, state } = makeCtx({ reply: { text: "no json here" }, outputTokens: 80 }, { budget: 50, hardBudget: true })
    expect(await ctx.agent("rate", { schema: Rating })).toBeNull()
    expect(host.prompts).toHaveLength(1)
    expect(state.errors[0]?.error).toContain("budget exhausted before repair turn 1")
  })

  test("no extraction once a hard budget is spent", async () => {
    const { ctx, host, state } = makeCtx(
      { reply: { text: "score four" }, outputTokens: 30, generate: () => '{"score": 4}' },
      { budget: 50, hardBudget: true },
    )
    expect(await ctx.agent("rate", { schema: Rating, retries: 1 })).toBeNull()
    expect(host.generates).toHaveLength(0)
    expect(state.errors[0]?.error).toContain("budget exhausted before extraction")
  })

  test("extraction's (estimated) tokens are counted in the Unit's usage and the budget", async () => {
    const units: Unit[] = []
    const { ctx, state } = makeCtx(
      { reply: { text: "score four" }, outputTokens: 0, generate: () => '{"score": 4}' },
      { events: { onUnit: (u) => units.push(u) } },
    )
    expect(await ctx.agent("rate", { schema: Rating, retries: 0 })).toEqual({ score: 4 })
    const done = units.at(-1)!
    expect(done.resultPath).toBe("extract")
    expect(done.usage.tokens.output).toBeGreaterThan(0)
    expect(done.attempts.at(-1)?.note).toContain("estimated")
    expect(state.tokensSpent).toBe(done.usage.tokens.output)
  })
})

describe("audit round 2 — runner setup and restarts", () => {
  test("a throw after the Unit is bound still unbinds it, stops its session and reports it", async () => {
    const { ctx, host, index, state } = makeCtx({}, {
      events: {
        onUnitSession: () => {
          throw new Error("surface bug")
        },
      },
    })
    expect(await ctx.agent("x")).toBeNull()
    expect(index.size()).toBe(0)
    expect(host.interrupts).toEqual(["ses_fake_1"])
    expect(state.errors[0]?.error).toContain("the Unit failed unexpectedly: surface bug")
  })

  test("an interrupt beyond the restart limit fails the Unit instead of reading the cut-off turn as done", async () => {
    const { ctx, host, index, state } = makeCtx({ reply: { hang: true } })
    const pending = ctx.agent("x")
    await new Promise((resolve) => setTimeout(resolve, 5))
    const binding = index.get("ses_fake_1")!
    binding.restarts = 5
    binding.restart = true
    await host.session.interrupt({ sessionID: "ses_fake_1" })
    expect(await pending).toBeNull()
    expect(state.errors[0]?.error).toContain("restarted more than 5 times")
  })
})

describe("audit round 3 — deadlines cover every step", () => {
  test("the Unit timeout covers a slow session create", async () => {
    const { ctx, host, state } = makeCtx({ createDelayMs: 80 })
    expect(await ctx.agent("x", { timeoutMs: 20 })).toBeNull()
    expect(state.errors[0]?.error).toContain("timeout while its session was being created")
    await new Promise((resolve) => setTimeout(resolve, 100))
    expect(host.interrupts).toEqual(["ses_fake_1"])
  })

  test("a hung extraction honours the Unit timeout", async () => {
    const { ctx, state } = makeCtx({ reply: { text: "no json" }, generate: () => new Promise<string>(() => {}) })
    expect(await ctx.agent("x", { schema: z.object({ n: z.number() }), retries: 0, timeoutMs: 30 })).toBeNull()
    expect(state.errors[0]?.error).toContain("30ms timeout")
  })

  test("a turn is active only between admission and settling", async () => {
    const { ctx, index } = makeCtx({ reply: { hang: true } })
    const pending = ctx.agent("x", { timeoutMs: 40 })
    await new Promise((resolve) => setTimeout(resolve, 5))
    expect(index.get("ses_fake_1")?.turnActive).toBe(true)
    await pending
  })
})

describe("audit round 4 — a hung interrupt cannot hold the Unit", () => {
  test("stop with a host whose interrupt never returns still ends the Unit", async () => {
    const { ctx, state } = makeCtx({ reply: { hang: true }, interruptHang: true })
    const started = Date.now()
    expect(await ctx.agent("x", { timeoutMs: 20 })).toBeNull()
    expect(state.errors[0]?.error).toContain("20ms timeout")
    expect(Date.now() - started).toBeLessThan(12_000)
  }, 15_000)
})

describe("worktree isolation", () => {
  test("an unchanged worktree is removed; the Unit ran there", async () => {
    const { ctx, host } = makeCtx({ worktree: { changed: false } })
    expect(await ctx.agent("edit", { isolation: "worktree", label: "w" })).toBe("edit")
    expect(host.creates[0]!.location).toEqual({ directory: "/wt/wf-run-test-1" })
    expect(host.worktreeLog).toEqual(["create wf-run-test-1", "changed /wt/wf-run-test-1", "remove /wt/wf-run-test-1"])
    expect(ctx.worktrees()).toEqual([])
  })

  test("a changed worktree is kept and listed for merging", async () => {
    const { ctx, host } = makeCtx({ worktree: { changed: true } })
    await ctx.agent("edit", { isolation: "worktree", label: "w" })
    expect(host.worktreeLog.some((line) => line.startsWith("remove"))).toBe(false)
    expect(ctx.worktrees()).toEqual([{ unit: "w", directory: "/wt/wf-run-test-1", branch: "wt-wf-run-test-1" }])
  })

  test("a location without the plugin fails the Unit early, legibly", async () => {
    const { ctx, host, state } = makeCtx({ worktree: { active: false } })
    expect(await ctx.agent("edit", { isolation: "worktree" })).toBeNull()
    expect(state.errors[0]?.error).toContain("the workflow plugin is not active in /wt/wf-run-test-1")
    expect(host.interrupts).toEqual(["ses_fake_1"])
  })

  test("a host without worktrees fails the Unit, not the Run", async () => {
    const { ctx, state } = makeCtx()
    expect(await ctx.agent("edit", { isolation: "worktree" })).toBeNull()
    expect(state.errors[0]?.error).toContain("not available on this host")
  })
})
