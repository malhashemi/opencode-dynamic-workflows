import { describe, expect, it } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { writeDescriptor } from "../../src/discovery"
import type { RunEvent, RunSnapshot } from "../../src/runs"
import { createRunClient, type RunClientFetch } from "../../src/tui/client"

function snapshot(): RunSnapshot {
  return {
    runId: "run-race",
    workflow: "research",
    provenance: "durable",
    parentSessionID: "parent",
    status: "running",
    phases: [],
    currentPhase: null,
    units: [],
    logs: ["already in snapshot"],
    errors: [],
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
})

async function waitFor(predicate: () => boolean, timeoutMs = 1_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (predicate()) return
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
  throw new Error("condition was not reached")
}
