import { describe, expect, test } from "bun:test"
import { connectSse, SseParser, type SseMessage, type SseStatus } from "../src/sse"

describe("SseParser", () => {
  test("parses id, event and data, and dispatches on a blank line", () => {
    const parser = new SseParser()
    const out = parser.feed('id: 7\nevent: run.updated\ndata: {"a":1}\n\n')
    expect(out).toEqual([{ id: "7", event: "run.updated", data: '{"a":1}' }])
    expect(parser.lastEventId).toBe("7")
  })

  test("joins multi-line data with newlines", () => {
    const out = new SseParser().feed("data: first\ndata: second\ndata:third\n\n")
    expect(out).toEqual([{ id: "", event: "message", data: "first\nsecond\nthird" }])
  })

  test("ignores comments and unknown fields; an event without data is not dispatched", () => {
    const parser = new SseParser()
    const out = parser.feed(": keep-alive 123\n\nretry: 2000\n: opencode-dynamic-workflows protocol 1\n\nfoo: bar\nevent: x\n\n")
    expect(out).toEqual([])
    expect(parser.retry).toBe(2000)
  })

  test("reassembles events split across arbitrary chunks, including a split CRLF", () => {
    const stream = 'id: 1\r\nevent: a\r\ndata: {"x":\r\ndata: 2}\r\n\r\nid: 2\ndata: b\n\n'
    for (let size = 1; size <= stream.length; size++) {
      const parser = new SseParser()
      const out: SseMessage[] = []
      for (let i = 0; i < stream.length; i += size) out.push(...parser.feed(stream.slice(i, i + size)))
      expect(out).toEqual([
        { id: "1", event: "a", data: '{"x":\n2}' },
        { id: "2", event: "message", data: "b" },
      ])
    }
  })

  test("accepts bare CR line endings", () => {
    const out = new SseParser().feed("data: a\r\rdata: b\r\r")
    expect(out.map((m) => m.data)).toEqual(["a", "b"])
  })

  test("the id persists across events and is carried by later ones without an id line", () => {
    const parser = new SseParser()
    const out = parser.feed('id: 41\ndata: x\n\nevent: resync.required\ndata: {"reason":"gap"}\n\n')
    expect(out[1]).toEqual({ id: "41", event: "resync.required", data: '{"reason":"gap"}' })
  })

  test("strips one leading space only, and a leading BOM", () => {
    const out = new SseParser().feed("\uFEFFdata:  two spaces\n\n")
    expect(out[0]!.data).toBe(" two spaces")
  })

  test("an incomplete event at end of stream is dropped by reset, but the id survives", () => {
    const parser = new SseParser()
    parser.feed("id: 5\ndata: done\n\nid: 6\ndata: half")
    parser.reset()
    expect(parser.lastEventId).toBe("6")
    expect(parser.feed("data: next\n\n")).toEqual([{ id: "6", event: "message", data: "next" }])
  })
})

describe("connectSse", () => {
  function streamOf(chunks: string[]): ReadableStream<Uint8Array> {
    const encoder = new TextEncoder()
    return new ReadableStream({
      start(controller) {
        for (const chunk of chunks) controller.enqueue(encoder.encode(chunk))
        controller.close()
      },
    })
  }

  test("sends auth headers, resumes with Last-Event-ID, and reports status", async () => {
    const requests: Record<string, string>[] = []
    const bodies = [["id: 1\ndata: a\n\n", "id: 2\nda", "ta: b\n\n"], ["id: 3\ndata: c\n\n"]]
    const messages: SseMessage[] = []
    const statuses: SseStatus[] = []
    let resolveDone!: () => void
    const done = new Promise<void>((resolve) => (resolveDone = resolve))
    const connection = connectSse({
      url: "/v1/events?location=x",
      headers: () => ({ authorization: "Bearer wfg_t" }),
      fetch: (async (_url: string, init: RequestInit) => {
        requests.push({ ...(init.headers as Record<string, string>) })
        const body = bodies.shift()
        if (!body) {
          resolveDone()
          return new Promise<Response>(() => {})
        }
        return new Response(streamOf(body), { headers: { "content-type": "text/event-stream" } })
      }) as unknown as typeof fetch,
      sleep: async () => {},
      onMessage: (message) => messages.push(message),
      onStatus: (status) => statuses.push(status),
    })
    await done
    connection.close()
    expect(messages.map((m) => m.data)).toEqual(["a", "b", "c"])
    expect(requests[0]!.authorization).toBe("Bearer wfg_t")
    expect(requests[0]!["last-event-id"]).toBeUndefined()
    expect(requests[1]!["last-event-id"]).toBe("2")
    expect(requests[2]!["last-event-id"]).toBe("3")
    expect(statuses).toContain("open")
    expect(statuses).toContain("retrying")
  })

  test("calls onUnauthorized on 401 and keeps retrying", async () => {
    let calls = 0
    let unauthorized = 0
    let resolveDone!: () => void
    const done = new Promise<void>((resolve) => (resolveDone = resolve))
    const connection = connectSse({
      url: "/v1/events",
      fetch: (async () => {
        calls += 1
        if (calls === 3) resolveDone()
        return new Response("{}", { status: 401 })
      }) as unknown as typeof fetch,
      sleep: async () => {},
      onMessage: () => {},
      onUnauthorized: () => {
        unauthorized += 1
      },
    })
    await done
    connection.close()
    expect(unauthorized).toBeGreaterThanOrEqual(2)
  })
})
