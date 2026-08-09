import { describe, expect, it } from "bun:test"
import { createControlRegistry, createInteractionController } from "../src/control"
import { startEndpoint } from "../src/endpoint"
import type { Journal, JournalListOptions, RunSummary } from "../src/journal"
import { createRunStore, type PendingInteraction, type RunSnapshot } from "../src/runs"
import { makeFakeClient } from "./fake-client"

function snapshot(): RunSnapshot {
  return {
    runId: "run-endpoint",
    workflow: "endpoint-test",
    provenance: "inline",
    parentSessionID: "parent",
    status: "running",
    phases: [],
    phasesDeclared: false,
    currentPhase: null,
    units: [],
    logs: [],
    errors: [],
    interactions: [],
    resolved: [],
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

/**
 * History is a separate read from `/state` on purpose: `/state` is re-sent on every reconnect, and a project
 * accumulates runs forever. These assert the paging contract that makes that separation worth having.
 */
describe("workflow endpoint: GET /history", () => {
  function summary(runId: string, status: RunSnapshot["status"], startedAt: number): RunSummary {
    return {
      runId,
      workflow: "greet",
      provenance: "inline",
      parentSessionID: "parent",
      status,
      units: 1,
      settledUnits: 1,
      tokensSpent: 10,
      phases: ["plan"],
      phasesDeclared: true,
      currentPhase: "plan",
      startedAt,
      endedAt: startedAt + 1_000,
    }
  }

  const stored = [summary("a", "done", 3_000), summary("b", "failed", 2_000), summary("c", "done", 1_000)]

  /** A structural `Journal` reader: the endpoint's only contract with the journal is `list` and `read`. */
  function history(): Pick<Journal, "list" | "read"> & { calls: JournalListOptions[] } {
    const calls: JournalListOptions[] = []
    return {
      calls,
      async list(options = {}) {
        calls.push(options)
        const filtered = options.status ? stored.filter((s) => options.status?.includes(s.status)) : stored
        return options.limit === undefined ? filtered : filtered.slice(0, options.limit)
      },
      async read(runId) {
        const found = stored.find((s) => s.runId === runId)
        if (!found) return null
        return { run: { runId } as never, source: "SOURCE", args: null, result: "value", transitions: [] }
      },
    }
  }

  it("serves history to an authenticated reader and refuses an anonymous one", async () => {
    const endpoint = await startEndpoint(createRunStore(), {}, { history: history() })
    if (!endpoint) throw new Error("expected endpoint")
    try {
      expect((await fetch(`${endpoint.url}/history`)).status).toBe(401)
      const response = await fetch(`${endpoint.url}/history`, {
        headers: { authorization: `Bearer ${endpoint.token}` },
      })
      expect(response.status).toBe(200)
      expect(((await response.json()) as { history: RunSummary[] }).history.map((s) => s.runId)).toEqual([
        "a",
        "b",
        "c",
      ])
    } finally {
      await endpoint.stop()
    }
  })

  it("passes limit and status through, accepting repeated and comma-joined statuses alike", async () => {
    const reader = history()
    const endpoint = await startEndpoint(createRunStore(), {}, { history: reader })
    if (!endpoint) throw new Error("expected endpoint")
    try {
      const limited = await fetch(`${endpoint.url}/history?limit=2&token=${endpoint.token}`)
      expect(((await limited.json()) as { history: RunSummary[] }).history).toHaveLength(2)

      await fetch(`${endpoint.url}/history?status=done&status=failed&token=${endpoint.token}`)
      await fetch(`${endpoint.url}/history?status=done,failed&token=${endpoint.token}`)
      expect(reader.calls.at(-1)).toEqual(reader.calls.at(-2) as JournalListOptions)
      expect(reader.calls.at(-1)?.status).toEqual(["done", "failed"])

      // Nonsense is ignored rather than 400-ing: a filter the server does not know is a filter it does not apply.
      await fetch(`${endpoint.url}/history?limit=nope&status=sideways&token=${endpoint.token}`)
      expect(reader.calls.at(-1)).toEqual({})
    } finally {
      await endpoint.stop()
    }
  })

  it("serves one journaled record by id, and 404s an id it has never recorded", async () => {
    const endpoint = await startEndpoint(createRunStore(), {}, { history: history() })
    if (!endpoint) throw new Error("expected endpoint")
    try {
      const found = await fetch(`${endpoint.url}/history/a?token=${endpoint.token}`)
      expect(found.status).toBe(200)
      expect((await found.json()) as { record: { source: string } }).toMatchObject({ record: { source: "SOURCE" } })
      expect((await fetch(`${endpoint.url}/history/ghost?token=${endpoint.token}`)).status).toBe(404)
    } finally {
      await endpoint.stop()
    }
  })

  it("answers with an empty history when the engine has no journal at all", async () => {
    // A host with no resolvable project root has nowhere to write runs. Empty is the honest answer; an error
    // would make the client's history section look broken rather than unused.
    const endpoint = await startEndpoint(createRunStore())
    if (!endpoint) throw new Error("expected endpoint")
    try {
      const response = await fetch(`${endpoint.url}/history?token=${endpoint.token}`)
      expect(await response.json()).toEqual({ history: [] })
      expect((await fetch(`${endpoint.url}/history/a?token=${endpoint.token}`)).status).toBe(404)
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

/**
 * Interaction control — the write direction that carries a decision rather than a cancellation.
 *
 * ONE dispatch path for both origins is the point: a script-raised question is settled inside this process and
 * an agent-raised one is forwarded to the host, and the caller sends the same action either way.
 */
describe("workflow endpoint: interaction control", () => {
  function pending(overrides: Partial<PendingInteraction> = {}): PendingInteraction {
    return {
      requestID: "req-1",
      kind: "question",
      origin: "agent",
      sessionID: "ses_child",
      unitId: null,
      depth: 2,
      phase: null,
      questions: [
        {
          header: "Region",
          prompt: "Which region?",
          options: [
            { label: "US", description: "" },
            { label: "EU", description: "" },
          ],
          multiple: false,
          custom: false,
        },
      ],
      raisedAt: Date.now(),
      graceEndsAt: Date.now() + 10_000,
      ...overrides,
    }
  }

  function engine(interaction: PendingInteraction = pending()) {
    const store = createRunStore()
    store.create(snapshot())
    store.apply({ type: "interaction.pending", runId: "run-endpoint", interaction })
    const client = makeFakeClient()
    const registry = createControlRegistry({ interactions: createInteractionController(client, store) })
    registry.registerRun("run-endpoint", new AbortController())
    return { store, client, registry }
  }

  async function post(url: string, token: string, body: unknown): Promise<Response> {
    return fetch(`${url}/control`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify(body),
    })
  }

  it("forwards an agent question's answer to the host and takes the row off the run", async () => {
    const { store, client, registry } = engine()
    const endpoint = await startEndpoint(store, {}, { control: registry })
    if (!endpoint) throw new Error("expected endpoint")
    try {
      const response = await post(endpoint.url, endpoint.token, {
        action: "question.reply",
        runId: "run-endpoint",
        requestID: "req-1",
        answers: [["EU"]],
      })
      expect(response.status).toBe(200)
      expect(await response.json()).toEqual({ ok: true })
      expect(client.questionReplies).toEqual([{ requestID: "req-1", answers: [["EU"]] }])
      // Cleared immediately rather than on the watcher's next poll: the surface that answered should not have
      // to watch its own question sit there.
      expect(store.get("run-endpoint")?.interactions).toEqual([])
    } finally {
      await endpoint.stop()
    }
  })

  it("settles a SCRIPT question locally, never touching the host", async () => {
    const store = createRunStore()
    store.create(snapshot())
    const interaction = pending({ requestID: "script-1", origin: "script" })
    store.apply({ type: "interaction.pending", runId: "run-endpoint", interaction })
    const client = makeFakeClient()
    const registry = createControlRegistry({ interactions: createInteractionController(client, store) })
    registry.registerRun("run-endpoint", new AbortController())
    const answered: string[][][] = []
    registry.registerInteractions("run-endpoint", {
      answer: (requestID, answers) => {
        if (requestID !== "script-1") return false
        answered.push(answers)
        return true
      },
      handOff: () => false,
    })

    const endpoint = await startEndpoint(store, {}, { control: registry })
    if (!endpoint) throw new Error("expected endpoint")
    try {
      const response = await post(endpoint.url, endpoint.token, {
        action: "question.reply",
        runId: "run-endpoint",
        requestID: "script-1",
        answers: [["EU"]],
      })
      expect(await response.json()).toEqual({ ok: true })
      expect(answered).toEqual([[["EU"]]])
      // The host has no such question; forwarding one would be answering somebody else's.
      expect(client.questionReplies).toEqual([])
    } finally {
      await endpoint.stop()
    }
  })

  it("refuses a request this run never published — a surface cannot answer somebody else's question", async () => {
    const { store, client, registry } = engine()
    const endpoint = await startEndpoint(store, {}, { control: registry })
    if (!endpoint) throw new Error("expected endpoint")
    try {
      const response = await post(endpoint.url, endpoint.token, {
        action: "question.reply",
        runId: "run-endpoint",
        requestID: "somebody-elses",
        answers: [["EU"]],
      })
      expect(response.status).toBe(404)
      expect(await response.json()).toEqual({ ok: false, reason: "unknown-request" })
      expect(client.questionReplies).toEqual([])
    } finally {
      await endpoint.stop()
    }
  })

  it("hands a question back to automation on reject, through the run's own sink", async () => {
    const { store, client, registry } = engine()
    const handed: string[] = []
    registry.registerInteractions("run-endpoint", {
      answer: () => false,
      handOff: (requestID) => {
        handed.push(requestID)
        return true
      },
    })
    const endpoint = await startEndpoint(store, {}, { control: registry })
    if (!endpoint) throw new Error("expected endpoint")
    try {
      const response = await post(endpoint.url, endpoint.token, {
        action: "question.reject",
        runId: "run-endpoint",
        requestID: "req-1",
      })
      expect(await response.json()).toEqual({ ok: true })
      expect(handed).toEqual(["req-1"])
      // Leaving a question for automation is NOT rejecting it at the host — the ladder may still ground it.
      expect(client.questionRejects).toEqual([])
    } finally {
      await endpoint.stop()
    }
  })

  it("replies to a permission, and refuses a reply that is not one of the three", async () => {
    const { store, client, registry } = engine(pending({ kind: "permission" }))
    const endpoint = await startEndpoint(store, {}, { control: registry })
    if (!endpoint) throw new Error("expected endpoint")
    try {
      const ok = await post(endpoint.url, endpoint.token, {
        action: "permission.reply",
        runId: "run-endpoint",
        requestID: "req-1",
        reply: "once",
      })
      expect(await ok.json()).toEqual({ ok: true })
      expect(client.permissionReplies).toEqual([{ requestID: "req-1", reply: "once" }])

      const bad = await post(endpoint.url, endpoint.token, {
        action: "permission.reply",
        runId: "run-endpoint",
        requestID: "req-1",
        reply: "sideways",
      })
      expect(bad.status).toBe(400)
    } finally {
      await endpoint.stop()
    }
  })

  it("rejects a malformed answers payload before it can reach the host", async () => {
    const { store, client, registry } = engine()
    const endpoint = await startEndpoint(store, {}, { control: registry })
    if (!endpoint) throw new Error("expected endpoint")
    try {
      // `string[]` where `string[][]` belongs: the host would silently mis-read it.
      const flat = await post(endpoint.url, endpoint.token, {
        action: "question.reply",
        runId: "run-endpoint",
        requestID: "req-1",
        answers: ["EU"],
      })
      expect(flat.status).toBe(400)
      expect(client.questionReplies).toEqual([])
    } finally {
      await endpoint.stop()
    }
  })

  it("reports whether anyone is attached, which is what gives a human first refusal", async () => {
    const endpoint = await startEndpoint(createRunStore())
    if (!endpoint) throw new Error("expected endpoint")
    try {
      expect(endpoint.attached()).toBe(false)
      const stream = new AbortController()
      const response = await fetch(`${endpoint.url}/events`, {
        headers: { authorization: `Bearer ${endpoint.token}` },
        signal: stream.signal,
      })
      await waitFor(() => endpoint.attached())
      expect(endpoint.attached()).toBe(true)
      await response.body?.cancel()
      stream.abort()
      await waitFor(() => !endpoint.attached())
    } finally {
      await endpoint.stop()
    }
  })
})
