import { describe, expect, it } from "bun:test"
import { startEndpoint } from "../src/endpoint"
import { createRunStore, type RunSnapshot } from "../src/runs"

function snapshot(): RunSnapshot {
  return {
    runId: "run-endpoint",
    workflow: "endpoint-test",
    provenance: "inline",
    parentSessionID: "parent",
    status: "running",
    phases: [],
    currentPhase: null,
    units: [],
    logs: [],
    errors: [],
    tokensSpent: 0,
    startedAt: Date.now(),
    endedAt: null,
  }
}

describe("workflow endpoint", () => {
  it("serves authenticated health/state and rejects missing or wrong tokens", async () => {
    const store = createRunStore()
    store.create(snapshot())
    const endpoint = await startEndpoint(store)
    if (!endpoint) throw new Error("expected endpoint")
    expect(store.subscribers()).toBe(1)
    try {
      expect((await fetch(`${endpoint.url}/state`)).status).toBe(401)
      expect((await fetch(`${endpoint.url}/state`, { headers: { authorization: "Bearer wrong" } })).status).toBe(401)
      const state = await fetch(`${endpoint.url}/state`, { headers: { authorization: `Bearer ${endpoint.token}` } })
      expect(state.status).toBe(200)
      expect(await state.json()).toMatchObject({ runs: [{ runId: "run-endpoint", workflow: "endpoint-test" }] })
      const health = await fetch(`${endpoint.url}/health?token=${endpoint.token}`)
      expect(await health.json()).toEqual({ ok: true })
    } finally {
      await endpoint.stop()
    }
  })

  it("delivers ordered SSE events and unsubscribes on disconnect and stop", async () => {
    const store = createRunStore()
    store.create(snapshot())
    const endpoint = await startEndpoint(store)
    if (!endpoint) throw new Error("expected endpoint")
    expect(store.subscribers()).toBe(1)
    const streamController = new AbortController()
    const response = await fetch(`${endpoint.url}/events`, {
      headers: { authorization: `Bearer ${endpoint.token}` },
      signal: streamController.signal,
    })
    expect(response.status).toBe(200)
    expect(response.headers.get("content-type")).toContain("text/event-stream")
    await waitFor(() => endpoint.subscribers() === 1)
    const reader = response.body!.getReader()
    store.apply({ type: "run.log", runId: "run-endpoint", value: "hello" })
    const decoder = new TextDecoder()
    let text = ""
    while (!text.includes('"type":"run.log"')) {
      const chunk = await reader.read()
      if (chunk.done) break
      text += decoder.decode(chunk.value)
    }
    expect(text).toContain("id: 1")
    expect(text).toContain('"value":"hello"')
    await reader.cancel()
    streamController.abort()
    await waitFor(() => endpoint.subscribers() === 0)

    const second = await fetch(`${endpoint.url}/events?token=${endpoint.token}`)
    await waitFor(() => endpoint.subscribers() === 1)
    await endpoint.stop()
    expect(endpoint.subscribers()).toBe(0)
    expect(store.subscribers()).toBe(0)
    await second.body?.cancel()
  })

  it("refuses non-loopback hosts and supports explicit disable", async () => {
    await expect(startEndpoint(createRunStore(), { host: "0.0.0.0" })).rejects.toThrow(/loopback/)
    expect(await startEndpoint(createRunStore(), { enabled: false })).toBeNull()
  })
})

async function waitFor(predicate: () => boolean, timeoutMs = 1_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (predicate()) return
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
  throw new Error("condition was not reached")
}
