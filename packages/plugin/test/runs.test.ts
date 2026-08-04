import { describe, expect, it } from "bun:test"
import { createRunStore, type RunEvent, type RunSnapshot, type UnitSnapshot } from "../src/runs"

function run(): RunSnapshot {
  return {
    runId: "run-1",
    workflow: "research",
    provenance: "inline",
    parentSessionID: "parent",
    status: "running",
    phases: [],
    phasesDeclared: false,
    currentPhase: null,
    units: [],
    logs: [],
    errors: [],
    tokensSpent: 0,
    startedAt: 100,
    endedAt: null,
  }
}

function unit(status: UnitSnapshot["status"]): UnitSnapshot {
  return {
    unitId: "unit-1",
    ordinal: 1,
    label: "scan",
    subagent: "explore",
    phase: "Research",
    status,
    sessionID: status === "ok" ? "child-1" : null,
    prompt: "scan the repository",
    startedAt: status === "queued" ? null : 110,
    endedAt: status === "ok" ? 120 : null,
  }
}

describe("createRunStore", () => {
  it("applies run, phase, log, and stable unit lifecycle transitions", () => {
    const store = createRunStore()
    store.create(run())
    store.apply({ type: "run.phase", runId: "run-1", value: "Research" })
    store.apply({ type: "run.log", runId: "run-1", value: "looking" })
    store.apply({ type: "unit.queued", runId: "run-1", unit: unit("queued") })
    store.apply({ type: "unit.started", runId: "run-1", unit: unit("running") })
    store.apply({ type: "unit.settled", runId: "run-1", unit: unit("ok") })

    const current = store.get("run-1")
    expect(current?.currentPhase).toBe("Research")
    expect(current?.phases).toEqual(["Research"])
    expect(current?.logs).toEqual(["looking"])
    expect(current?.units).toHaveLength(1)
    expect(current?.units[0]).toMatchObject({ unitId: "unit-1", status: "ok", sessionID: "child-1" })
  })

  it("preserves declared phase order without duplicating observed phases", () => {
    const store = createRunStore()
    store.create({ ...run(), phases: ["Research", "Synthesize"] })
    store.apply({ type: "run.phase", runId: "run-1", value: "Research" })
    store.apply({ type: "run.phase", runId: "run-1", value: "Synthesize" })

    expect(store.get("run-1")?.phases).toEqual(["Research", "Synthesize"])
    expect(store.get("run-1")?.currentPhase).toBe("Synthesize")
  })

  it("fans events out in subscription order and unsubscribe is idempotent", () => {
    const store = createRunStore()
    const seen: string[] = []
    const stopFirst = store.subscribe((event) => seen.push(`first:${event.type}`))
    store.subscribe((event) => seen.push(`second:${event.type}`))
    expect(store.subscribers()).toBe(2)

    store.create(run())
    stopFirst()
    stopFirst()
    store.apply({ type: "run.log", runId: "run-1", value: "next" })

    expect(seen).toEqual(["first:run.started", "second:run.started", "second:run.log"])
    expect(store.subscribers()).toBe(1)
  })

  it("never exposes mutable internal snapshots or shared event objects", () => {
    const store = createRunStore()
    const second: RunEvent[] = []
    store.subscribe((event) => {
      if (event.type === "run.started") event.run.logs.push("subscriber mutation")
      if (event.type === "run.log") event.value = "subscriber mutation"
    })
    store.subscribe((event) => second.push(event))
    const input = run()
    store.create(input)
    input.logs.push("input mutation")
    store.apply({ type: "run.log", runId: "run-1", value: "stored" })

    const firstRead = store.get("run-1")!
    firstRead.logs.push("read mutation")
    firstRead.units.push(unit("queued"))
    expect(store.get("run-1")?.logs).toEqual(["stored"])
    expect(store.get("run-1")?.units).toEqual([])
    expect(second[0]).toMatchObject({ type: "run.started", run: { logs: [] } })
    expect(second[1]).toEqual({ type: "run.log", runId: "run-1", value: "stored" })
  })

  it("rejects duplicate and unknown run transitions", () => {
    const store = createRunStore()
    store.create(run())
    expect(() => store.create(run())).toThrow(/already exists/)
    expect(() => store.apply({ type: "run.started", run: run() })).toThrow(/already exists/)
    expect(() => store.apply({ type: "run.log", runId: "missing", value: "x" })).toThrow(/unknown run/)
    expect(() => store.apply({ type: "run.ended", run: { ...run(), runId: "missing", status: "done" } })).toThrow(/unknown run/)
  })
})
