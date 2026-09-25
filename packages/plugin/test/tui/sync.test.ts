import { describe, expect, test } from "bun:test"
import type { ProtocolEvent, Run } from "../../src/protocol"
import { runHeader } from "../../src/runs"
import type { WorkflowApi } from "../../src/tui/api"
import { WorkflowSync } from "../../src/tui/sync"
import { LOCATION, entry, event, question, run } from "./fixtures"

/** A fake service: a run table, an event log with `seq`, and counters for what the TUI asked. */
function fakeService(runs: Run[] = []) {
  const table = new Map(runs.map((r) => [r.runId, r]))
  const log: ProtocolEvent[] = []
  let latest = 0
  let windowStart = 0
  const calls: string[] = []
  const gate = { resolve: null as null | (() => void), blocked: false }
  const api = {
    info: async () => (calls.push("info"), { protocol: 1, plugin: { name: "p", version: "0" }, opencode: "2", location: LOCATION, capabilities: [], limits: { maxUnits: 1, maxItemsPerCall: 1, maxUnitSteps: 1 }, gateway: { url: null } }),
    eventsSince: async ({ after = 0 }: { after?: number }) => {
      calls.push(`eventsSince:${after === Number.MAX_SAFE_INTEGER ? "max" : after}`)
      return { events: log.filter((e) => e.seq > after), complete: after >= windowStart, latest }
    },
    listRuns: async () => {
      calls.push("listRuns")
      if (gate.blocked) await new Promise<void>((resolve) => (gate.resolve = resolve))
      return { runs: [...table.values()].map((r) => entry(r, r.status === "running")) }
    },
    getRun: async ({ runId }: { runId: string }) => {
      calls.push(`getRun:${runId}`)
      const r = table.get(runId)
      if (!r) throw { type: "workflow", message: "nope", data: { code: "not_found", message: `No Run "${runId}"`, retryable: false } }
      return { run: r, live: r.status === "running" }
    },
    getActivity: async () => ({ entries: [] }),
  } as unknown as WorkflowApi
  return {
    api,
    calls,
    gate,
    table,
    publish(e: ProtocolEvent) {
      latest = Math.max(latest, e.seq)
      log.push(e)
    },
    setLatest(value: number, start = 0) {
      latest = value
      windowStart = start
    },
  }
}

const noEvents = () => ({ async *[Symbol.asyncIterator]() {} })

describe("WorkflowSync", () => {
  test("resync reads the location, the current seq, the library, and live Runs in full", async () => {
    const service = fakeService([run({ runId: "live" }), run({ runId: "old", status: "succeeded" })])
    service.setLatest(7)
    const states: number[] = []
    const sync = new WorkflowSync({ api: service.api, events: noEvents, onState: (s) => states.push(s.seq) })
    await sync.resync("start")
    expect(sync.current.ready).toBe(true)
    expect(sync.current.seq).toBe(7)
    expect(sync.current.location).toBe(LOCATION)
    expect(sync.current.runs.live!.run).not.toBeNull()
    expect(sync.current.runs.old!.run).toBeNull()
    expect(service.calls).toEqual(["info", "eventsSince:max", "listRuns", "getRun:live"])
  })

  test("events that arrive during a resync are queued and applied after it", async () => {
    const service = fakeService([run()])
    service.setLatest(3)
    service.gate.blocked = true
    const sync = new WorkflowSync({ api: service.api, events: noEvents, onState: () => {} })
    const loading = sync.resync("start")
    await Bun.sleep(1)
    sync.receive(event("run.updated", runHeader(run({ currentPhase: "work", revision: 2 })), { seq: 4, revision: 2 }))
    service.gate.resolve!()
    await loading
    expect(sync.current.seq).toBe(4)
    expect(sync.current.runs["run-1"]!.run!.currentPhase).toBe("work")
  })

  test("a gap is filled from eventsSince; an expired window falls back to a resync", async () => {
    const service = fakeService([run()])
    service.setLatest(3)
    const sync = new WorkflowSync({ api: service.api, events: noEvents, onState: () => {} })
    await sync.resync("start")
    const missed = event("run.updated", runHeader(run({ currentPhase: "work", revision: 2 })), { seq: 4, revision: 2 })
    const next = event("run.updated", runHeader(run({ currentPhase: "work", status: "running", revision: 3 })), { seq: 5, revision: 3 })
    service.publish(missed)
    service.publish(next)
    sync.receive(next)
    await Bun.sleep(5)
    expect(sync.current.seq).toBe(5)
    expect(sync.current.runs["run-1"]!.run!.revision).toBe(3)

    service.calls.length = 0
    service.setLatest(50, 40)
    await sync.poll()
    expect(service.calls).toContain("listRuns")
    expect(sync.current.seq).toBe(50)
  })

  test("poll notices a restarted service (its seq went backwards) and re-reads", async () => {
    const service = fakeService([run()])
    service.setLatest(30)
    const sync = new WorkflowSync({ api: service.api, events: noEvents, onState: () => {} })
    await sync.resync("start")
    service.setLatest(2)
    service.calls.length = 0
    await sync.poll()
    expect(service.calls).toContain("info")
    expect(sync.current.seq).toBe(2)
  })

  test("a new pending interaction is reported once; an unknown Run is hydrated", async () => {
    const service = fakeService([run()])
    service.setLatest(1)
    const notices: string[] = []
    const sync = new WorkflowSync({ api: service.api, events: noEvents, onState: () => {}, onNotice: (n) => notices.push(`${n.kind}:${n.runId}`) })
    await sync.resync("start")
    sync.receive(event("interaction.pending", question(), { seq: 2, revision: 2 }))
    expect(notices).toEqual(["waiting:run-1"])

    service.table.set("late", run({ runId: "late" }))
    sync.receive(event("unit.updated", {}, { seq: 3, runId: "late", revision: 4 }))
    await Bun.sleep(5)
    expect(sync.current.runs.late?.run?.runId).toBe("late")
  })

  test("the stream is consumed and re-subscribed after it ends", async () => {
    const service = fakeService([run()])
    service.setLatest(1)
    let subscriptions = 0
    const events = () => {
      subscriptions += 1
      const current = subscriptions
      return {
        async *[Symbol.asyncIterator]() {
          if (current === 1) yield { data: event("run.updated", runHeader(run({ currentPhase: "work", revision: 2 })), { seq: 2, revision: 2 }) }
        },
      }
    }
    const sync = new WorkflowSync({ api: service.api, events, onState: () => {} })
    await sync.start()
    await Bun.sleep(700)
    sync.stop()
    expect(subscriptions).toBeGreaterThanOrEqual(2)
  })
})
