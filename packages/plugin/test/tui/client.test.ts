import { describe, expect, it } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { writeDescriptor } from "../../src/discovery"
import type { RunSummary } from "../../src/journal"
import type { RunEvent, RunSnapshot } from "../../src/runs"
import { createRunClient, type RunClientFetch } from "../../src/tui/client"
import { createControlClient } from "../../src/tui/control"

function snapshot(): RunSnapshot {
  return {
    runId: "run-race",
    workflow: "research",
    provenance: "durable",
    parentSessionID: "parent",
    status: "running",
    phases: [],
    phasesDeclared: false,
    currentPhase: null,
    units: [],
    logs: ["already in snapshot"],
    errors: [],
    interactions: [],
    tokensSpent: 0,
    startedAt: 1,
    endedAt: null,
  }
}

describe("TUI run client", () => {
  it("uses the snapshot revision to skip already-applied buffered SSE events", async () => {
    const statePath = await mkdtemp(path.join(os.tmpdir(), "wf-tui-client-"))
    const event: RunEvent = { type: "run.log", runId: "run-race", value: "already in snapshot" }
    await writeDescriptor(statePath, {
      url: "http://127.0.0.1:54321",
      token: "token",
      pid: process.pid,
      directory: "/project",
      worktree: "/project",
      startedAt: Date.now(),
    })

    const fetcher: RunClientFetch = async (input) => {
      const url = String(input)
      if (url.endsWith("/state")) return Response.json({ runs: [snapshot()], revision: 1 })
      if (url.endsWith("/events")) {
        return new Response(
          new ReadableStream({
            start(controller) {
              controller.enqueue(new TextEncoder().encode(`id: 1\ndata: ${JSON.stringify(event)}\n\n`))
              controller.close()
            },
          }),
          { headers: { "content-type": "text/event-stream" } },
        )
      }
      return new Response(null, { status: 404 })
    }

    const client = createRunClient({
      statePath,
      fetch: fetcher,
      rescanMs: 60_000,
      reconnectMinMs: 1_000,
      reconnectMaxMs: 1_000,
    })
    try {
      await waitFor(() => client.runs().length === 1)
      await new Promise((resolve) => setTimeout(resolve, 20))
      expect(client.runs()[0]?.logs).toEqual(["already in snapshot"])
    } finally {
      client.stop()
      await rm(statePath, { recursive: true, force: true })
    }
  })

  it("names the endpoint that owns each run, so a write reaches the host the snapshot came from", async () => {
    const statePath = await mkdtemp(path.join(os.tmpdir(), "wf-tui-owner-"))
    await writeDescriptor(statePath, {
      url: "http://127.0.0.1:54321",
      token: "owner-token",
      pid: process.pid,
      directory: "/project",
      worktree: "/project",
      startedAt: Date.now(),
    })

    const fetcher: RunClientFetch = async (input) => {
      const url = String(input)
      if (url.endsWith("/state")) return Response.json({ runs: [snapshot()], revision: 0 })
      if (url.endsWith("/events")) {
        return new Response(new ReadableStream({ start: (controller) => controller.close() }), {
          headers: { "content-type": "text/event-stream" },
        })
      }
      return new Response(null, { status: 404 })
    }

    const client = createRunClient({ statePath, fetch: fetcher, rescanMs: 60_000 })
    try {
      await waitFor(() => client.runs().length === 1)
      expect(client.endpointFor("run-race")).toMatchObject({ url: "http://127.0.0.1:54321", token: "owner-token" })
      expect(client.endpointFor("nobody")).toBeUndefined()

      // The descriptor is copied out, so a caller cannot mutate the client's own record of who owns what.
      const descriptor = client.endpointFor("run-race")
      if (descriptor) descriptor.token = "tampered"
      expect(client.endpointFor("run-race")?.token).toBe("owner-token")
    } finally {
      client.stop()
      await rm(statePath, { recursive: true, force: true })
    }
  })
})

describe("TUI run client: history", () => {
  function summary(runId: string, startedAt: number): RunSummary {
    return {
      runId,
      workflow: "research",
      provenance: "inline",
      status: "done",
      units: 1,
      settledUnits: 1,
      tokensSpent: 5,
      phases: ["plan"],
      phasesDeclared: true,
      currentPhase: "plan",
      startedAt,
      endedAt: startedAt + 10,
    }
  }

  /** A descriptor-backed endpoint whose `/events` stream the test controls. */
  async function harness(options: {
    history: () => RunSummary[]
    onHistoryRequest?: (url: string) => void
    events?: (push: (event: RunEvent) => void) => void
  }) {
    const statePath = await mkdtemp(path.join(os.tmpdir(), "wf-tui-history-"))
    await writeDescriptor(statePath, {
      url: "http://127.0.0.1:54321",
      token: "history-token",
      pid: process.pid,
      directory: "/project",
      worktree: "/project",
      startedAt: Date.now(),
    })
    const fetcher: RunClientFetch = async (input) => {
      const url = String(input)
      if (url.endsWith("/state")) return Response.json({ runs: [snapshot()], revision: 0 })
      if (url.includes("/history")) {
        options.onHistoryRequest?.(url)
        return Response.json({ history: options.history() })
      }
      if (url.endsWith("/events")) {
        return new Response(
          new ReadableStream({
            start(controller) {
              const push = (event: RunEvent) =>
                controller.enqueue(new TextEncoder().encode(`id: 9\ndata: ${JSON.stringify(event)}\n\n`))
              options.events?.(push)
            },
          }),
          { headers: { "content-type": "text/event-stream" } },
        )
      }
      return new Response(null, { status: 404 })
    }
    const client = createRunClient({ statePath, fetch: fetcher, rescanMs: 60_000, historyLimit: 50 })
    return { client, statePath }
  }

  it("reads history on connect, newest first, and asks for the configured page size", async () => {
    const urls: string[] = []
    const { client, statePath } = await harness({
      history: () => [summary("old", 1_000), summary("new", 5_000)],
      onHistoryRequest: (url) => urls.push(url),
    })
    try {
      await waitFor(() => client.history().length === 2)
      expect(client.history().map((entry) => entry.runId)).toEqual(["new", "old"])
      expect(urls[0]).toBe("http://127.0.0.1:54321/history?limit=50")
    } finally {
      client.stop()
      await rm(statePath, { recursive: true, force: true })
    }
  })

  it("re-reads history when a run ends, which is exactly when the journal has just written one", async () => {
    let served = [summary("first", 1_000)]
    const stream: { push?: (event: RunEvent) => void } = {}
    const { client, statePath } = await harness({
      history: () => served,
      events: (emit) => {
        stream.push = emit
      },
    })
    try {
      await waitFor(() => client.history().length === 1)
      served = [summary("first", 1_000), summary("second", 2_000)]
      stream.push?.({ type: "run.ended", run: { ...snapshot(), status: "done", endedAt: 2 } })
      await waitFor(() => client.history().length === 2)
      expect(client.history().map((entry) => entry.runId)).toEqual(["second", "first"])
    } finally {
      client.stop()
      await rm(statePath, { recursive: true, force: true })
    }
  })

  it("names the endpoint that journaled a run, so `save` reaches a host whose run is long over", async () => {
    // The live `runs()` merge cannot answer this: a history-only run has no snapshot and therefore no owner
    // in the live table. Without this, `s` on a history row would answer `unknown-run` forever.
    const { client, statePath } = await harness({ history: () => [summary("archived", 1_000)] })
    try {
      await waitFor(() => client.history().length === 1)
      expect(client.endpointFor("archived")).toMatchObject({ url: "http://127.0.0.1:54321", token: "history-token" })
    } finally {
      client.stop()
      await rm(statePath, { recursive: true, force: true })
    }
  })

  it("keeps the last good history when a read fails, rather than emptying the section", async () => {
    let fail = false
    const statePath = await mkdtemp(path.join(os.tmpdir(), "wf-tui-history-fail-"))
    await writeDescriptor(statePath, {
      url: "http://127.0.0.1:54321",
      token: "t",
      pid: process.pid,
      directory: "/project",
      worktree: "/project",
      startedAt: Date.now(),
    })
    const fetcher: RunClientFetch = async (input) => {
      const url = String(input)
      if (url.endsWith("/state")) return Response.json({ runs: [], revision: 0 })
      if (url.includes("/history")) {
        if (fail) throw new Error("endpoint went away")
        return Response.json({ history: [summary("kept", 1_000)] })
      }
      return new Response(new ReadableStream({ start: (controller) => controller.close() }), {
        headers: { "content-type": "text/event-stream" },
      })
    }
    const client = createRunClient({ statePath, fetch: fetcher, rescanMs: 60_000 })
    try {
      await waitFor(() => client.history().length === 1)
      fail = true
      await client.refreshHistory()
      expect(client.history().map((entry) => entry.runId)).toEqual(["kept"])
    } finally {
      client.stop()
      await rm(statePath, { recursive: true, force: true })
    }
  })

  it("drops a malformed history payload rather than putting a half-row on screen", async () => {
    const statePath = await mkdtemp(path.join(os.tmpdir(), "wf-tui-history-bad-"))
    await writeDescriptor(statePath, {
      url: "http://127.0.0.1:54321",
      token: "t",
      pid: process.pid,
      directory: "/project",
      worktree: "/project",
      startedAt: Date.now(),
    })
    const fetcher: RunClientFetch = async (input) => {
      const url = String(input)
      if (url.endsWith("/state")) return Response.json({ runs: [snapshot()], revision: 0 })
      if (url.includes("/history")) {
        return Response.json({ history: [{ runId: "half" }, summary("whole", 1_000)] })
      }
      return new Response(new ReadableStream({ start: (controller) => controller.close() }), {
        headers: { "content-type": "text/event-stream" },
      })
    }
    const client = createRunClient({ statePath, fetch: fetcher, rescanMs: 60_000 })
    try {
      await waitFor(() => client.history().length === 1)
      expect(client.history().map((entry) => entry.runId)).toEqual(["whole"])
    } finally {
      client.stop()
      await rm(statePath, { recursive: true, force: true })
    }
  })
})

describe("TUI control client", () => {
  const descriptor = {
    url: "http://127.0.0.1:9999",
    token: "control-token",
    pid: 1,
    directory: "/project",
    worktree: "/project",
    startedAt: Date.now(),
  }

  it("posts the action to the owning endpoint, authenticated, and returns its answer", async () => {
    const calls: { url: string; init?: RequestInit }[] = []
    const client = createControlClient({
      endpointFor: () => descriptor,
      fetch: async (input, init) => {
        calls.push({ url: String(input), init })
        return Response.json({ ok: true })
      },
    })

    expect(await client.send({ action: "stop.run", runId: "run-1" })).toEqual({ ok: true })
    expect(calls[0]?.url).toBe("http://127.0.0.1:9999/control")
    expect(calls[0]?.init?.method).toBe("POST")
    expect((calls[0]?.init?.headers as Record<string, string>).authorization).toBe("Bearer control-token")
    expect(calls[0]?.init?.body).toBe(JSON.stringify({ action: "stop.run", runId: "run-1" }))
  })

  it("passes a failure reason through instead of flattening it to a bare `false`", async () => {
    const client = createControlClient({
      endpointFor: () => descriptor,
      fetch: async () => Response.json({ ok: false, reason: "not-running" }, { status: 409 }),
    })
    expect(await client.send({ action: "stop.run", runId: "run-1" })).toEqual({ ok: false, reason: "not-running" })
  })

  it("answers `unknown-run` when no live endpoint claims the run", async () => {
    const client = createControlClient({ endpointFor: () => undefined, fetch: async () => Response.json({ ok: true }) })
    expect(await client.send({ action: "stop.run", runId: "gone" })).toEqual({ ok: false, reason: "unknown-run" })
  })

  it("does not throw when the endpoint has died mid-keystroke", async () => {
    const client = createControlClient({
      endpointFor: () => descriptor,
      fetch: async () => {
        throw new Error("connection refused")
      },
    })
    expect(await client.send({ action: "stop.run", runId: "run-1" })).toEqual({ ok: false, reason: "unsupported" })
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
