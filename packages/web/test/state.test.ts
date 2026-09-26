import { describe, expect, test } from "bun:test"

import type { LibraryEntry } from "@malhashemi/opencode-dynamic-workflows/protocol"

import {
  beginResync,
  emptyRunView,
  filterLibrary,
  phasePosition,
  phaseRows,
  receiveEvent,
  receiveSnapshot,
  SeqTracker,
  unitCounts,
  upsertLibraryEntry,
  withFullUnit,
  type RunView,
} from "../src/state"
import { activity, event, header, pending, resolved, run, unit, usage } from "./fixtures"

function ready(overrides = {}, log = [] as ReturnType<typeof activity>[]): RunView {
  return receiveSnapshot(emptyRunView("run-1"), { run: run(overrides), live: true }, log)
}

describe("revision rule", () => {
  test("events at or below the snapshot's revision are ignored; newer ones apply", () => {
    let view = ready({ revision: 5 })
    view = receiveEvent(view, event("unit.updated", 5, unit({ unitId: "old" })))
    expect(view.run!.units).toHaveLength(0)
    view = receiveEvent(view, event("unit.updated", 6, unit({ unitId: "new" })))
    expect(view.run!.units.map((u) => u.unitId)).toEqual(["new"])
    expect(view.run!.revision).toBe(6)
  })

  test("several events with the same revision (one store change) all apply after the snapshot", () => {
    let view = ready({ revision: 5, currentPhase: "facts" })
    const next = run({ revision: 6, currentPhase: "rate" })
    view = receiveEvent(view, event("run.updated", 6, header(next)))
    view = receiveEvent(view, event("activity.appended", 6, activity("rate", 2000, "phase")))
    expect(view.run!.currentPhase).toBe("rate")
    expect(view.activity.map((a) => a.message)).toEqual(["rate"])
  })

  test("events that arrive before the snapshot are buffered, then replayed if newer", () => {
    let view = emptyRunView("run-1")
    view = receiveEvent(view, event("unit.updated", 4, unit({ unitId: "stale" })))
    view = receiveEvent(view, event("unit.updated", 6, unit({ unitId: "fresh" })))
    expect(view.buffered).toHaveLength(2)
    view = receiveSnapshot(view, { run: run({ revision: 5 }), live: true }, [])
    expect(view.sync).toBe("ready")
    expect(view.buffered).toHaveLength(0)
    expect(view.run!.units.map((u) => u.unitId)).toEqual(["fresh"])
  })

  test("events for another Run are ignored", () => {
    const view = ready()
    expect(receiveEvent(view, event("unit.updated", 99, unit(), "run-2"))).toBe(view)
  })
})

describe("resync", () => {
  test("beginResync keeps the Run on screen and buffers until the new snapshot", () => {
    let view = ready({ revision: 5 })
    view = beginResync(view)
    expect(view.sync).toBe("syncing")
    expect(view.run).not.toBeNull()
    view = receiveEvent(view, event("unit.updated", 12, unit({ unitId: "during" })))
    expect(view.run!.units).toHaveLength(0)
    view = receiveSnapshot(view, { run: run({ revision: 11, status: "running" }), live: true }, [])
    expect(view.baseRevision).toBe(11)
    expect(view.run!.units.map((u) => u.unitId)).toEqual(["during"])
  })

  test("activity from the snapshot and from events is de-duplicated", () => {
    let view = emptyRunView("run-1")
    view = receiveEvent(view, event("activity.appended", 6, activity("hello", 1500)))
    view = receiveSnapshot(view, { run: run({ revision: 5 }), live: true }, [activity("hello", 1500)])
    expect(view.activity).toHaveLength(1)
  })
})

describe("SeqTracker", () => {
  test("a new epoch is a reset even when its seq lines up (the service restarted)", () => {
    const tracker = new SeqTracker()
    expect(tracker.observe(5, "a")).toBe("ok")
    expect(tracker.observe(6, "b")).toBe("reset")
    expect(tracker.observe(7, "b")).toBe("ok")
  })

  test("contiguous is ok, a jump is a gap, going backwards is a reset", () => {
    const tracker = new SeqTracker()
    expect(tracker.observe(10)).toBe("ok")
    expect(tracker.observe(11)).toBe("ok")
    expect(tracker.observe(14)).toBe("gap")
    expect(tracker.observe(15)).toBe("ok")
    expect(tracker.observe(1)).toBe("reset")
    expect(tracker.observe(2)).toBe("ok")
  })

  test("a resync.required moves the cursor to the server's latest seq", () => {
    const tracker = new SeqTracker()
    tracker.observe(3)
    tracker.resyncTo(40)
    expect(tracker.observe(41)).toBe("ok")
  })
})

describe("units", () => {
  test("unit.updated upserts by id and keeps ordinal order", () => {
    let view = ready({ revision: 1 })
    view = receiveEvent(view, event("unit.updated", 2, unit({ unitId: "b", ordinal: 2 })))
    view = receiveEvent(view, event("unit.updated", 3, unit({ unitId: "a", ordinal: 1 })))
    view = receiveEvent(view, event("unit.updated", 4, unit({ unitId: "b", ordinal: 2, status: "repairing" })))
    view = receiveEvent(
      view,
      event("unit.updated", 5, unit({ unitId: "b", ordinal: 2, status: "succeeded", usage: usage(10, 0.01) })),
    )
    expect(view.run!.units.map((u) => [u.unitId, u.status])).toEqual([
      ["a", "running"],
      ["b", "succeeded"],
    ])
  })

  test("run.updated keeps the collections it does not carry", () => {
    let view = ready({ revision: 1, units: [unit()], logs: ["x"] })
    view = receiveEvent(
      view,
      event("run.updated", 2, header(run({ revision: 2, status: "running", usage: usage(5, 0.5) }))),
    )
    expect(view.run!.units).toHaveLength(1)
    expect(view.run!.logs).toEqual(["x"])
    expect(view.run!.usage.cost).toBe(0.5)
  })

  test("run.ended marks the view not live", () => {
    let view = ready({ revision: 1 })
    view = receiveEvent(view, event("run.ended", 2, header(run({ revision: 2, status: "succeeded", endedAt: 5000 }))))
    expect(view.live).toBe(false)
    expect(view.run!.status).toBe("succeeded")
  })

  test("withFullUnit fills in an elided output", () => {
    const elided = unit({ status: "succeeded", outputElided: true })
    const view = withFullUnit(ready({ units: [elided] }), { ...elided, output: "long", outputElided: undefined })
    expect(view.run!.units[0]!.output).toBe("long")
  })

  test("withFullUnit does not roll back a Unit that moved on meanwhile", () => {
    const view = ready({ units: [unit({ status: "failed" })] })
    expect(withFullUnit(view, unit({ status: "running", output: "x" }))).toBe(view)
  })

  test("unitCounts counts settled statuses", () => {
    const counts = unitCounts([
      unit({ status: "succeeded" }),
      unit({ status: "replayed" }),
      unit({ status: "repairing" }),
      unit({ status: "failed" }),
    ])
    expect(counts.total).toBe(4)
    expect(counts.settled).toBe(3)
    expect(counts.repairing).toBe(1)
  })
})

describe("interactions", () => {
  test("pending then resolved moves the interaction and clears waiting", () => {
    let view = ready({ revision: 1 })
    const ask = pending()
    view = receiveEvent(view, event("interaction.pending", 2, ask))
    expect(view.run!.interactions).toHaveLength(1)
    expect(view.run!.waiting).toBe(true)
    view = receiveEvent(view, event("interaction.pending", 3, { ...ask, graceEndsAt: 9999 }))
    expect(view.run!.interactions).toHaveLength(1)
    expect(view.run!.interactions[0]!.graceEndsAt).toBe(9999)
    view = receiveEvent(view, event("interaction.resolved", 4, resolved(ask, [["Yes"]])))
    expect(view.run!.interactions).toHaveLength(0)
    expect(view.run!.resolved.map((r) => r.answers)).toEqual([[["Yes"]]])
    expect(view.run!.waiting).toBe(false)
  })

  test("a second pending interaction keeps the Run waiting when the first resolves", () => {
    let view = ready({ revision: 1 })
    view = receiveEvent(view, event("interaction.pending", 2, pending({ interactionId: "a" })))
    view = receiveEvent(view, event("interaction.pending", 3, pending({ interactionId: "b" })))
    view = receiveEvent(view, event("interaction.resolved", 4, resolved(pending({ interactionId: "a" }), [["No"]])))
    expect(view.run!.waiting).toBe(true)
    expect(view.run!.interactions.map((i) => i.interactionId)).toEqual(["b"])
  })
})

describe("derived figures", () => {
  test("phase position shows a denominator only for declared phases", () => {
    expect(phasePosition({ phases: ["a", "b", "c"], phasesDeclared: true, currentPhase: "b" })).toBe("phase 2/3")
    expect(phasePosition({ phases: ["a", "b"], phasesDeclared: false, currentPhase: "b" })).toBe("phase 2")
    expect(phasePosition({ phases: [], phasesDeclared: false, currentPhase: null })).toBeNull()
  })

  test("phaseRows groups Units and marks progress", () => {
    const rows = phaseRows(
      run({
        currentPhase: "rate",
        units: [unit({ phase: "facts" }), unit({ unitId: "u2", phase: "rate" }), unit({ unitId: "u3", phase: null })],
      }),
    )
    expect(rows.phases.map((p) => [p.name, p.state, p.units.length])).toEqual([
      ["facts", "done", 1],
      ["rate", "current", 1],
    ])
    expect(rows.unphased).toHaveLength(1)
  })

  test("library filter and upsert", () => {
    const entry = (runId: string, extra: Partial<LibraryEntry> = {}): LibraryEntry => ({
      runId,
      workflow: { key: "fanout", name: "fanout", description: "facts", provenance: "durable" },
      location: "/p",
      parentSessionID: "s",
      status: "succeeded",
      waiting: false,
      units: 1,
      settledUnits: 1,
      failedUnits: 0,
      phases: [],
      phasesDeclared: false,
      currentPhase: null,
      usage: usage(),
      tokensSpent: 0,
      startedAt: 1,
      endedAt: 2,
      live: false,
      ...extra,
    })
    const list = [entry("a"), entry("b", { status: "running", live: true, waiting: true, startedAt: 5 })]
    expect(filterLibrary(list, { status: "live", search: "", location: "all" }).map((e) => e.runId)).toEqual(["b"])
    expect(filterLibrary(list, { status: "waiting", search: "", location: "all" }).map((e) => e.runId)).toEqual(["b"])
    expect(filterLibrary(list, { status: "succeeded", search: "FAN", location: "all" }).map((e) => e.runId)).toEqual([
      "a",
    ])
    expect(filterLibrary(list, { status: "all", search: "", location: "/other" })).toEqual([])
    const merged = upsertLibraryEntry(list, entry("c", { startedAt: 9 }))
    expect(merged.map((e) => e.runId)).toEqual(["c", "b", "a"])
  })
})
