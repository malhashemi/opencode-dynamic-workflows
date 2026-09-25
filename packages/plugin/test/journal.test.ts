import { afterEach, beforeEach, describe, expect, it } from "bun:test"
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { createJournal, journalRoot, subscribeJournal, type Journal } from "../src/journal"
import { emptyUsage, type Unit } from "../src/protocol"
import { createRunStore, newRun } from "../src/runs"

const SOURCE = `import { defineWorkflow } from "@opencode-ai/workflow"\nexport default defineWorkflow({ meta: { name: "wf", description: "d" }, async run() { return 1 } })\n`

let dir: string
let journal: Journal
beforeEach(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), "wf-journal-"))
  journal = createJournal(journalRoot(dir), { onError: () => {} })
})
afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

const baseRun = (runId = "r1") =>
  newRun({ runId, workflow: { key: "wf", name: "wf", description: "d", provenance: "inline" }, location: dir, parentSessionID: "ses_p" })

const unit = (overrides: Partial<Unit>): Unit => ({
  unitId: "u1",
  runId: "r1",
  ordinal: 1,
  label: null,
  subagent: "general",
  phase: null,
  status: "succeeded",
  sessionID: "ses_u",
  location: dir,
  prompt: "p",
  model: { requested: null, resolved: "p/m" },
  schema: false,
  resultPath: "text",
  attempts: [],
  output: "answer",
  usage: emptyUsage(),
  startedAt: 1,
  endedAt: 2,
  ...overrides,
})

describe("journal", () => {
  it("records begin, unit transitions, interactions and finish; read folds them back", async () => {
    const store = createRunStore(dir)
    const unsubscribe = subscribeJournal(store, journal)
    const started = store.create(baseRun())
    await journal.begin(started, { source: SOURCE, args: { a: 1 }, instance: "i1" })
    store.apply({ type: "unit.upsert", runId: "r1", unit: unit({ status: "running", output: undefined }) })
    store.apply({ type: "unit.upsert", runId: "r1", unit: unit({}) })
    await journal.flush()

    // Killed here: run.json still says running with no units, but the transitions are on disk.
    const partial = await journal.read("r1")
    expect(partial?.run.status).toBe("running")
    expect(partial?.run.units.map((u) => `${u.unitId}:${u.status}:${u.output}`)).toEqual(["u1:succeeded:answer"])
    expect(partial?.owner).toEqual({ pid: process.pid, instance: "i1" })
    expect(partial?.source).toBe(SOURCE)

    store.apply({ type: "run.ended", runId: "r1", patch: { status: "succeeded", endedAt: 3 } })
    await journal.finish(store.get("r1")!, { total: 1 })
    unsubscribe()
    const record = await journal.read("r1")
    expect(record?.run.status).toBe("succeeded")
    expect(record?.result).toEqual({ total: 1 })
    expect(record?.args).toEqual({ a: 1 })
  })

  it("skips a torn final line", async () => {
    await journal.begin(baseRun(), { source: SOURCE, args: null, instance: "i" })
    await journal.flush()
    const file = path.join(journalRoot(dir), "r1", "units.jsonl")
    await writeFile(file, `${JSON.stringify({ type: "unit.updated", runId: "r1", data: unit({}) })}\n{"type":"unit.upd`)
    const record = await journal.read("r1")
    expect(record?.run.units).toHaveLength(1)
  })

  it("lists newest first as library entries, filtered by status", async () => {
    const a = { ...baseRun("a"), startedAt: 1 }
    const b = { ...baseRun("b"), startedAt: 2, status: "failed" as const }
    await journal.begin(a, { source: SOURCE, args: null, instance: "i" })
    await journal.finish(b, null)
    const all = await journal.list()
    expect(all.map((entry) => entry.runId)).toEqual(["b", "a"])
    expect(all.every((entry) => entry.live === false)).toBe(true)
    expect((await journal.list({ status: ["failed"] })).map((entry) => entry.runId)).toEqual(["b"])
  })

  it("reads V1 records (done/ok statuses, string workflow)", async () => {
    const directory = path.join(journalRoot(dir), "old")
    await mkdir(directory, { recursive: true })
    await writeFile(
      path.join(directory, "run.json"),
      JSON.stringify({
        version: 1,
        args: null,
        run: {
          runId: "old",
          workflow: "legacy",
          provenance: "durable",
          parentSessionID: "p",
          status: "done",
          startedAt: 5,
          endedAt: 6,
          units: [{ unitId: "x", ordinal: 1, status: "ok", prompt: "q", subagent: "general", output: "a" }],
        },
      }),
    )
    const record = await journal.read("old")
    expect(record?.run.status).toBe("succeeded")
    expect(record?.run.workflow.name).toBe("legacy")
    expect(record?.run.units[0]?.status).toBe("succeeded")
  })

  it("update rewrites run.json and keeps the args", async () => {
    await journal.begin(baseRun(), { source: SOURCE, args: { keep: true }, instance: "i" })
    await journal.update({ ...baseRun(), status: "interrupted", cleanup: "pending" })
    await journal.flush()
    const raw = JSON.parse(await readFile(path.join(journalRoot(dir), "r1", "run.json"), "utf8"))
    expect(raw.run.status).toBe("interrupted")
    expect(raw.run.cleanup).toBe("pending")
    expect(raw.args).toEqual({ keep: true })
  })
})
