/**
 * The dashboard's revision handshake, driven frame by frame.
 *
 * `reduceDashboard` replicates the blessed sync scheme the TUI client implements — open `/events` first,
 * buffer, fetch `/state`, drop frames the snapshot already contains, apply the rest — and the reducer is where
 * that can silently go wrong: a dropped frame is a stale row, a double-applied one is a duplicated log line.
 * So the reducer is tested as a pure function, and `connect()` gets one full end-to-end pass over a fake
 * transport to prove the subscribe-then-snapshot race actually stays closed.
 */
import { describe, expect, it } from "bun:test"
import type { PendingInteraction, RunEvent, RunOrigin, RunSnapshot, RunSummary, UnitSnapshot } from "../src/engine"
import {
  connect,
  initialDashboardState,
  reduceDashboard,
  type DashboardAction,
  type DashboardState,
} from "../src/state"

function run(overrides: Partial<RunSnapshot> = {}): RunSnapshot {
  return {
    runId: "run-1",
    workflow: "greet",
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
    startedAt: 1_000,
    endedAt: null,
    ...overrides,
  }
}

function unit(overrides: Partial<UnitSnapshot> = {}): UnitSnapshot {
  return {
    unitId: "unit-1",
    ordinal: 1,
    label: "one",
    subagent: "general",
    phase: null,
    status: "running",
    sessionID: "child-1",
    prompt: "do the thing",
    startedAt: 1_100,
    endedAt: null,
    ...overrides,
  }
}

function interaction(overrides: Partial<PendingInteraction> = {}): PendingInteraction {
  return {
    requestID: "req-1",
    kind: "question",
    origin: "agent",
    sessionID: "child-1",
    unitId: "unit-1",
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
    raisedAt: 1_200,
    graceEndsAt: null,
    ...overrides,
  }
}

function summary(runId: string, startedAt: number): RunSummary {
  return {
    runId,
    workflow: "greet",
    provenance: "inline",
    parentSessionID: "parent",
    status: "done",
    units: 1,
    settledUnits: 1,
    tokensSpent: 5,
    phases: ["plan"],
    phasesDeclared: true,
    currentPhase: "plan",
    startedAt,
    endedAt: startedAt + 500,
  }
}

function reduceAll(state: DashboardState, actions: DashboardAction[]): DashboardState {
  return actions.reduce(reduceDashboard, state)
}

describe("reduceDashboard", () => {
  it("bootstraps from a snapshot: runs land sorted, the revision cursor moves", () => {
    const state = reduceDashboard(initialDashboardState(), {
      type: "snapshot",
      runs: [run({ runId: "b", status: "done", startedAt: 3_000 }), run({ runId: "a", startedAt: 1_000 })],
      revision: 7,
    })
    // Running first, then newest first — the order every other surface lists runs in.
    expect(state.runs.map((candidate) => candidate.runId)).toEqual(["a", "b"])
    expect(state.revision).toBe(7)
  })

  it("applies a buffered event only when it is newer than the snapshot", () => {
    const base = reduceDashboard(initialDashboardState(), { type: "snapshot", runs: [run()], revision: 5 })

    // A frame the snapshot already contained: dropped, and the state object is IDENTICAL (no phantom rerender).
    const dropped = reduceDashboard(base, {
      type: "event",
      revision: 5,
      event: { type: "run.log", runId: "run-1", value: "stale" },
    })
    expect(dropped).toBe(base)

    const applied = reduceDashboard(base, {
      type: "event",
      revision: 6,
      event: { type: "run.log", runId: "run-1", value: "fresh" },
    })
    expect(applied.runs[0]?.logs).toEqual(["fresh"])
    expect(applied.revision).toBe(6)
  })

  it("never applies the same revision twice across a burst", () => {
    const base = reduceDashboard(initialDashboardState(), { type: "snapshot", runs: [run()], revision: 0 })
    const state = reduceAll(base, [
      { type: "event", revision: 1, event: { type: "run.log", runId: "run-1", value: "one" } },
      { type: "event", revision: 1, event: { type: "run.log", runId: "run-1", value: "one" } },
      { type: "event", revision: 2, event: { type: "run.log", runId: "run-1", value: "two" } },
    ])
    expect(state.runs[0]?.logs).toEqual(["one", "two"])
  })

  it("resyncs on reconnect: a later snapshot replaces the runs and re-bases the cursor", () => {
    const before = reduceAll(initialDashboardState(), [
      { type: "snapshot", runs: [run()], revision: 3 },
      { type: "event", revision: 4, event: { type: "run.log", runId: "run-1", value: "old" } },
    ])
    const after = reduceDashboard(before, {
      type: "snapshot",
      runs: [run({ logs: ["old", "new"] })],
      revision: 9,
    })
    expect(after.runs[0]?.logs).toEqual(["old", "new"])
    expect(after.revision).toBe(9)
    // History survives a resync — it came from a different read and the reconnect did not invalidate it.
    const withHistory = reduceDashboard(after, { type: "history", history: [summary("h", 100)] })
    expect(reduceDashboard(withHistory, { type: "snapshot", runs: [], revision: 10 }).history).toHaveLength(1)
  })

  it("ignores a side read the stream has overtaken, but lets a reconnect rebase the cursor down", () => {
    const live = reduceAll(initialDashboardState(), [
      { type: "snapshot", runs: [run()], revision: 3 },
      { type: "event", revision: 4, event: { type: "run.log", runId: "run-1", value: "after-the-server-snapshot" } },
    ])
    // The everywhere poll's answer, taken at revision 3, lands now. Applying it would erase the log line, and
    // no frame will ever replay it — so it is stale, and state is untouched by identity.
    expect(reduceDashboard(live, { type: "snapshot", runs: [run()], revision: 3 })).toBe(live)
    // A restarted host's counter starts over. Its snapshot carries `rebase` and IS the new truth.
    const restarted = reduceDashboard(live, {
      type: "snapshot",
      runs: [run({ logs: ["fresh-boot"] })],
      revision: 1,
      rebase: true,
    })
    expect(restarted.runs[0]?.logs).toEqual(["fresh-boot"])
    expect(restarted.revision).toBe(1)
  })

  it("folds unit and phase events into the addressed run and leaves the others untouched by identity", () => {
    const base = reduceDashboard(initialDashboardState(), {
      type: "snapshot",
      runs: [run(), run({ runId: "run-2", startedAt: 500 })],
      revision: 0,
    })
    const state = reduceAll(base, [
      { type: "event", revision: 1, event: { type: "run.phase", runId: "run-1", value: "plan" } },
      { type: "event", revision: 2, event: { type: "unit.queued", runId: "run-1", unit: unit({ status: "queued" }) } },
      { type: "event", revision: 3, event: { type: "unit.settled", runId: "run-1", unit: unit({ status: "ok", endedAt: 2_000 }) } },
    ])
    const touched = state.runs.find((candidate) => candidate.runId === "run-1")
    expect(touched?.currentPhase).toBe("plan")
    expect(touched?.phases).toEqual(["plan"])
    expect(touched?.units).toHaveLength(1)
    expect(touched?.units[0]?.status).toBe("ok")
    // The untouched run keeps its object identity, so `===`-based rendering skips it.
    expect(state.runs.find((candidate) => candidate.runId === "run-2")).toBe(
      base.runs.find((candidate) => candidate.runId === "run-2") as RunSnapshot,
    )
  })

  it("completes a run: `run.ended` replaces the snapshot and the run re-sorts out of the running block", () => {
    const base = reduceDashboard(initialDashboardState(), {
      type: "snapshot",
      runs: [run({ runId: "old", startedAt: 100 }), run()],
      revision: 0,
    })
    const ended = reduceDashboard(base, {
      type: "event",
      revision: 1,
      event: { type: "run.ended", run: run({ status: "done", endedAt: 5_000 }) },
    })
    expect(ended.runs.map((candidate) => [candidate.runId, candidate.status])).toEqual([
      ["old", "running"],
      ["run-1", "done"],
    ])
  })

  it("keeps a resolved interaction as a record instead of filtering it out", () => {
    const base = reduceAll(initialDashboardState(), [
      { type: "snapshot", runs: [run()], revision: 0 },
      { type: "event", revision: 1, event: { type: "interaction.pending", runId: "run-1", interaction: interaction() } },
    ])
    expect(base.runs[0]?.interactions).toHaveLength(1)
    const resolved = reduceDashboard(base, {
      type: "event",
      revision: 2,
      event: { type: "interaction.resolved", runId: "run-1", requestID: "req-1", by: "human", answers: [["EU"]] },
    })
    expect(resolved.runs[0]?.interactions).toEqual([])
    expect(resolved.runs[0]?.resolved).toMatchObject([{ requestID: "req-1", by: "human", answers: [["EU"]] }])
  })

  it("stamps a pending interaction with the run's current phase when the publisher did not know it", () => {
    const state = reduceAll(initialDashboardState(), [
      { type: "snapshot", runs: [run({ currentPhase: "gather", phases: ["gather"] })], revision: 0 },
      { type: "event", revision: 1, event: { type: "interaction.pending", runId: "run-1", interaction: interaction({ phase: null }) } },
    ])
    expect(state.runs[0]?.interactions[0]?.phase).toBe("gather")
  })

  it("merges history sorted newest first, and tracks the connection flag without churning state", () => {
    const state = reduceDashboard(initialDashboardState(), {
      type: "history",
      history: [summary("older", 1_000), summary("newer", 2_000)],
    })
    expect(state.history.map((row) => row.runId)).toEqual(["newer", "older"])

    const connected = reduceDashboard(state, { type: "connection", connected: true })
    expect(connected.connected).toBe(true)
    expect(reduceDashboard(connected, { type: "connection", connected: true })).toBe(connected)
  })
})

describe("connect", () => {
  it("opens events first, buffers them across the snapshot fetch, and drops what the snapshot contained", async () => {
    // The transport, scripted: /events answers immediately with two frames already in its body — one the
    // snapshot will already contain (id 3) and one it will not (id 4) — while /state answers revision 3.
    // If connect read the stream before dispatching the snapshot, or failed to drop id 3, the log would
    // duplicate or misorder.
    const encoder = new TextEncoder()
    const frames =
      `id: 3\ndata: ${JSON.stringify({ type: "run.log", runId: "run-1", value: "already-in-snapshot" })}\n\n` +
      `id: 4\ndata: ${JSON.stringify({ type: "run.log", runId: "run-1", value: "buffered" })}\n\n`
    let streamController: ReadableStreamDefaultController<Uint8Array> | null = null
    const fakeFetch = (async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url.endsWith("/events")) {
        const body = new ReadableStream<Uint8Array>({
          start(controller) {
            streamController = controller
            controller.enqueue(encoder.encode(frames))
          },
        })
        return new Response(body, { status: 200 })
      }
      if (url.endsWith("/state")) {
        return Response.json({ runs: [run({ logs: ["already-in-snapshot"] })], revision: 3 })
      }
      if (url.endsWith("/history")) return Response.json({ history: [summary("h", 10)] })
      return new Response("not found", { status: 404 })
    }) as typeof fetch

    const live = connect({ baseUrl: "http://dash.test", token: "t", fetch: fakeFetch })
    try {
      await waitFor(() => live.state().runs[0]?.logs.length === 2)
      expect(live.state().runs[0]?.logs).toEqual(["already-in-snapshot", "buffered"])
      expect(live.state().connected).toBe(true)
      expect(live.state().revision).toBe(4)
      await waitFor(() => live.state().history.length === 1)

      // A frame arriving later still lands through the same cursor.
      streamController!.enqueue(
        encoder.encode(`id: 5\ndata: ${JSON.stringify({ type: "run.log", runId: "run-1", value: "live" })}\n\n`),
      )
      await waitFor(() => live.state().runs[0]?.logs.length === 3)
    } finally {
      live.stop()
    }
    expect(live.state().connected).toBe(false)
  })

  it("survives a server restart: reconnect re-fetches /state, re-bases the cursor, and recovers", async () => {
    // The old tab's exact life: the host dies mid-stream, comes back at the SAME address (the stable-port
    // amendment) with its revision counter reset. Recovery means the fresh snapshot replaces the stale runs,
    // the cursor re-bases DOWN, and post-restart frames apply. A resync that kept the pre-restart cursor
    // would silently drop every event the restarted host emits.
    const encoder = new TextEncoder()
    let generation = 0
    let streamController: ReadableStreamDefaultController<Uint8Array> | null = null
    const fakeFetch = (async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url.endsWith("/events")) {
        generation += 1
        if (generation === 1) {
          // First life: one frame, then the process dies (the stream errors out).
          const body = new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(
                encoder.encode(`id: 8\ndata: ${JSON.stringify({ type: "run.log", runId: "run-1", value: "before" })}\n\n`),
              )
              controller.error(new Error("host died"))
            },
          })
          return new Response(body, { status: 200 })
        }
        const body = new ReadableStream<Uint8Array>({
          start(controller) {
            streamController = controller
          },
        })
        return new Response(body, { status: 200 })
      }
      if (url.endsWith("/state")) {
        return generation <= 1
          ? Response.json({ runs: [run()], revision: 7 })
          : Response.json({ runs: [run({ logs: ["fresh-boot"] })], revision: 1 })
      }
      if (url.endsWith("/history")) return Response.json({ history: [] })
      return new Response("not found", { status: 404 })
    }) as typeof fetch

    const live = connect({ baseUrl: "http://dash.test", fetch: fakeFetch })
    try {
      await waitFor(() => live.state().runs[0]?.logs.length === 1) // snapshot + the pre-crash frame
      await waitFor(() => generation >= 2 && live.state().connected)
      // The restarted host's snapshot replaced the stale state, revision re-based to ITS counter…
      await waitFor(() => live.state().runs[0]?.logs[0] === "fresh-boot")
      expect(live.state().revision).toBe(1)
      // …and its next frame (a small id the old cursor would have swallowed) applies.
      await waitFor(() => streamController !== null)
      streamController!.enqueue(
        encoder.encode(`id: 2\ndata: ${JSON.stringify({ type: "run.log", runId: "run-1", value: "after" })}\n\n`),
      )
      await waitFor(() => live.state().runs[0]?.logs.length === 2)
      expect(live.state().runs[0]?.logs).toEqual(["fresh-boot", "after"])
    } finally {
      live.stop()
    }
  })

  it("widens to everywhere through the scope flag, tags stay intact, and narrows back clean", async () => {
    const encoder = new TextEncoder()
    const origin: RunOrigin = { worktree: "/elsewhere/project", url: "http://127.0.0.1:9999" }
    const requested: string[] = []
    const fakeFetch = (async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url.endsWith("/events")) {
        // A quiet, open stream: scope changes ride out-of-band snapshot reads, never a reconnect.
        const body = new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(encoder.encode(": connected\n\n"))
          },
        })
        return new Response(body, { status: 200 })
      }
      if (url.includes("/state")) {
        requested.push(url)
        return url.includes("scope=everywhere")
          ? Response.json({ runs: [run(), { ...run({ runId: "run-far", startedAt: 900 }), origin }], revision: 3 })
          : Response.json({ runs: [run()], revision: 3 })
      }
      if (url.includes("/history")) {
        return url.includes("scope=everywhere")
          ? Response.json({ history: [{ ...summary("hist-far", 100), origin }] })
          : Response.json({ history: [] })
      }
      return new Response("not found", { status: 404 })
    }) as typeof fetch

    const live = connect({ baseUrl: "http://dash.test", fetch: fakeFetch })
    try {
      await waitFor(() => live.state().runs.length === 1)

      live.setScope("everywhere")
      await waitFor(() => live.state().runs.length === 2)
      const far = live.state().runs.find((candidate) => candidate.runId === "run-far") as RunSnapshot & {
        origin?: RunOrigin
      }
      // The origin tag survives the reducer's clone — it is how the rail says where a foreign run lives.
      expect(far.origin).toEqual(origin)
      await waitFor(() => live.state().history.length === 1)
      expect(requested.some((url) => url.includes("/state?scope=everywhere"))).toBe(true)

      live.setScope("project")
      await waitFor(() => live.state().runs.length === 1)
      await waitFor(() => live.state().history.length === 0)
    } finally {
      live.stop()
    }
  })

  it("drops a scope read that a later switch has superseded", async () => {
    // A slow `everywhere` read, a quick switch back to `project`: the project answer lands first, then the
    // obsolete everywhere answer arrives. Without a generation check it would paint peer runs under a header
    // that says `this project` — and leave them there, since project scope has no poll to correct it.
    const encoder = new TextEncoder()
    const origin: RunOrigin = { worktree: "/elsewhere/project", url: "http://127.0.0.1:9999" }
    let releaseEverywhere: (() => void) | null = null
    const fakeFetch = (async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url.endsWith("/events")) {
        const body = new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(encoder.encode(": connected\n\n"))
          },
        })
        return new Response(body, { status: 200 })
      }
      if (url.includes("/state")) {
        if (url.includes("scope=everywhere")) {
          await new Promise<void>((resolve) => {
            releaseEverywhere = resolve
          })
          return Response.json({ runs: [run(), { ...run({ runId: "run-far", startedAt: 900 }), origin }], revision: 3 })
        }
        return Response.json({ runs: [run()], revision: 3 })
      }
      if (url.includes("/history")) {
        if (url.includes("scope=everywhere")) {
          await new Promise((resolve) => setTimeout(resolve, 40))
          return Response.json({ history: [{ ...summary("hist-far", 100), origin }] })
        }
        return Response.json({ history: [] })
      }
      return new Response("not found", { status: 404 })
    }) as typeof fetch

    const live = connect({ baseUrl: "http://dash.test", fetch: fakeFetch })
    try {
      await waitFor(() => live.state().runs.length === 1 && live.state().connected)
      live.setScope("everywhere")
      await waitFor(() => releaseEverywhere !== null)
      live.setScope("project")
      await new Promise((resolve) => setTimeout(resolve, 20))
      releaseEverywhere!()
      await new Promise((resolve) => setTimeout(resolve, 100))
      expect(live.state().runs.map((candidate) => candidate.runId)).toEqual(["run-1"])
      expect(live.state().history).toHaveLength(0)
    } finally {
      live.stop()
    }
  })
})

async function waitFor(predicate: () => boolean, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (predicate()) return
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  throw new Error("condition was not reached")
}
