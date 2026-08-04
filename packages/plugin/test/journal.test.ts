/**
 * The journal, against a real filesystem.
 *
 * Two properties matter more than the round-trip, and both are about failure: a journal write must never be
 * able to fail a run, and a torn record must still be a readable one. A host killed mid-run is not an exotic
 * case — it is `ctrl-c`, and it is exactly the run someone comes back looking for.
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test"
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { createJournal, journalRoot, subscribeJournal, toRunSummary, type Journal } from "../src/journal"
import { createRunStore, type RunSnapshot, type UnitSnapshot } from "../src/runs"

const SOURCE = `import { defineWorkflow } from "@opencode-ai/workflow"
export default defineWorkflow({ meta: { name: "greet", description: "x" }, async run() { return "ok" } })
`

function unit(overrides: Partial<UnitSnapshot> = {}): UnitSnapshot {
  return {
    unitId: "unit-1",
    ordinal: 1,
    label: null,
    subagent: "general",
    phase: "gather",
    status: "ok",
    sessionID: "child-1",
    prompt: "do the thing",
    startedAt: 1_000,
    endedAt: 2_000,
    ...overrides,
  }
}

function run(overrides: Partial<RunSnapshot> = {}): RunSnapshot {
  return {
    runId: "run-1",
    workflow: "greet",
    provenance: "inline",
    parentSessionID: "parent",
    status: "running",
    phases: ["plan", "gather"],
    phasesDeclared: true,
    currentPhase: "gather",
    units: [],
    logs: [],
    errors: [],
    interactions: [],
    tokensSpent: 0,
    startedAt: 1_000,
    endedAt: null,
    ...overrides,
  }
}

describe("journalRoot", () => {
  it("puts a project's runs beside the workflows that produced them", () => {
    expect(journalRoot("/tmp/project")).toBe("/tmp/project/.opencode/workflows/runs")
  })
})

describe("journal round-trip", () => {
  let root = ""
  let journal: Journal
  const errors: string[] = []

  beforeEach(async () => {
    root = await mkdtemp(path.join(os.tmpdir(), "wf-journal-"))
    errors.length = 0
    journal = createJournal(path.join(root, "runs"), { onError: (_error, context) => errors.push(context) })
  })
  afterEach(async () => {
    await rm(root, { recursive: true, force: true })
  })

  it("writes the four files and reads the whole record back", async () => {
    const started = run()
    await journal.begin(started, { source: SOURCE, args: { name: "Sam" } })
    await journal.append({ type: "unit.queued", runId: "run-1", unit: unit({ status: "queued" }) })
    await journal.append({ type: "unit.started", runId: "run-1", unit: unit({ status: "running" }) })
    await journal.append({ type: "unit.settled", runId: "run-1", unit: unit() })
    await journal.finish(
      run({ status: "done", endedAt: 5_000, units: [unit()], tokensSpent: 120, logs: ["starting"] }),
      { answer: "hi" },
    )

    const directory = path.join(root, "runs", "run-1")
    expect(await readFile(path.join(directory, "script.ts"), "utf8")).toBe(SOURCE) // verbatim

    const record = await journal.read("run-1")
    expect(record?.run.status).toBe("done")
    expect(record?.run.units).toHaveLength(1)
    expect(record?.run.tokensSpent).toBe(120)
    expect(record?.source).toBe(SOURCE)
    expect(record?.args).toEqual({ name: "Sam" })
    expect(record?.result).toEqual({ answer: "hi" })
    // START order, which is what Phase 6's replay keys on.
    expect(record?.transitions.map((event) => event.type)).toEqual(["unit.queued", "unit.started", "unit.settled"])
    expect(errors).toEqual([])
  })

  it("keeps the args the run actually saw across the terminal rewrite", async () => {
    await journal.begin(run(), { source: SOURCE, args: { count: 3 } })
    await journal.finish(run({ status: "done", endedAt: 4_000 }), "done")
    expect((await journal.read("run-1"))?.args).toEqual({ count: 3 })
  })

  it("records a run that produced nothing as a run with no result, not as an unfinished one", async () => {
    await journal.begin(run(), { source: SOURCE, args: undefined })
    await journal.finish(run({ status: "done", endedAt: 4_000 }), undefined)
    const record = await journal.read("run-1")
    expect(record?.run.status).toBe("done")
    expect(record?.result).toBeNull()
  })

  it("answers null for a run it has never seen", async () => {
    expect(await journal.read("nobody")).toBeNull()
  })

  it("serializes writes so an append can never overtake the begin that made room for it", async () => {
    // Nothing is awaited: this is exactly how the orchestrator and the store subscriber call it.
    void journal.begin(run(), { source: SOURCE, args: null })
    void journal.append({ type: "unit.queued", runId: "run-1", unit: unit({ status: "queued" }) })
    await journal.append({ type: "unit.settled", runId: "run-1", unit: unit() })
    expect((await journal.read("run-1"))?.transitions).toHaveLength(2)
    expect(errors).toEqual([])
  })

  it("ignores run-level events and appends for runs it never opened", async () => {
    await journal.begin(run(), { source: SOURCE, args: null })
    await journal.append({ type: "run.log", runId: "run-1", value: "noise" })
    await journal.append({ type: "unit.settled", runId: "somebody-else", unit: unit() })
    expect((await journal.read("run-1"))?.transitions).toEqual([])
    expect(errors).toEqual([])
  })
})

describe("journal tolerance for a record a killed host left behind", () => {
  let root = ""
  let journal: Journal

  beforeEach(async () => {
    root = await mkdtemp(path.join(os.tmpdir(), "wf-journal-torn-"))
    journal = createJournal(path.join(root, "runs"), { onError: () => {} })
  })
  afterEach(async () => {
    await rm(root, { recursive: true, force: true })
  })

  it("returns the transitions before a half-written last line rather than nothing", async () => {
    await journal.begin(run(), { source: SOURCE, args: null })
    await journal.append({ type: "unit.settled", runId: "run-1", unit: unit() })
    const units = path.join(root, "runs", "run-1", "units.jsonl")
    await writeFile(units, `${await readFile(units, "utf8")}{"type":"unit.start`, "utf8")

    const record = await journal.read("run-1")
    expect(record?.transitions).toHaveLength(1)
    // The run is still `running` on disk, which is the truth: nothing ever finished it.
    expect(record?.run.status).toBe("running")
    expect(record?.result).toBeUndefined()
  })

  it("still lists a run whose result.json was deleted", async () => {
    await journal.begin(run(), { source: SOURCE, args: null })
    await journal.finish(run({ status: "done", endedAt: 4_000 }), "kept")
    await rm(path.join(root, "runs", "run-1", "result.json"))
    expect((await journal.list()).map((summary) => summary.runId)).toEqual(["run-1"])
    expect((await journal.read("run-1"))?.result).toBeUndefined()
  })

  it("skips a corrupt run.json instead of emptying the whole history", async () => {
    await journal.begin(run(), { source: SOURCE, args: null })
    await journal.finish(run({ status: "done", endedAt: 4_000 }), "kept")
    await journal.begin(run({ runId: "run-2" }), { source: SOURCE, args: null })
    await journal.finish(run({ runId: "run-2", status: "done", endedAt: 4_000 }), "kept")
    await writeFile(path.join(root, "runs", "run-2", "run.json"), "{ not json", "utf8")

    expect((await journal.list()).map((summary) => summary.runId)).toEqual(["run-1"])
    expect(await journal.read("run-2")).toBeNull()
  })

  it("degrades to a report when its root cannot be written, and never rejects", async () => {
    const readOnly = path.join(root, "locked")
    await mkdir(readOnly, { recursive: true })
    await chmod(readOnly, 0o500)
    const reported: string[] = []
    const blocked = createJournal(path.join(readOnly, "runs"), {
      onError: (_error, context) => reported.push(context),
    })
    try {
      // Every one of these resolves. A run whose history cannot be written still ran.
      await blocked.begin(run(), { source: SOURCE, args: null })
      await blocked.append({ type: "unit.settled", runId: "run-1", unit: unit() })
      await blocked.finish(run({ status: "done", endedAt: 4_000 }), "value")
      expect(reported.some((context) => context.startsWith("begin"))).toBe(true)
      expect(await blocked.read("run-1")).toBeNull()
      expect(await blocked.list()).toEqual([])
    } finally {
      await chmod(readOnly, 0o700)
    }
  })
})

describe("journal list", () => {
  let root = ""
  let journal: Journal

  beforeEach(async () => {
    root = await mkdtemp(path.join(os.tmpdir(), "wf-journal-list-"))
    journal = createJournal(path.join(root, "runs"), { onError: () => {} })
    for (const [index, status] of (["done", "failed", "aborted", "done"] as const).entries()) {
      const id = `run-${index}`
      await journal.begin(run({ runId: id, startedAt: 1_000 + index }), { source: SOURCE, args: null })
      await journal.finish(
        run({ runId: id, startedAt: 1_000 + index, status, endedAt: 9_000, units: [unit()], tokensSpent: 10 }),
        "value",
      )
    }
  })
  afterEach(async () => {
    await rm(root, { recursive: true, force: true })
  })

  it("is empty, not an error, before anything has run", async () => {
    expect(await createJournal(path.join(root, "nothing-here")).list()).toEqual([])
  })

  it("lists newest first and pages", async () => {
    expect((await journal.list()).map((summary) => summary.runId)).toEqual(["run-3", "run-2", "run-1", "run-0"])
    expect((await journal.list({ limit: 2 })).map((summary) => summary.runId)).toEqual(["run-3", "run-2"])
    expect(await journal.list({ limit: 0 })).toEqual([])
  })

  it("filters by status", async () => {
    expect((await journal.list({ status: ["done"] })).map((summary) => summary.runId)).toEqual(["run-3", "run-0"])
    expect((await journal.list({ status: ["failed", "aborted"] })).map((summary) => summary.runId)).toEqual([
      "run-2",
      "run-1",
    ])
  })

  it("summarizes every column the run browser puts in a row", async () => {
    const summary = (await journal.list({ limit: 1 }))[0]
    expect(summary).toEqual({
      runId: "run-3",
      workflow: "greet",
      provenance: "inline",
      status: "done",
      units: 1,
      settledUnits: 1,
      tokensSpent: 10,
      phases: ["plan", "gather"],
      phasesDeclared: true,
      currentPhase: "gather",
      startedAt: 1_003,
      endedAt: 9_000,
    })
  })
})

describe("toRunSummary", () => {
  it("counts only units that reached a terminal state", () => {
    const summary = toRunSummary(
      run({
        units: [unit(), unit({ unitId: "u2", status: "running" }), unit({ unitId: "u3", status: "failed" })],
      }),
    )
    expect(summary.units).toBe(3)
    expect(summary.settledUnits).toBe(2)
  })
})

describe("subscribeJournal", () => {
  let root = ""

  beforeEach(async () => {
    root = await mkdtemp(path.join(os.tmpdir(), "wf-journal-sub-"))
  })
  afterEach(async () => {
    await rm(root, { recursive: true, force: true })
  })

  it("mirrors unit transitions off the store and stops when unsubscribed", async () => {
    const journal = createJournal(path.join(root, "runs"), { onError: () => {} })
    const store = createRunStore()
    const unsubscribe = subscribeJournal(store, journal)

    store.create(run())
    await journal.begin(run(), { source: SOURCE, args: null })
    store.apply({ type: "unit.queued", runId: "run-1", unit: unit({ status: "queued" }) })
    store.apply({ type: "run.log", runId: "run-1", value: "not a unit transition" })
    store.apply({ type: "unit.settled", runId: "run-1", unit: unit() })
    await journal.append({ type: "unit.settled", runId: "run-1", unit: unit() }) // drains the write chain

    expect((await journal.read("run-1"))?.transitions.map((event) => event.type)).toEqual([
      "unit.queued",
      "unit.settled",
      "unit.settled",
    ])

    unsubscribe()
    store.apply({ type: "unit.started", runId: "run-1", unit: unit({ status: "running" }) })
    await journal.append({ type: "unit.settled", runId: "run-1", unit: unit() })
    expect((await journal.read("run-1"))?.transitions).toHaveLength(4)
  })
})
