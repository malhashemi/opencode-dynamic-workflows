import { describe, expect, it } from "bun:test"
import { createControlRegistry } from "../src/control"
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

/**
 * The first non-GET route. A read-only endpoint cannot prove its own auth on the direction that matters: an
 * unauthenticated read leaks a run list, an unauthenticated WRITE stops someone's work.
 */
describe("workflow endpoint: POST /control", () => {
  async function control(body: unknown, init: RequestInit & { token?: string; url: string }): Promise<Response> {
    return fetch(`${init.url}/control`, {
      method: init.method ?? "POST",
      headers: init.token ? { authorization: `Bearer ${init.token}` } : {},
      body: init.body === undefined ? JSON.stringify(body) : init.body,
    })
  }

  it("dispatches a stop and answers with the registry's own ControlResult", async () => {
    const registry = createControlRegistry()
    const controller = new AbortController()
    registry.registerRun("run-endpoint", controller)
    let cancelled = false
    registry.registerUnit("run-endpoint", "unit-a", () => {
      cancelled = true
    })

    const endpoint = await startEndpoint(createRunStore(), {}, { control: registry })
    if (!endpoint) throw new Error("expected endpoint")
    try {
      const unit = await control(
        { action: "stop.unit", runId: "run-endpoint", unitId: "unit-a" },
        { url: endpoint.url, token: endpoint.token },
      )
      expect(unit.status).toBe(200)
      expect(await unit.json()).toEqual({ ok: true })
      expect(cancelled).toBe(true)

      const run = await control({ action: "stop.run", runId: "run-endpoint" }, { url: endpoint.url, token: endpoint.token })
      expect(run.status).toBe(200)
      expect(controller.signal.aborted).toBe(true)

      // A second stop is a real answer, not an error: the run is already going away.
      const again = await control({ action: "stop.run", runId: "run-endpoint" }, { url: endpoint.url, token: endpoint.token })
      expect(again.status).toBe(409)
      expect(await again.json()).toEqual({ ok: false, reason: "not-running" })
    } finally {
      await endpoint.stop()
    }
  })

  it("refuses an unauthenticated write before it reaches the registry", async () => {
    const registry = createControlRegistry()
    const controller = new AbortController()
    registry.registerRun("run-endpoint", controller)
    const endpoint = await startEndpoint(createRunStore(), {}, { control: registry })
    if (!endpoint) throw new Error("expected endpoint")
    try {
      const response = await control({ action: "stop.run", runId: "run-endpoint" }, { url: endpoint.url })
      expect(response.status).toBe(401)
      expect(controller.signal.aborted).toBe(false)
    } finally {
      await endpoint.stop()
    }
  })

  it("reports unknown ids as 404 and a malformed action as 400", async () => {
    const endpoint = await startEndpoint(createRunStore(), {}, { control: createControlRegistry() })
    if (!endpoint) throw new Error("expected endpoint")
    try {
      const unknownRun = await control({ action: "stop.run", runId: "ghost" }, { url: endpoint.url, token: endpoint.token })
      expect(unknownRun.status).toBe(404)
      expect(await unknownRun.json()).toEqual({ ok: false, reason: "unknown-run" })

      const malformed = await control({ action: "explode", runId: "ghost" }, { url: endpoint.url, token: endpoint.token })
      expect(malformed.status).toBe(400)
      expect(await malformed.json()).toMatchObject({ ok: false, reason: "unsupported" })

      const notJson = await control(null, { url: endpoint.url, token: endpoint.token, body: "{" })
      expect(notJson.status).toBe(400)
    } finally {
      await endpoint.stop()
    }
  })

  it("rejects every method but POST, and says so rather than 404-ing", async () => {
    const endpoint = await startEndpoint(createRunStore(), {}, { control: createControlRegistry() })
    if (!endpoint) throw new Error("expected endpoint")
    try {
      for (const method of ["GET", "PUT", "DELETE"]) {
        const response = await fetch(`${endpoint.url}/control?token=${endpoint.token}`, { method })
        expect(response.status).toBe(405)
      }
    } finally {
      await endpoint.stop()
    }
  })

  it("answers `unsupported` when the endpoint was started without a control registry", async () => {
    const endpoint = await startEndpoint(createRunStore())
    if (!endpoint) throw new Error("expected endpoint")
    try {
      const response = await control({ action: "stop.run", runId: "r" }, { url: endpoint.url, token: endpoint.token })
      expect(response.status).toBe(400)
      expect(await response.json()).toEqual({ ok: false, reason: "unsupported" })
    } finally {
      await endpoint.stop()
    }
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
