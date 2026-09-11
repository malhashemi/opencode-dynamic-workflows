import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { describe, expect, it } from "bun:test"
import { createControlRegistry, createInteractionController } from "../src/control"
import { readEndpointPreference, writeDescriptor } from "../src/discovery"
import { startEndpoint, type RunOrigin } from "../src/endpoint"
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
  it("answers a bare loopback read on every route — the deliberate security shape — and still takes a token", async () => {
    // Loopback-only plus same-user is the same trust boundary the host's own `opencode serve` runs inside;
    // the token used to buy a re-handoff dance on every restart, not protection. A presented token (right or
    // wrong) changes nothing on loopback — the routes were already open.
    const store = createRunStore()
    store.create(snapshot())
    const endpoint = await startEndpoint(store)
    if (!endpoint) throw new Error("expected endpoint")
    expect(store.subscribers()).toBe(1)
    expect(endpoint.loopback).toBe(true)
    try {
      const bare = await fetch(`${endpoint.url}/state`)
      expect(bare.status).toBe(200)
      expect(await bare.json()).toMatchObject({ runs: [{ runId: "run-endpoint", workflow: "endpoint-test" }] })
      expect((await fetch(`${endpoint.url}/state`, { headers: { authorization: "Bearer wrong" } })).status).toBe(200)
      const state = await fetch(`${endpoint.url}/state`, { headers: { authorization: `Bearer ${endpoint.token}` } })
      expect(state.status).toBe(200)
      const health = await fetch(`${endpoint.url}/health`)
      expect(await health.json()).toEqual({ ok: true })
      expect((await fetch(`${endpoint.url}/history`)).status).toBe(200)
      const events = await fetch(`${endpoint.url}/events`, { signal: AbortSignal.timeout(500) }).catch(() => null)
      // The stream opened bare; the timeout abort is just this test declining to hold it.
      if (events) {
        expect(events.status).toBe(200)
        await events.body?.cancel().catch(() => {})
      }
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

  it("keeps bearer/query-token auth on a non-loopback bind, exactly as before", async () => {
    // The trust-boundary argument above is loopback's alone. A deliberately wider bind is reachable by other
    // machines, so the API routes keep the token gate byte for byte.
    const endpoint = await startEndpoint(createRunStore(), { host: "0.0.0.0" })
    if (!endpoint) throw new Error("expected endpoint")
    expect(endpoint.loopback).toBe(false)
    const base = `http://127.0.0.1:${new URL(endpoint.url).port}`
    try {
      expect((await fetch(`${base}/state`)).status).toBe(401)
      expect((await fetch(`${base}/state`, { headers: { authorization: "Bearer wrong" } })).status).toBe(401)
      expect((await fetch(`${base}/state`, { headers: { authorization: `Bearer ${endpoint.token}` } })).status).toBe(200)
      expect((await fetch(`${base}/state?token=${endpoint.token}`)).status).toBe(200)
    } finally {
      await endpoint.stop()
    }
  })

  it("supports explicit disable", async () => {
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

  it("dispatches a bare loopback write — control is inside the same trust boundary as the reads", async () => {
    const registry = createControlRegistry()
    const controller = new AbortController()
    registry.registerRun("run-endpoint", controller)
    const endpoint = await startEndpoint(createRunStore(), {}, { control: registry })
    if (!endpoint) throw new Error("expected endpoint")
    try {
      const response = await control({ action: "stop.run", runId: "run-endpoint" }, { url: endpoint.url })
      expect(response.status).toBe(200)
      expect(await response.json()).toEqual({ ok: true })
      expect(controller.signal.aborted).toBe(true)
    } finally {
      await endpoint.stop()
    }
  })

  it("still refuses an unauthenticated write on a non-loopback bind, before it reaches the registry", async () => {
    const registry = createControlRegistry()
    const controller = new AbortController()
    registry.registerRun("run-endpoint", controller)
    const endpoint = await startEndpoint(createRunStore(), { host: "0.0.0.0" }, { control: registry })
    if (!endpoint) throw new Error("expected endpoint")
    const base = `http://127.0.0.1:${new URL(endpoint.url).port}`
    try {
      const response = await control({ action: "stop.run", runId: "run-endpoint" }, { url: base })
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

  it("serves history to a bare loopback reader — the anonymous read IS the authenticated read there", async () => {
    const endpoint = await startEndpoint(createRunStore(), {}, { history: history() })
    if (!endpoint) throw new Error("expected endpoint")
    try {
      expect((await fetch(`${endpoint.url}/history`)).status).toBe(200)
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

/**
 * The dashboard's delivery path (Phase 5, amended): static assets from `/`, unauthenticated on every bind —
 * they carry no run state. On loopback (the default) the API behind them is open too; only a non-loopback
 * bind still treats the link's `?token=` as the credential handoff for the CLIENT to replay as a bearer.
 */
describe("workflow endpoint: dashboard assets", () => {
  async function withAssets(
    body: (endpoint: NonNullable<Awaited<ReturnType<typeof startEndpoint>>>, dist: string) => Promise<void>,
  ): Promise<void> {
    const dist = await mkdtemp(path.join(os.tmpdir(), "wf-dashboard-dist-"))
    await mkdir(path.join(dist, "assets"), { recursive: true })
    await writeFile(path.join(dist, "index.html"), "<!doctype html><div id=\"root\"></div>", "utf8")
    await writeFile(path.join(dist, "assets", "index-abc.js"), "console.log(\"dashboard\")", "utf8")
    await writeFile(path.join(dist, "secret-sibling.txt"), "outside is outside", "utf8")
    const endpoint = await startEndpoint(createRunStore(), { assets: dist })
    if (!endpoint) throw new Error("expected endpoint")
    try {
      await body(endpoint, dist)
    } finally {
      await endpoint.stop()
      await rm(dist, { recursive: true, force: true })
    }
  }

  it("serves the app shell and its hashed assets without a token, typed and nosniffed", async () => {
    await withAssets(async (endpoint) => {
      const shell = await fetch(`${endpoint.url}/`)
      expect(shell.status).toBe(200)
      expect(shell.headers.get("content-type")).toContain("text/html")
      expect(await shell.text()).toContain('<div id="root">')

      const script = await fetch(`${endpoint.url}/assets/index-abc.js`)
      expect(script.status).toBe(200)
      expect(script.headers.get("content-type")).toContain("javascript")
      expect(script.headers.get("cache-control")).toContain("immutable")
      expect(script.headers.get("x-content-type-options")).toBe("nosniff")
    })
  })

  it("serves the whole app to a bare loopback link — shell, wrong token, no token, and the API behind it", async () => {
    await withAssets(async (endpoint) => {
      // The link a run summary carries on loopback is BARE, and everything works from it: the shell, a stale
      // bookmarked `?token=` from before a restart, and the API the shell then calls without a credential.
      expect((await fetch(`${endpoint.url}/`)).status).toBe(200)
      expect((await fetch(`${endpoint.url}/?token=wrong`)).status).toBe(200)
      expect((await fetch(`${endpoint.url}/state`)).status).toBe(200)
      expect((await fetch(`${endpoint.url}/history`)).status).toBe(200)
      expect((await fetch(`${endpoint.url}/state?token=${endpoint.token}`)).status).toBe(200)
    })
  })

  it("keeps the token handoff on a non-loopback bind: assets open, API gated", async () => {
    const dist = await mkdtemp(path.join(os.tmpdir(), "wf-dashboard-wide-"))
    await writeFile(path.join(dist, "index.html"), "<!doctype html><div id=\"root\"></div>", "utf8")
    const endpoint = await startEndpoint(createRunStore(), { host: "0.0.0.0", assets: dist })
    if (!endpoint) throw new Error("expected endpoint")
    const base = `http://127.0.0.1:${new URL(endpoint.url).port}`
    try {
      // The shell still loads bare (public code), the query token is still the client's handoff, and the API
      // keeps its 401 — the pre-amendment shape, preserved exactly where the trust boundary is wider.
      expect((await fetch(`${base}/?token=${endpoint.token}`)).status).toBe(200)
      expect((await fetch(`${base}/state`)).status).toBe(401)
      expect((await fetch(`${base}/state?token=${endpoint.token}`)).status).toBe(200)
    } finally {
      await endpoint.stop()
      await rm(dist, { recursive: true, force: true })
    }
  })

  it("404s unknown paths and refuses traversal out of the dist", async () => {
    await withAssets(async (endpoint) => {
      expect((await fetch(`${endpoint.url}/nope.js`)).status).toBe(404)
      expect((await fetch(`${endpoint.url}/deep/nope`)).status).toBe(404)
      // An encoded `..` decodes to a path outside the root; containment turns it into a 404, not a file.
      expect((await fetch(`${endpoint.url}/assets/%2e%2e/secret-sibling.txt`)).status).toBe(200) // still inside dist
      expect((await fetch(`${endpoint.url}/%2e%2e/%2e%2e/etc/passwd`)).status).toBe(404)
      // Non-GET on an asset path is a method error, not a file.
      expect((await fetch(`${endpoint.url}/`, { method: "POST" })).status).toBe(405)
    })
  })

  it("serves a run-the-build notice when the dist is absent, and nothing else", async () => {
    const empty = await mkdtemp(path.join(os.tmpdir(), "wf-dashboard-missing-"))
    const endpoint = await startEndpoint(createRunStore(), { assets: path.join(empty, "never-built") })
    if (!endpoint) throw new Error("expected endpoint")
    try {
      const shell = await fetch(`${endpoint.url}/`)
      expect(shell.status).toBe(200)
      expect(await shell.text()).toContain("build:dashboard")
      expect((await fetch(`${endpoint.url}/assets/anything.js`)).status).toBe(404)
    } finally {
      await endpoint.stop()
      await rm(empty, { recursive: true, force: true })
    }
  })

  it("stays API-only under `assets: false` — `/` names no route, and a wider bind still 401s it first", async () => {
    const endpoint = await startEndpoint(createRunStore(), { assets: false })
    if (!endpoint) throw new Error("expected endpoint")
    try {
      // On loopback nothing gates `/` any more, so the honest answer is the router's: not found.
      expect((await fetch(`${endpoint.url}/`)).status).toBe(404)
      expect((await fetch(`${endpoint.url}/?token=${endpoint.token}`)).status).toBe(404)
    } finally {
      await endpoint.stop()
    }

    const wide = await startEndpoint(createRunStore(), { host: "0.0.0.0", assets: false })
    if (!wide) throw new Error("expected endpoint")
    const base = `http://127.0.0.1:${new URL(wide.url).port}`
    try {
      expect((await fetch(`${base}/`)).status).toBe(401)
      expect((await fetch(`${base}/?token=${wide.token}`)).status).toBe(404)
    } finally {
      await wide.stop()
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

/**
 * The stable address: `{ port, token }` persisted per worktree, so the dashboard URL a reply carried yesterday
 * — and the tab still open on it — survives a host restart. The second-host case is the deliberate exception:
 * it falls back to an ephemeral port and leaves the preference alone, so the FIRST host keeps the address.
 */
describe("workflow endpoint: stable address", () => {
  async function withStateDir(body: (statePath: string, worktree: string) => Promise<void>): Promise<void> {
    const root = await mkdtemp(path.join(os.tmpdir(), "wf-endpoint-state-"))
    try {
      await body(path.join(root, "state"), path.join(root, "worktree"))
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  }

  it("persists the first boot's OS-assigned port and token, and reuses both on the next boot", async () => {
    await withStateDir(async (statePath, worktree) => {
      const first = await startEndpoint(createRunStore(), {}, { discovery: { statePath, worktree } })
      if (!first) throw new Error("expected endpoint")
      const port = Number(new URL(first.url).port)
      const token = first.token
      expect(await readEndpointPreference(statePath, worktree)).toEqual({ port, token })
      await first.stop()

      const second = await startEndpoint(createRunStore(), {}, { discovery: { statePath, worktree } })
      if (!second) throw new Error("expected endpoint")
      try {
        expect(Number(new URL(second.url).port)).toBe(port)
        expect(second.token).toBe(token)
      } finally {
        await second.stop()
      }
    })
  })

  it("falls back to an ephemeral port for a second live host WITHOUT overwriting the preference", async () => {
    await withStateDir(async (statePath, worktree) => {
      const first = await startEndpoint(createRunStore(), {}, { discovery: { statePath, worktree } })
      if (!first) throw new Error("expected endpoint")
      const preference = await readEndpointPreference(statePath, worktree)
      const second = await startEndpoint(createRunStore(), {}, { discovery: { statePath, worktree } })
      if (!second) throw new Error("expected endpoint")
      try {
        // The second host is live and reachable — just not at the stable address, which the first one keeps.
        expect(second.url).not.toBe(first.url)
        expect(second.token).toBe(first.token)
        expect((await fetch(`${second.url}/health`)).status).toBe(200)
        expect((await fetch(`${first.url}/health`)).status).toBe(200)
        expect(await readEndpointPreference(statePath, worktree)).toEqual(preference as { port: number; token: string })
      } finally {
        await second.stop()
        await first.stop()
      }
    })
  })

  it("keeps a worktree's address distinct from its neighbour's", async () => {
    await withStateDir(async (statePath, worktree) => {
      const here = await startEndpoint(createRunStore(), {}, { discovery: { statePath, worktree } })
      const there = await startEndpoint(createRunStore(), {}, { discovery: { statePath, worktree: `${worktree}-b` } })
      if (!here || !there) throw new Error("expected endpoints")
      try {
        expect(here.url).not.toBe(there.url)
        expect(here.token).not.toBe(there.token)
      } finally {
        await here.stop()
        await there.stop()
      }
    })
  })
})

/**
 * `?scope=everywhere` — the machine's other endpoints, merged SERVER-side off their descriptors, each row
 * tagged with its origin; controls on a foreign run proxied to the endpoint that owns it. Resilience is part
 * of the contract: a dead peer descriptor is skipped, never an error.
 */
describe("workflow endpoint: everywhere scope", () => {
  const alwaysAlive = () => true

  function peerSnapshot(runId: string): RunSnapshot {
    return { ...snapshot(), runId }
  }

  async function withMachine(
    body: (input: {
      statePath: string
      main: NonNullable<Awaited<ReturnType<typeof startEndpoint>>>
      peer: NonNullable<Awaited<ReturnType<typeof startEndpoint>>>
      peerWorktree: string
      peerRegistry: ReturnType<typeof createControlRegistry>
    }) => Promise<void>,
  ): Promise<void> {
    const root = await mkdtemp(path.join(os.tmpdir(), "wf-endpoint-peers-"))
    const statePath = path.join(root, "state")
    const mainWorktree = path.join(root, "main-project")
    const peerWorktree = path.join(root, "peer-project")

    const peerStore = createRunStore()
    peerStore.create(peerSnapshot("run-peer"))
    const peerRegistry = createControlRegistry()
    const peerHistory: Pick<Journal, "list" | "read"> = {
      async list() {
        return [
          {
            runId: "hist-peer",
            workflow: "peer-flow",
            provenance: "inline",
            parentSessionID: "peer-session",
            status: "done",
            units: 1,
            settledUnits: 1,
            tokensSpent: 5,
            phases: [],
            phasesDeclared: false,
            currentPhase: null,
            startedAt: 5_000,
            endedAt: 6_000,
          },
        ]
      },
      async read(runId) {
        if (runId !== "hist-peer") return null
        return { run: peerSnapshot("hist-peer"), source: "PEER SOURCE", args: null, result: "peer", transitions: [] }
      },
    }
    const peer = await startEndpoint(peerStore, {}, { control: peerRegistry, history: peerHistory })
    if (!peer) throw new Error("expected peer endpoint")

    const main = await startEndpoint(
      createRunStore(),
      {},
      { control: createControlRegistry(), discovery: { statePath, worktree: mainWorktree, isProcessAlive: alwaysAlive } },
    )
    if (!main) throw new Error("expected main endpoint")

    // The peer's rendezvous entry, as its own plugin would have written it. The pid is fictional; liveness is
    // injected above so the descriptor read keeps it.
    await writeDescriptor(statePath, {
      url: peer.url,
      token: peer.token,
      pid: 999_999,
      directory: peerWorktree,
      worktree: peerWorktree,
      startedAt: Date.now(),
    })

    try {
      await body({ statePath, main, peer, peerWorktree, peerRegistry })
    } finally {
      await main.stop()
      await peer.stop()
      await rm(root, { recursive: true, force: true })
    }
  }

  it("merges a peer's runs and history under the flag, tagged with their origin — and only under the flag", async () => {
    await withMachine(async ({ main, peer, peerWorktree }) => {
      const plain = (await (await fetch(`${main.url}/state`)).json()) as { runs: RunSnapshot[] }
      expect(plain.runs).toHaveLength(0)

      const merged = (await (await fetch(`${main.url}/state?scope=everywhere`)).json()) as {
        runs: (RunSnapshot & { origin?: RunOrigin })[]
      }
      expect(merged.runs.map((run) => run.runId)).toEqual(["run-peer"])
      expect(merged.runs[0]?.origin).toEqual({ worktree: peerWorktree, url: peer.url })

      const history = (await (await fetch(`${main.url}/history?scope=everywhere`)).json()) as {
        history: ({ runId: string } & { origin?: RunOrigin })[]
      }
      expect(history.history.map((row) => row.runId)).toEqual(["hist-peer"])
      expect(history.history[0]?.origin).toEqual({ worktree: peerWorktree, url: peer.url })
      // …and the un-flagged read stays byte-compatible with the single-endpoint world.
      const local = (await (await fetch(`${main.url}/history`)).json()) as { history: unknown[] }
      expect(local.history).toHaveLength(0)
    })
  })

  it("skips a dead peer descriptor rather than failing the merge", async () => {
    await withMachine(async ({ statePath, main }) => {
      await writeDescriptor(statePath, {
        url: "http://127.0.0.1:9", // the discard port: nothing listens, the connection dies fast
        token: "dead-peer-token",
        pid: 999_998,
        directory: "/tmp/dead-project",
        worktree: "/tmp/dead-project",
        startedAt: Date.now(),
      })
      const merged = (await (await fetch(`${main.url}/state?scope=everywhere`)).json()) as { runs: RunSnapshot[] }
      expect(merged.runs.map((run) => run.runId)).toEqual(["run-peer"])
    })
  })

  it("proxies a control action to the peer that owns the run", async () => {
    await withMachine(async ({ main, peerRegistry }) => {
      const controller = new AbortController()
      peerRegistry.registerRun("run-peer", controller)
      const response = await fetch(`${main.url}/control`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action: "stop.run", runId: "run-peer" }),
      })
      expect(response.status).toBe(200)
      expect(await response.json()).toEqual({ ok: true })
      expect(controller.signal.aborted).toBe(true)
    })
  })

  it("serves a peer's journaled record for a foreign history row", async () => {
    await withMachine(async ({ main }) => {
      const response = await fetch(`${main.url}/history/hist-peer`)
      expect(response.status).toBe(200)
      expect((await response.json()) as { record: { source: string } }).toMatchObject({
        record: { source: "PEER SOURCE" },
      })
    })
  })

  it("answers unknown-run for a run nobody owns, without bouncing between endpoints", async () => {
    await withMachine(async ({ main }) => {
      // The peer would proxy back if the `proxied=1` guard failed — this call would then never return.
      const response = await fetch(`${main.url}/control`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action: "stop.run", runId: "ghost" }),
      })
      expect(response.status).toBe(404)
      expect(await response.json()).toEqual({ ok: false, reason: "unknown-run" })
    })
  })
})
