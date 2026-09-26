import { describe, expect, test } from "bun:test"
import type { TranscriptMessage } from "@malhashemi/opencode-dynamic-workflows/protocol"
import { createApi } from "../src/api"
import { messageView, partItem, reasoningSummary, summarizeTranscript, summaryLine, toolTitle } from "../src/transcript"

const assistant = (parts: TranscriptMessage["parts"], extra: Partial<TranscriptMessage> = {}): TranscriptMessage => ({
  role: "assistant",
  parts,
  model: "anthropic/claude",
  error: null,
  ...extra,
})

describe("transcript", () => {
  test("tool row title is name · status", () => {
    expect(toolTitle({ name: "read", status: "completed" })).toBe("read · completed")
    expect(toolTitle({ name: "  ", status: "" })).toBe("tool")
  })

  test("reasoning summary previews the first non-empty line", () => {
    expect(reasoningSummary("\n  Let me think.\nMore")).toBe("Reasoning — Let me think.")
    expect(reasoningSummary("   ")).toBe("Reasoning")
    expect(reasoningSummary("x".repeat(100), 10)).toBe(`Reasoning — ${"x".repeat(9)}…`)
  })

  test("empty parts are dropped and adjacent text is merged", () => {
    expect(partItem({ kind: "text", text: "  " })).toBeNull()
    expect(partItem({ kind: "tool" })).toBeNull()
    const view = messageView(
      assistant([
        { kind: "text", text: "Hello " },
        { kind: "text", text: "world\nline 2" },
        { kind: "reasoning", text: "hmm" },
        { kind: "tool", tool: { name: "bash", status: "error", error: "exit 1" } },
        { kind: "text", text: "done" },
      ]),
    )
    expect(view.header).toBe("Assistant")
    expect(view.model).toBe("anthropic/claude")
    expect(view.items.map((item) => item.kind)).toEqual(["text", "reasoning", "tool", "text"])
    expect(view.items[0]).toEqual({ kind: "text", text: "Hello world\nline 2" })
    expect(view.items[2]).toMatchObject({ title: "bash · error", failed: true })
  })

  test("the model is shown only for assistant messages", () => {
    expect(messageView({ role: "user", parts: [], model: "m", error: null }).model).toBeNull()
  })

  test("summary counts messages, tool calls, failures and errors", () => {
    const summary = summarizeTranscript([
      { role: "user", parts: [{ kind: "text", text: "go" }], model: null, error: null },
      assistant([
        { kind: "tool", tool: { name: "read", status: "completed", output: "ok" } },
        { kind: "tool", tool: { name: "bash", status: "completed", error: "boom" } },
      ]),
      assistant([], { error: "Provider error" }),
    ])
    expect(summary).toEqual({ messages: 3, toolCalls: 2, failedTools: 1, errors: 1 })
    expect(summaryLine(summary)).toBe("3 messages · 2 tool calls · 1 failed · 1 error")
    expect(summaryLine(summarizeTranscript([]))).toBe("0 messages · 0 tool calls")
  })

  test("the client reads the transcript route and surfaces not_found", async () => {
    const urls: string[] = []
    const api = createApi({
      tokens: { get: () => null, set: () => {} },
      fetch: (async (url: string) => {
        urls.push(url)
        return new Response(JSON.stringify({ error: { code: "not_found", message: "Unit u/1 has no session" } }), { status: 404 })
      }) as unknown as typeof fetch,
    })
    const caught = await api.getTranscript("r", "u/1").catch((error) => error)
    expect(urls).toEqual(["/v1/runs/r/units/u%2F1/transcript"])
    expect(caught.code).toBe("not_found")
    expect(caught.message).toBe("Unit u/1 has no session")
  })
})
