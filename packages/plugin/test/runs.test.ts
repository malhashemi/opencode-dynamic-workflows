import { describe, expect, it } from "bun:test"
import { emptyUsage, type PendingInteraction, type ProtocolEvent, type Unit } from "../src/protocol"
import { EVENT_WINDOW, createRunStore, elideEvent, newRun, toLibraryEntry } from "../src/runs"

const run = (runId = "r1") =>
  newRun({
    runId,
    workflow: { key: "wf", name: "wf", description: "d", provenance: "durable" },
    location: "/p",
    parentSessionID: "ses_p",
    phases: ["plan", "do"],
  })

const unit = (overrides: Partial<Unit> = {}): Unit => ({
  unitId: "u1",
  runId: "r1",
  ordinal: 1,
  label: null,
  subagent: "general",
  phase: null,
  status: "queued",
  sessionID: null,
  location: null,
  prompt: "p",
  model: { requested: null, resolved: null },
  schema: false,
  resultPath: null,
  attempts: [],
  usage: emptyUsage(),
  startedAt: null,
  endedAt: null,
  ...overrides,
})

const question = (id = "i1"): PendingInteraction => ({
  interactionId: id,
  runId: "r1",
  unitId: null,
  kind: "question",
  origin: "script",
  sessionID: "ses_p",
  phase: null,
  questions: [{ header: "h", prompt: "p", options: [{ label: "A", description: "" }], multiple: false, custom: false }],
  raisedAt: 1,
  graceEndsAt: null,
})

describe("run store", () => {
  it("creates a Run, bumps revision per change, and emits protocol events with increasing seq", () => {
    const store = createRunStore("/p")
    const events: ProtocolEvent[] = []
    store.subscribe((event) => events.push(event))
    store.create(run())
    store.apply({ type: "run.phase", runId: "r1", value: "plan" })
    store.apply({ type: "unit.upsert", runId: "r1", unit: unit({ status: "running" }) })
    store.apply({ type: "run.log", runId: "r1", value: "hi" })
    expect(events.map((e) => e.type)).toEqual([
      "run.started",
      "library.changed",
      "run.updated",
      "activity.appended",
      "unit.updated",
      "activity.appended",
    ])
    expect(events.map((e) => e.seq)).toEqual([1, 2, 3, 4, 5, 6])
    expect(events.every((e) => e.protocol === 1 && e.location === "/p")).toBe(true)
    const current = store.get("r1")!
    expect(current.revision).toBe(4)
    expect(current.currentPhase).toBe("plan")
    expect(current.logs).toEqual(["hi"])
  })

  it("upserts Units by id in ordinal order and sums usage", () => {
    const store = createRunStore("/p")
    store.create(run())
    const usage = { tokens: { input: 1, output: 2, reasoning: 0, cacheRead: 0, cacheWrite: 0 }, cost: 0.1 }
    store.apply({ type: "unit.upsert", runId: "r1", unit: unit({ unitId: "b", ordinal: 2, usage }) })
    store.apply({ type: "unit.upsert", runId: "r1", unit: unit({ unitId: "a", ordinal: 1, usage }) })
    store.apply({ type: "unit.upsert", runId: "r1", unit: unit({ unitId: "a", ordinal: 1, status: "succeeded", usage }) })
    const current = store.get("r1")!
    expect(current.units.map((u) => `${u.unitId}:${u.status}`)).toEqual(["a:succeeded", "b:queued"])
    expect(current.usage.tokens.output).toBe(4)
    expect(current.usage.cost).toBeCloseTo(0.2)
  })

  it("interactions set waiting, resolve idempotently, and keep the record", () => {
    const store = createRunStore("/p")
    store.create(run())
    store.apply({ type: "interaction.pending", runId: "r1", interaction: question() })
    expect(store.get("r1")!.waiting).toBe(true)
    store.apply({ type: "interaction.resolved", runId: "r1", interactionId: "i1", by: "human", answers: [["A"]] })
    store.apply({ type: "interaction.resolved", runId: "r1", interactionId: "i1", by: "automation" })
    const current = store.get("r1")!
    expect(current.waiting).toBe(false)
    expect(current.resolved).toHaveLength(1)
    expect(current.resolved[0]).toMatchObject({ by: "human", answers: [["A"]], outcome: "answered" })
  })

  it("eventsSince returns what a client missed and reports an incomplete window", () => {
    const store = createRunStore("/p")
    store.create(run())
    for (let i = 0; i < 10; i++) store.apply({ type: "run.log", runId: "r1", value: `l${i}` })
    const tail = store.eventsSince(5)
    expect(tail.complete).toBe(true)
    expect(tail.events[0]!.seq).toBe(6)
    expect(tail.latest).toBe(store.latestSeq())
    for (let i = 0; i < EVENT_WINDOW; i++) store.apply({ type: "run.log", runId: "r1", value: "x" })
    expect(store.eventsSince(5).complete).toBe(false)
  })

  it("a client ahead of the store (the service restarted) is told to resync", () => {
    const store = createRunStore("/p")
    store.create(run())
    expect(store.eventsSince(store.latestSeq()).complete).toBe(true)
    expect(store.eventsSince(store.latestSeq() + 100).complete).toBe(false)
  })

  it("a client from another epoch (the service restarted) is told to resync even when seq lines up", () => {
    const store = createRunStore("/p")
    let seen: ProtocolEvent | undefined
    store.subscribe((event) => (seen = event))
    store.create(run())
    expect(seen?.epoch).toBe(store.epoch)
    expect(store.eventsSince(0, store.epoch).complete).toBe(true)
    const other = store.eventsSince(0, "old-epoch")
    expect(other.complete).toBe(false)
    expect(other.epoch).toBe(store.epoch)
  })

  it("elides large outputs for transports but keeps them in the store", () => {
    const store = createRunStore("/p")
    store.create(run())
    let last: ProtocolEvent | undefined
    store.subscribe((event) => (last = event))
    store.apply({ type: "unit.upsert", runId: "r1", unit: unit({ output: "x".repeat(10_000) }) })
    const elided = elideEvent(last!)
    expect((elided.data as Unit).output).toBeUndefined()
    expect((elided.data as Unit).outputElided).toBe(true)
    expect(store.get("r1")!.units[0]!.output).toHaveLength(10_000)
  })

  it("library entries summarise a Run", () => {
    const current = run()
    current.units.push(unit({ status: "succeeded" }), unit({ unitId: "u2", status: "failed" }))
    const entry = toLibraryEntry(current, true)
    expect(entry).toMatchObject({ units: 2, settledUnits: 2, failedUnits: 1, live: true, phasesDeclared: true })
  })
})
