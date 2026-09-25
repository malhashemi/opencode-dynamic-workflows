import { beforeEach, describe, expect, test } from "bun:test"
import type { ActivityEntry, ProtocolEvent } from "../../src/protocol"
import { runHeader } from "../../src/runs"
import {
  applyActivitySnapshot,
  applyEvent,
  applyRunSnapshot,
  emptyState,
  fromSnapshot,
  libraryEntries,
  sessionEntries,
  waitingRuns,
  type SyncState,
} from "../../src/tui/state"
import { LOCATION, entry, event, question, resetSeq, run, unit } from "./fixtures"

function ready(seq = 10, runs = [run()]): SyncState {
  return fromSnapshot({ location: LOCATION, seq, entries: runs.map((r) => entry(r)), runs })
}

function apply(state: SyncState, ...events: ProtocolEvent[]) {
  let current = state
  const effects = []
  for (const e of events) {
    const out = applyEvent(current, e)
    current = out.state
    effects.push(...out.effects)
  }
  return { state: current, effects }
}

beforeEach(() => resetSeq(10))

describe("applyEvent — sequencing", () => {
  test("ignores events before the first snapshot and for other locations", () => {
    expect(applyEvent(emptyState(), event("run.started", run({ runId: "x" }), { runId: "x", revision: 1 })).state.runs).toEqual({})
    const state = ready()
    const out = applyEvent(state, event("run.started", run({ runId: "x" }), { runId: "x", revision: 1, location: "/elsewhere" }))
    expect(out.state).toBe(state)
  })

  test("drops duplicates and asks to catch up on a gap without applying", () => {
    const state = ready(10)
    expect(applyEvent(state, event("run.updated", runHeader(run({ revision: 5 })), { seq: 9, revision: 5 })).state).toBe(state)
    const gap = applyEvent(state, event("run.updated", runHeader(run({ status: "failed", revision: 5 })), { seq: 13, revision: 5 }))
    expect(gap.effects).toEqual([{ kind: "catchup", after: 10 }])
    expect(gap.state.runs["run-1"]!.run!.status).toBe("running")
    expect(gap.state.seq).toBe(10)
  })

  test("resync.required asks for a re-read; a restarted sequence is detected", () => {
    const state = ready(10)
    expect(applyEvent(state, event("resync.required", { reason: "journal" }, { runId: "" })).effects).toEqual([{ kind: "resync", reason: "journal" }])
    const restarted = applyEvent(state, event("run.started", run({ runId: "new" }), { runId: "new", seq: 2, revision: 1 }))
    expect(restarted.effects[0]?.kind).toBe("resync")
  })
})

describe("applyEvent — full-depth Runs", () => {
  test("a Run started after the snapshot appears in the library", () => {
    const out = apply(ready(10, []), event("run.started", run({ runId: "r2", startedAt: 5_000 }), { runId: "r2", revision: 1 }))
    expect(libraryEntries(out.state).map((e) => e.runId)).toEqual(["r2"])
    expect(out.state.runs.r2!.entry.live).toBe(true)
    expect(out.state.seq).toBe(11)
  })

  test("unit.updated upserts by ordinal and recounts usage", () => {
    const usage = { tokens: { input: 10, output: 5, reasoning: 0, cacheRead: 0, cacheWrite: 0 }, cost: 0.01 }
    const out = apply(
      ready(),
      event("unit.updated", unit({ unitId: "u2", ordinal: 1, usage }), { revision: 2 }),
      event("unit.updated", unit({ unitId: "u1", ordinal: 0, usage, status: "succeeded" }), { revision: 3 }),
    )
    const r = out.state.runs["run-1"]!.run!
    expect(r.units.map((u) => u.unitId)).toEqual(["u1", "u2"])
    expect(r.usage.cost).toBeCloseTo(0.02)
    expect(r.revision).toBe(3)
    expect(out.state.runs["run-1"]!.entry.settledUnits).toBe(1)
  })

  test("events at or below the snapshot revision are already in the snapshot", () => {
    const state = ready(10, [run({ revision: 7 })])
    const out = apply(state, event("run.updated", runHeader(run({ status: "failed", revision: 6 })), { revision: 6 }))
    expect(out.state.runs["run-1"]!.run!.status).toBe("running")
    expect(out.state.seq).toBe(11)
  })

  test("interaction.pending marks waiting once; resolved clears it", () => {
    const pending = question()
    const first = apply(ready(), event("interaction.pending", pending, { revision: 2 }))
    expect(first.effects).toEqual([{ kind: "waiting", runId: "run-1", interaction: pending }])
    expect(first.state.runs["run-1"]!.entry.waiting).toBe(true)
    const again = apply(first.state, event("interaction.pending", pending, { revision: 3 }))
    expect(again.effects).toEqual([])
    const resolved = { ...pending, answers: [["Fast"]], by: "human" as const, outcome: "answered" as const, resolvedAt: 3_000 }
    const done = apply(again.state, event("interaction.resolved", resolved, { revision: 4 }))
    expect(done.state.runs["run-1"]!.run!.interactions).toEqual([])
    expect(done.state.runs["run-1"]!.run!.resolved).toHaveLength(1)
    expect(waitingRuns(done.state)).toEqual([])
  })

  test("activity: a log adds to logs, a phase's companion entry does not; loaded feeds grow", () => {
    let state = applyActivitySnapshot(ready(), "run-1", [])
    const phase: ActivityEntry = { kind: "phase", message: "work", time: 1, unitId: null }
    const log: ActivityEntry = { kind: "log", message: "hello", time: 2, unitId: null }
    state = apply(
      state,
      event("run.updated", runHeader(run({ currentPhase: "work", revision: 2 })), { revision: 2 }),
      event("activity.appended", phase, { revision: 2 }),
      event("activity.appended", log, { revision: 3 }),
      event("activity.appended", { kind: "capability", message: "fs.read notes.txt", time: 3, unitId: null }, { revision: 4 }),
    ).state
    const slot = state.runs["run-1"]!
    expect(slot.run!.logs).toEqual(["hello"])
    expect(slot.run!.revision).toBe(4)
    expect(slot.run!.currentPhase).toBe("work")
    expect(slot.activity!.map((a) => a.message)).toEqual(["work", "hello", "fs.read notes.txt"])
  })

  test("run.ended reports the end and the Run stops being live", () => {
    const out = apply(ready(), event("run.ended", runHeader(run({ status: "succeeded", endedAt: 9_000, revision: 2 })), { revision: 2 }))
    expect(out.effects).toEqual([{ kind: "ended", runId: "run-1" }])
    expect(out.state.runs["run-1"]!.entry.live).toBe(false)
  })
})

describe("applyEvent — entry-depth Runs", () => {
  const history = () => fromSnapshot({ location: LOCATION, seq: 10, entries: [entry(run({ status: "succeeded" }), false)], runs: [] })

  test("headers merge into the entry; Unit and interaction events ask for the full Run", () => {
    const header = apply(history(), event("run.updated", { ...runHeader(run({ status: "succeeded", revision: 9 })), cleanup: "done" }, { revision: 9 }))
    expect(header.effects).toEqual([])
    expect(header.state.runs["run-1"]!.entry.status).toBe("succeeded")
    resetSeq(10)
    const waiting = apply(history(), event("interaction.pending", question(), { revision: 9 }))
    expect(waiting.effects).toEqual([{ kind: "hydrate", runId: "run-1" }])
    expect(waiting.state.runs["run-1"]!.entry.waiting).toBe(true)
  })

  test("an event for an unknown Run asks to hydrate it", () => {
    expect(apply(ready(10, []), event("unit.updated", unit({ runId: "zzz" }), { runId: "zzz", revision: 4 })).effects).toEqual([{ kind: "hydrate", runId: "zzz" }])
  })

  test("library.changed never overrides a full Run", () => {
    const state = ready()
    const out = apply(state, event("library.changed", { ...entry(run()), status: "failed" }, { runId: "" }))
    expect(out.state.runs["run-1"]!.entry.status).toBe("running")
  })
})

describe("snapshots and selectors", () => {
  test("applyRunSnapshot never goes backwards and keeps the activity feed", () => {
    let state = applyActivitySnapshot(ready(10, [run({ revision: 5 })]), "run-1", [{ kind: "log", message: "a", time: 1, unitId: null }])
    state = applyRunSnapshot(state, run({ revision: 4, status: "failed" }))
    expect(state.runs["run-1"]!.run!.status).toBe("running")
    state = applyRunSnapshot(state, run({ revision: 8, status: "failed" }))
    expect(state.runs["run-1"]!.run!.status).toBe("failed")
    expect(state.runs["run-1"]!.activity).toHaveLength(1)
  })

  test("fromSnapshot keeps Runs a view holds that the bounded library omitted", () => {
    const previous = ready(10, [run({ runId: "old" })])
    const next = fromSnapshot({ location: LOCATION, seq: 20, entries: [], runs: [], previous })
    expect(Object.keys(next.runs)).toEqual(["old"])
  })

  test("sessionEntries filters by the parent session, newest first", () => {
    const state = ready(10, [run({ runId: "a", startedAt: 1 }), run({ runId: "b", startedAt: 2 }), run({ runId: "c", parentSessionID: "other" })])
    expect(sessionEntries(state, "ses_parent").map((e) => e.runId)).toEqual(["b", "a"])
  })
})
