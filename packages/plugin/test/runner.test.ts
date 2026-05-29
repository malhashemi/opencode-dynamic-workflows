import { describe, expect, it } from "bun:test"
import { z } from "@opencode-ai/workflow"
import { DEFAULT_SUBAGENT, runAgent } from "../src/runner"
import { makeFakeClient } from "./fake-client"

describe("runAgent", () => {
  it("creates a child session under the parent and prompts it as the named subagent", async () => {
    const client = makeFakeClient({ reply: "ANSWER" })
    const result = await runAgent(client, "parent-1", "do the thing", { subagent: "reviewer" })

    expect(result).toEqual({ ok: true, kind: "text", text: "ANSWER", childSessionID: "child-1" })
    expect(client.createCalls[0]?.body).toEqual({ parentID: "parent-1", title: "wf:reviewer" })
    expect(client.promptCalls[0]?.path).toEqual({ id: "child-1" })
    expect(client.promptCalls[0]?.body?.agent).toBe("reviewer")
    expect(client.promptCalls[0]?.body?.parts).toEqual([{ type: "text", text: "do the thing" }])
  })

  it("defaults the subagent to `general` when omitted", async () => {
    const client = makeFakeClient({ reply: "ok" })
    await runAgent(client, "parent-1", "hi")
    expect(client.promptCalls[0]?.body?.agent).toBe(DEFAULT_SUBAGENT)
    expect(DEFAULT_SUBAGENT).toBe("general")
  })

  it("returns the LAST text part when several are present", async () => {
    const client = makeFakeClient()
    client.session.prompt = async (input) => {
      client.promptCalls.push(input)
      return { data: { info: null, parts: [{ type: "text", text: "first" }, { type: "text", text: "last" }] } }
    }
    const result = await runAgent(client, "p", "x")
    expect(result).toEqual({ ok: true, kind: "text", text: "last", childSessionID: "child-1" })
  })

  it("gives each Unit its OWN child session (serialization invariant)", async () => {
    const client = makeFakeClient()
    const a = await runAgent(client, "p", "one")
    const b = await runAgent(client, "p", "two")
    expect(a.ok && b.ok).toBe(true)
    expect((a as { childSessionID: string }).childSessionID).not.toBe((b as { childSessionID: string }).childSessionID)
    expect(client.createCalls).toHaveLength(2)
  })

  it("forwards a model override only when provided", async () => {
    const client = makeFakeClient()
    await runAgent(client, "p", "x", { model: { providerID: "anthropic", modelID: "claude" } })
    expect(client.promptCalls[0]?.body?.model).toEqual({ providerID: "anthropic", modelID: "claude" })

    const client2 = makeFakeClient()
    await runAgent(client2, "p", "x")
    expect(client2.promptCalls[0]?.body?.model).toBeUndefined()
  })

  it("returns ok:false when create yields no session id", async () => {
    const client = makeFakeClient({ noSessionId: true })
    const result = await runAgent(client, "p", "x")
    expect(result.ok).toBe(false)
    expect(client.promptCalls).toHaveLength(0)
  })

  it("returns ok:false when the prompt reports an error", async () => {
    const client = makeFakeClient({ promptError: { message: "model blew up" } })
    const result = await runAgent(client, "p", "x")
    expect(result).toMatchObject({ ok: false, error: expect.stringContaining("model blew up") })
  })

  it("returns ok:false when there is no assistant text part", async () => {
    const client = makeFakeClient({ noTextPart: true })
    const result = await runAgent(client, "p", "x")
    expect(result.ok).toBe(false)
  })

  it("returns ok:false (never throws) when the prompt transport REJECTS", async () => {
    const client = makeFakeClient()
    client.session.prompt = async () => {
      throw new Error("ECONNRESET")
    }
    const result = await runAgent(client, "p", "x")
    expect(result).toMatchObject({ ok: false, error: expect.stringContaining("ECONNRESET") })
    expect((result as { childSessionID?: string }).childSessionID).toBe("child-1")
  })

  it("returns ok:false (never throws) when session.create itself REJECTS", async () => {
    const client = makeFakeClient()
    client.session.create = async () => {
      throw new Error("server down")
    }
    const result = await runAgent(client, "p", "x")
    expect(result).toMatchObject({ ok: false, error: expect.stringContaining("server down") })
  })
})

describe("runAgent — structured output", () => {
  const Finding = z.object({ title: z.string(), score: z.number() })

  it("sends a json_schema format derived from the zod schema and parses info.structured back", async () => {
    const client = makeFakeClient({ structured: { title: "ok", score: 5 } })
    const result = await runAgent(client, "p", "rate it", { schema: Finding })

    expect(result).toEqual({ ok: true, kind: "structured", value: { title: "ok", score: 5 }, childSessionID: "child-1" })
    const fmt = client.promptCalls[0]?.body?.format
    expect(fmt?.type).toBe("json_schema")
    expect(fmt?.schema).toMatchObject({
      type: "object",
      properties: { title: { type: "string" }, score: { type: "number" } },
    })
  })

  it("sends NO format when no schema is given (text path untouched)", async () => {
    const client = makeFakeClient({ reply: "hi" })
    await runAgent(client, "p", "x")
    expect(client.promptCalls[0]?.body?.format).toBeUndefined()
  })

  it("retries a StructuredOutputError then succeeds — a fresh child per attempt (serialization invariant)", async () => {
    const client = makeFakeClient({
      responses: [{ structuredError: "no tool call" }, { structured: { title: "late", score: 1 } }],
    })
    const result = await runAgent(client, "p", "x", { schema: Finding })

    expect(result).toMatchObject({ ok: true, kind: "structured", value: { title: "late", score: 1 } })
    expect(client.createCalls).toHaveLength(2)
    expect(client.promptCalls).toHaveLength(2)
  })

  it("resolves to ok:false after exhausting retries on a persistent StructuredOutputError", async () => {
    const client = makeFakeClient({ structuredError: "never complies" })
    const result = await runAgent(client, "p", "x", { schema: Finding, retries: 2 })

    expect(result.ok).toBe(false)
    expect(client.promptCalls).toHaveLength(3) // 1 initial + 2 retries
    expect((result as { error: string }).error).toContain("never complies")
  })

  it("retries:0 makes exactly one attempt", async () => {
    const client = makeFakeClient({ structuredError: "nope" })
    const result = await runAgent(client, "p", "x", { schema: Finding, retries: 0 })

    expect(result.ok).toBe(false)
    expect(client.promptCalls).toHaveLength(1)
  })

  it("retries a payload that is JSON-Schema-valid but fails the zod schema, then gives up", async () => {
    const Positive = z.object({ n: z.number() }).refine((o) => o.n > 0, "n must be positive")
    const client = makeFakeClient({ structured: { n: -1 } }) // valid number per JSON Schema, fails the refinement
    const result = await runAgent(client, "p", "x", { schema: Positive, retries: 1 })

    expect(result.ok).toBe(false)
    expect(client.promptCalls).toHaveLength(2) // retried once
    expect((result as { error: string }).error).toMatch(/schema validation/)
  })

  it("does NOT retry a non-structured info.error (an infra/model failure fails fast)", async () => {
    const client = makeFakeClient({
      responses: [{ error: { message: "model exploded" } }, { structured: { title: "x", score: 1 } }],
    })
    const result = await runAgent(client, "p", "x", { schema: Finding, retries: 3 })

    expect(result.ok).toBe(false)
    expect(client.promptCalls).toHaveLength(1)
  })

  it("returns ok:false WITHOUT creating a session when given a non-zod schema (author misuse)", async () => {
    const client = makeFakeClient()
    const result = await runAgent(client, "p", "x", { schema: { not: "zod" } as unknown as z.ZodType })

    expect(result.ok).toBe(false)
    expect((result as { error: string }).error).toMatch(/zod schema/)
    expect(client.createCalls).toHaveLength(0)
  })
})
