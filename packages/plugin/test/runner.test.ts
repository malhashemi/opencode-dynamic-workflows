import { describe, expect, it } from "bun:test"
import { DEFAULT_SUBAGENT, runAgent } from "../src/runner"
import { makeFakeClient } from "./fake-client"

describe("runAgent", () => {
  it("creates a child session under the parent and prompts it as the named subagent", async () => {
    const client = makeFakeClient({ reply: "ANSWER" })
    const result = await runAgent(client, "parent-1", "do the thing", { subagent: "reviewer" })

    expect(result).toEqual({ ok: true, text: "ANSWER", childSessionID: "child-1" })
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
    expect(result).toEqual({ ok: true, text: "last", childSessionID: "child-1" })
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

  it("throws if a schema is passed (unsupported on v1.15.x)", async () => {
    const client = makeFakeClient()
    await expect(runAgent(client, "p", "x", { schema: { type: "object" } })).rejects.toThrow(/schema/)
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
