/**
 * Navigation, without a terminal.
 *
 * Everything a run browser gets wrong is invisible in a screenshot: a cursor left past the end of a filtered
 * list, a drill into a row that settled a frame earlier, a stack still pointing at a run whose engine has
 * gone. Those are the assertions here. `route.test.tsx` proves the same model actually renders.
 */
import { describe, expect, it } from "bun:test"
import { toRunSummary, type RunSummary } from "../../src/journal"
import type { PendingInteraction, RunSnapshot, UnitSnapshot } from "../../src/runs"
import {
  breadcrumb,
  findInteraction,
  initialRouteState,
  listRows,
  normalizeRoute,
  openQuestion,
  pendingInteractions,
  questionRowCount,
  reduceRoute,
  runRows,
  selectedControl,
  selectIndex,
  unitDetail,
  type RouteState,
} from "../../src/tui/route-model"

function unit(overrides: Partial<UnitSnapshot> = {}): UnitSnapshot {
  return {
    unitId: "unit-1",
    ordinal: 1,
    label: null,
    subagent: "general",
    phase: "gather",
    status: "running",
    sessionID: "child-1",
    prompt: "do the thing\nsecond line",
    startedAt: 1_000,
    endedAt: null,
    ...overrides,
  }
}

function run(overrides: Partial<RunSnapshot> = {}): RunSnapshot {
  return {
    runId: "run-1",
    workflow: "deep-research",
    provenance: "durable",
    parentSessionID: "parent",
    status: "running",
    phases: ["plan", "gather", "synthesize"],
    phasesDeclared: true,
    currentPhase: "gather",
    units: [unit()],
    logs: [],
    errors: [],
    interactions: [],
    tokensSpent: 0,
    startedAt: 1_000,
    endedAt: null,
    ...overrides,
  }
}

/** Drive a sequence of actions against one set of runs, the way a keystroke run would. */
function drive(
  state: RouteState,
  actions: Parameters<typeof reduceRoute>[1][],
  runs: readonly RunSnapshot[],
  history: readonly RunSummary[] = [],
) {
  return actions.reduce((current, action) => reduceRoute(current, action, runs, history), state)
}

/** A journal summary for a run that is no longer in any store — history, as the endpoint serves it. */
function summary(overrides: Partial<RunSnapshot> = {}): RunSummary {
  return toRunSummary(run({ status: "done", endedAt: 4_000, ...overrides }))
}

describe("listRows", () => {
  const runs = [
    run({ runId: "live-old", startedAt: 1_000 }),
    run({ runId: "live-new", startedAt: 5_000 }),
    run({ runId: "finished", status: "done", startedAt: 9_000, endedAt: 12_000 }),
    run({ runId: "broken", status: "failed", startedAt: 8_000, endedAt: 10_000 }),
    run({ runId: "stopped", status: "aborted", startedAt: 7_000, endedAt: 11_000 }),
  ]

  it("puts live runs first, then the newest settled ones", () => {
    expect(listRows(runs, [], "all").map((row) => row.runId)).toEqual([
      "live-new",
      "live-old",
      "finished",
      "broken",
      "stopped",
    ])
  })

  it("filters by status, keeping a stopped run with the failures so `x` never hides its own result", () => {
    expect(listRows(runs, [], "active").map((row) => row.runId)).toEqual(["live-new", "live-old"])
    expect(listRows(runs, [], "done").map((row) => row.runId)).toEqual(["finished"])
    expect(listRows(runs, [], "failed").map((row) => row.runId)).toEqual(["broken", "stopped"])
  })

  it("describes a live run by where it is and a settled one by how it ended", () => {
    const [live] = listRows([run({ units: [unit(), unit({ unitId: "unit-2", status: "ok", endedAt: 2_000 })] })], [], "all")
    expect(live?.position).toBe("phase 2/3")
    expect(live?.phase).toBe("gather")
    expect(live?.units).toBe("1/2")
    expect(live?.glyph).toBe("running")

    const [settled] = listRows([run({ status: "done", endedAt: 4_000, units: [unit({ status: "ok", endedAt: 3_000 })] })], [], "all")
    // A settled run's phase title is stale news; its outcome takes the column.
    expect(settled?.phase).toBe("done")
    expect(settled?.units).toBe("1/1")
    expect(settled?.glyph).toBe("done")
    expect(settled?.elapsed).toBe("3s")
  })

  it("carries the columns a list needs to read as a timeline, not just a pile of durations", () => {
    const [row] = listRows([run({ tokensSpent: 41_200, units: [unit(), unit({ unitId: "u2", status: "ok" })] })], [], "all")
    expect(row?.tokens).toBe("41k")
    expect(row?.startedAt).toMatch(/^\d{2}:\d{2}$/)
    expect(row?.phaseRatio).toBeCloseTo(2 / 3)
    expect(row?.unitRatio).toBeCloseTo(1 / 2)
  })

  it("omits the phase meter and denominator for a workflow that never declared its phases", () => {
    // `phase 1/1` on the first of three undeclared phases does not merely round badly — it asserts the run is
    // on its last phase.
    const undeclared = run({ phases: ["Plan"], phasesDeclared: false, currentPhase: "Plan" })
    const [row] = listRows([undeclared], [], "all")
    expect(row?.position).toBe("phase 1")
    expect(row?.phaseRatio).toBeNull()
  })

  it("marks a store row live and a journal row not", () => {
    expect(listRows(runs, [], "all").every((row) => row.live)).toBe(true)
    expect(listRows(runs, [], "all").every((row) => row.pendingQuestions === 0)).toBe(true)
    expect(listRows([], [summary({ runId: "old" })], "all").map((row) => row.live)).toEqual([false])
  })
})

describe("listRows: journal history alongside live runs", () => {
  it("puts this session's runs first and history after, newest first within each", () => {
    const rows = listRows(
      [run({ runId: "live", startedAt: 5_000 }), run({ runId: "settled", status: "done", startedAt: 4_000, endedAt: 6_000 })],
      [summary({ runId: "yesterday", startedAt: 1_000 }), summary({ runId: "today", startedAt: 3_000 })],
      "all",
    )
    expect(rows.map((row) => row.runId)).toEqual(["live", "settled", "today", "yesterday"])
    expect(rows.map((row) => row.live)).toEqual([true, true, false, false])
  })

  it("lets the live snapshot win when the journal also has the run", () => {
    // The store's copy is current to the millisecond; the journal's was written when the run began.
    const live = run({ runId: "same", status: "running", tokensSpent: 900 })
    const rows = listRows([live], [toRunSummary(run({ runId: "same", status: "running", tokensSpent: 0 }))], "all")
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ live: true, tokens: "900" })
  })

  it("fills every column a live row fills, so a history row is older rather than broken", () => {
    const [row] = listRows(
      [],
      [
        summary({
          runId: "past",
          status: "failed",
          endedAt: 4_000,
          tokensSpent: 41_200,
          currentPhase: "gather",
          units: [unit({ status: "ok", endedAt: 2_000 }), unit({ unitId: "u2", status: "failed", endedAt: 3_000 })],
        }),
      ],
      "all",
    )
    expect(row).toMatchObject({
      runId: "past",
      glyph: "failed",
      workflow: "deep-research",
      // A failure keeps its position: where it stopped is the first thing asked about it.
      position: "phase 2/3",
      phase: "failed",
      units: "2/2",
      tokens: "41k",
      elapsed: "3s",
      live: false,
    })
    expect(row?.phaseRatio).toBeCloseTo(2 / 3)
    expect(row?.startedAt).toMatch(/^\d{2}:\d{2}$/)
  })

  it("filters history by the same rule as live runs", () => {
    const history = [
      summary({ runId: "ok", status: "done" }),
      summary({ runId: "broke", status: "failed" }),
      summary({ runId: "stopped", status: "aborted" }),
    ]
    expect(listRows([], history, "done").map((row) => row.runId)).toEqual(["ok"])
    expect(listRows([], history, "failed").map((row) => row.runId).sort()).toEqual(["broke", "stopped"])
    expect(listRows([], history, "active")).toEqual([])
  })

  it("shows a journal run left `running` by a dead host as stopped, not as a phantom spinner", () => {
    // Its engine is gone by definition — the client merges every live endpoint, so nothing claims it. Left as
    // `running` it would sort ahead of every real run and spin forever.
    const [row] = listRows([], [toRunSummary(run({ runId: "killed", status: "running", endedAt: null }))], "all")
    expect(row?.glyph).toBe("aborted")
    expect(row?.phase).toBe("aborted")
    expect(listRows([], [toRunSummary(run({ runId: "killed", status: "running" }))], "active")).toEqual([])
  })
})

describe("runRows", () => {
  it("nests a phase's units under it, in declared phase order", () => {
    const rows = runRows(
      run({
        units: [
          unit({ unitId: "u1", ordinal: 1, phase: "plan", status: "ok", endedAt: 2_000, label: "outline" }),
          unit({ unitId: "u2", ordinal: 2, phase: "gather" }),
          unit({ unitId: "u3", ordinal: 3, phase: "gather", status: "queued", startedAt: null, sessionID: null }),
        ],
      }),
    )
    expect(rows.map((row) => [row.kind, row.id, row.glyph, row.indent])).toEqual([
      ["phase", "plan", "ok", 0],
      ["unit", "u1", "ok", 1],
      ["phase", "gather", "running", 0],
      ["unit", "u2", "running", 1],
      ["unit", "u3", "queued", 1],
      ["phase", "synthesize", "queued", 0],
    ])
    expect(rows[0]?.label).toBe("Phase 1/3  plan")
    expect(rows[1]?.label).toBe("#1 general")
    expect(rows[1]?.detail).toBe("outline")
  })

  it("marks a phase failed as soon as one of its units does", () => {
    const rows = runRows(
      run({ units: [unit({ status: "failed", endedAt: 2_000, error: "boom" }), unit({ unitId: "u2", ordinal: 2, status: "ok", endedAt: 2_000 })] }),
    )
    expect(rows.find((row) => row.id === "gather")?.glyph).toBe("failed")
    // The error is what the row should say — a failed unit's label is not the news.
    expect(rows.find((row) => row.id === "unit-1")?.detail).toBe("boom")
  })

  it("keeps units the script launched outside any declared phase reachable", () => {
    const rows = runRows(run({ units: [unit({ phase: null }), unit({ unitId: "u2", ordinal: 2, phase: "improvised" })] }))
    expect(rows.filter((row) => row.kind === "unit").map((row) => row.id)).toEqual(["unit-1", "u2"])
  })

  it("lists units flat when the run declared no phases at all", () => {
    const rows = runRows(run({ phases: [], currentPhase: null, units: [unit({ phase: null })] }))
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ kind: "unit", indent: 0 })
  })
})

describe("reduceRoute", () => {
  const runs = [run({ runId: "a", startedAt: 5_000 }), run({ runId: "b", startedAt: 1_000 })]

  it("opens on the list, or on a run when the sidebar named one", () => {
    expect(initialRouteState()).toEqual({ stack: [{ kind: "list", selected: 0 }], filter: "all" })
    expect(initialRouteState("b").stack).toEqual([
      { kind: "list", selected: 0 },
      { kind: "run", runId: "b", selected: 0 },
    ])
  })

  it("moves the selection and clamps it at both ends", () => {
    const bottom = drive(initialRouteState(), ["down", "down", "down"], runs)
    expect(bottom.stack[0]).toEqual({ kind: "list", selected: 1 })
    const top = drive(bottom, ["up", "up", "up"], runs)
    expect(top.stack[0]).toEqual({ kind: "list", selected: 0 })
  })

  it("drills list → run → unit and backs out level by level", () => {
    const withUnits = [run({ runId: "a", units: [unit({ unitId: "u1" })] })]
    const atRun = drive(initialRouteState(), ["drill"], withUnits)
    expect(atRun.stack.at(-1)).toEqual({ kind: "run", runId: "a", selected: 0 })

    // Row 0 of the run level is the `plan` PHASE row; drilling it is a deliberate no-op.
    expect(drive(atRun, ["drill"], withUnits).stack).toEqual(atRun.stack)

    const atUnit = drive(atRun, ["down", "down", "drill"], withUnits)
    expect(atUnit.stack.at(-1)).toEqual({ kind: "unit", runId: "a", unitId: "u1", scroll: 0 })

    expect(drive(atUnit, ["back"], withUnits).stack.at(-1)?.kind).toBe("run")
    expect(drive(atUnit, ["back", "back"], withUnits).stack).toHaveLength(1)
    // The list level is the floor — leaving the route is the caller's decision, not the reducer's.
    expect(drive(atUnit, ["back", "back", "back"], withUnits).stack).toHaveLength(1)
  })

  it("scrolls rather than selects at the unit level, and never scrolls above the top", () => {
    const withUnits = [run({ runId: "a", units: [unit({ unitId: "u1" })] })]
    const atUnit = drive(initialRouteState(), ["drill", "down", "down", "drill"], withUnits)
    expect(drive(atUnit, ["down", "down"], withUnits).stack.at(-1)).toMatchObject({ scroll: 2 })
    expect(drive(atUnit, ["up"], withUnits).stack.at(-1)).toMatchObject({ scroll: 0 })
  })

  it("cycles the filter and re-bases the list cursor, but leaves deeper levels alone", () => {
    const mixed = [run({ runId: "a" }), run({ runId: "b", status: "done", endedAt: 2_000 })]
    const drilled = drive(initialRouteState(), ["down", "drill"], mixed)
    expect(drilled.stack.at(-1)).toMatchObject({ kind: "run", runId: "b" })

    const filtered = reduceRoute(drilled, "filter", mixed)
    expect(filtered.filter).toBe("active")
    expect(filtered.stack[0]).toEqual({ kind: "list", selected: 0 })
    // The filter is about the LIST; a run you already opened does not vanish because it stopped matching.
    expect(filtered.stack.at(-1)).toMatchObject({ kind: "run", runId: "b" })

    expect(drive(filtered, ["filter", "filter", "filter"], mixed).filter).toBe("all")
  })

  it("leaves navigation untouched for the actions that act on the world", () => {
    const state = drive(initialRouteState(), ["down"], runs)
    for (const action of ["stop", "save", "restart", "resume"] as const) {
      expect(reduceRoute(state, action, runs)).toEqual(state)
    }
  })
})

describe("normalizeRoute", () => {
  it("pulls a selection back inside a list that shrank under the cursor", () => {
    const runs = [run({ runId: "a" }), run({ runId: "b" }), run({ runId: "c" })]
    const state = drive(initialRouteState(), ["down", "down"], runs)
    expect(state.stack[0]).toEqual({ kind: "list", selected: 2 })
    expect(normalizeRoute(state, runs.slice(0, 1)).stack[0]).toEqual({ kind: "list", selected: 0 })
  })

  it("drops a level whose run — or whose unit — is no longer there", () => {
    const runs = [run({ runId: "a", units: [unit({ unitId: "u1" })] })]
    const atUnit = drive(initialRouteState(), ["drill", "down", "down", "drill"], runs)
    expect(atUnit.stack).toHaveLength(3)

    // The unit went (a snapshot from a different endpoint won the merge): fall back to the run.
    expect(normalizeRoute(atUnit, [run({ runId: "a", units: [] })]).stack).toHaveLength(2)
    // The whole run went: fall back to the list, rather than rendering a breadcrumb to nothing.
    expect(normalizeRoute(atUnit, []).stack).toEqual([{ kind: "list", selected: 0 }])
  })
})

describe("breadcrumb", () => {
  const runs = [run({ runId: "a", units: [unit({ unitId: "u1", ordinal: 4, label: "arxiv sweep" })] })]

  it("names each level the way the user chose it", () => {
    expect(breadcrumb(initialRouteState(), runs)).toBe("Workflows")
    const atRun = drive(initialRouteState(), ["drill"], runs)
    expect(breadcrumb(atRun, runs)).toBe("Workflows ▸ deep-research")
    const atUnit = drive(atRun, ["down", "down", "drill"], runs)
    expect(breadcrumb(atUnit, runs)).toBe("Workflows ▸ deep-research ▸ #4 arxiv sweep")
  })

  it("falls back to ids rather than rendering a hole when state outruns the snapshot", () => {
    const stale: RouteState = {
      stack: [
        { kind: "list", selected: 0 },
        { kind: "run", runId: "gone", selected: 0 },
      ],
      filter: "all",
    }
    expect(breadcrumb(stale, runs)).toBe("Workflows ▸ gone")
  })
})

describe("unitDetail", () => {
  it("returns everything the unit screen shows, and null for a unit that is not there", () => {
    const target = run({ units: [unit({ unitId: "u1", status: "failed", endedAt: 4_000, error: "boom" })] })
    expect(unitDetail(target, "u1")).toEqual({
      unitId: "u1",
      ordinal: 1,
      label: null,
      subagent: "general",
      phase: "gather",
      status: "failed",
      sessionID: "child-1",
      prompt: "do the thing\nsecond line",
      error: "boom",
      elapsed: "3s",
      replayed: false,
      output: null,
    })
    expect(unitDetail(target, "nope")).toBeNull()
  })

  it("carries a structured answer as JSON and a text answer as text", () => {
    const structured = run({
      units: [unit({ unitId: "u1", status: "ok", endedAt: 4_000, output: '{"areas":["a","b"]}' })],
    })
    expect(unitDetail(structured, "u1")?.output).toEqual({
      kind: "json",
      // Re-serialized with indentation: the engine stores it compact, the screen needs it readable.
      content: '{\n  "areas": [\n    "a",\n    "b"\n  ]\n}',
    })

    const text = run({ units: [unit({ unitId: "u1", status: "ok", endedAt: 4_000, output: "just prose" })] })
    expect(unitDetail(text, "u1")?.output).toEqual({ kind: "text", content: "just prose" })
  })

  it("shows a non-JSON answer as the text it is rather than failing to highlight it", () => {
    const cut = run({ units: [unit({ unitId: "u1", status: "ok", endedAt: 4_000, output: '{"areas":["a' })] })
    expect(unitDetail(cut, "u1")?.output?.kind).toBe("text")
  })

  it("has no answer for a unit that has not finished", () => {
    expect(unitDetail(run(), "unit-1")?.output).toBeNull()
  })

  it("carries a long answer whole — the unit screen scrolls, so there is nothing to truncate for", () => {
    // Two earlier versions capped this, and both cut real research answers. The screen is a scrollbox.
    const long = "x".repeat(200_000)
    const target = run({ units: [unit({ unitId: "u1", status: "ok", endedAt: 4_000, output: long })] })
    expect(unitDetail(target, "u1")?.output?.content).toHaveLength(200_000)
  })
})

describe("selectedControl", () => {
  const runs = [run({ runId: "a", units: [unit({ unitId: "u1" })] })]

  it("targets the selected run from the list", () => {
    expect(selectedControl(initialRouteState(), runs, "stop")).toEqual({ action: "stop.run", runId: "a" })
  })

  it("targets the run from a phase row and the unit from a unit row", () => {
    const atRun = drive(initialRouteState(), ["drill"], runs)
    expect(selectedControl(atRun, runs, "stop")).toEqual({ action: "stop.run", runId: "a" })

    const onUnit = drive(atRun, ["down", "down"], runs)
    expect(selectedControl(onUnit, runs, "stop")).toEqual({ action: "stop.unit", runId: "a", unitId: "u1" })
  })

  it("targets the open unit from the unit level", () => {
    const atUnit = drive(initialRouteState(), ["drill", "down", "down", "drill"], runs)
    expect(selectedControl(atUnit, runs, "stop")).toEqual({ action: "stop.unit", runId: "a", unitId: "u1" })
  })

  it("answers null for an empty list and for every action it does not own yet", () => {
    expect(selectedControl(initialRouteState(), [], "stop")).toBeNull()
    for (const action of ["up", "drill", "filter", "restart", "resume"] as const) {
      expect(selectedControl(initialRouteState(), runs, action)).toBeNull()
    }
  })

  it("targets the run for `save` from every level, because a unit has no script of its own", () => {
    expect(selectedControl(initialRouteState(), runs, "save")).toEqual({ action: "save.run", runId: "a" })
    const onUnit = drive(initialRouteState(), ["drill", "down", "down"], runs)
    expect(selectedControl(onUnit, runs, "save")).toEqual({ action: "save.run", runId: "a" })
    const atUnit = drive(initialRouteState(), ["drill", "down", "down", "drill"], runs)
    expect(selectedControl(atUnit, runs, "save")).toEqual({ action: "save.run", runId: "a" })
  })

  it("targets a history row for `save` — the run whose engine is gone is the one worth keeping", () => {
    const history = [summary({ runId: "past" })]
    const onHistory = drive(initialRouteState(), ["down"], [], history)
    expect(selectedControl(onHistory, [], "save", history)).toEqual({ action: "save.run", runId: "past" })
  })
})

describe("history rows and navigation", () => {
  const history = [summary({ runId: "past-a", startedAt: 3_000 }), summary({ runId: "past-b", startedAt: 2_000 })]

  it("moves the cursor over history rows, which are part of the same list", () => {
    const bottom = drive(initialRouteState(), ["down", "down", "down"], [], history)
    expect(bottom.stack[0]).toEqual({ kind: "list", selected: 1 })
  })

  it("refuses to drill a history row: a summary has no phases or units to open", () => {
    const onHistory = drive(initialRouteState(), ["down"], [], history)
    expect(drive(onHistory, ["drill"], [], history).stack).toHaveLength(1)
  })

  it("clamps the cursor back when history is not passed to a level that counted it", () => {
    // The guard behind `history` defaulting to none: a caller that renders history and forgets it here would
    // leave the cursor pointing past the end of what it did count.
    const onHistory = drive(initialRouteState(), ["down"], [], history)
    expect(normalizeRoute(onHistory, []).stack[0]).toEqual({ kind: "list", selected: 0 })
    expect(normalizeRoute(onHistory, [], history).stack[0]).toEqual({ kind: "list", selected: 1 })
  })
})

describe("selectIndex — what a mouse click means", () => {
  it("moves the selection at the current level", () => {
    const moved = selectIndex(initialRouteState(), 2)
    expect(moved.stack[0]).toMatchObject({ kind: "list", selected: 2 })
  })

  it("is identity when the click lands on the row already selected", () => {
    const state = selectIndex(initialRouteState(), 2)
    // Reference equality, not just deep equality: the view re-normalizes several times a second, and a fresh
    // object each time invalidates every memo downstream for no reason.
    expect(selectIndex(state, 2)).toBe(state)
  })

  it("refuses to invent a selection on the unit level, which scrolls rather than selects", () => {
    // Phaseless, so the run level's first row is the unit itself rather than a phase header.
    const only = [run({ phases: [], phasesDeclared: false, currentPhase: null, units: [unit({ phase: null })] })]
    const drilled = reduceRoute(reduceRoute(initialRouteState(), "drill", only), "drill", only)
    expect(drilled.stack.at(-1)?.kind).toBe("unit")
    expect(selectIndex(drilled, 3)).toBe(drilled)
  })

  it("never selects a negative row", () => {
    expect(selectIndex(initialRouteState(), -5).stack[0]).toMatchObject({ selected: 0 })
  })
})

/**
 * The `question` level — the answer pane as a member of the drill stack.
 *
 * Making the pane a level rather than a modal buys three things that are all asserted here: it is reached by
 * the same ⏎ that opens a unit, `esc` walks out of it the way it walks out of everything else, and — the one
 * that only a level can do — it UNWINDS BY ITSELF when the question is answered somewhere else.
 */
describe("route model: the answer pane as a level", () => {
  function interaction(overrides: Partial<PendingInteraction> = {}): PendingInteraction {
    return {
      requestID: "req-1",
      kind: "question",
      origin: "agent",
      sessionID: "child-1",
      unitId: "unit-1",
      depth: 2,
      questions: [
        {
          header: "Citations",
          prompt: "Which citation style?",
          options: [
            { label: "APA", description: "American Psychological Association" },
            { label: "MLA", description: "Modern Language Association" },
          ],
          multiple: false,
          custom: false,
        },
      ],
      raisedAt: 2_000,
      graceEndsAt: 302_000,
      ...overrides,
    }
  }

  const asking = run({ interactions: [interaction()] })

  it("pins waiting interactions above the phases, where they cannot be missed", () => {
    const rows = runRows(asking)
    expect(rows[0]).toMatchObject({ kind: "interaction", id: "req-1", glyph: "question", label: "Question" })
    expect(rows[0]?.detail).toContain("Citations")
    // A forty-unit fan-out must not be able to bury the one row asking for something.
    expect(rows.slice(1).every((row) => row.kind !== "interaction")).toBe(true)
  })

  it("drills into the pane with the same ⏎ that opens a unit", () => {
    const opened = drive(initialRouteState("run-1"), ["drill"], [asking])
    expect(opened.stack.at(-1)).toEqual({
      kind: "question",
      runId: "run-1",
      requestID: "req-1",
      selected: 0,
      custom: null,
    })
    expect(breadcrumb(opened, [asking])).toBe("Workflows ▸ deep-research ▸ question")
  })

  it("moves the cursor over the offered options, and no further", () => {
    const opened = drive(initialRouteState("run-1"), ["drill", "down", "down", "down"], [asking])
    const level = opened.stack.at(-1)
    expect(level).toMatchObject({ kind: "question", selected: 1 }) // two options, clamped
    expect(drive(opened, ["up", "up"], [asking]).stack.at(-1)).toMatchObject({ selected: 0 })
  })

  it("counts a custom-answer row only when the question allows one", () => {
    expect(questionRowCount(interaction())).toBe(2)
    expect(questionRowCount(interaction({ questions: [{ ...interaction().questions[0]!, custom: true }] }))).toBe(3)
  })

  it("unwinds the moment the question is answered, whoever answered it", () => {
    const opened = drive(initialRouteState("run-1"), ["drill"], [asking])
    expect(opened.stack).toHaveLength(3)
    // Another surface, or the watcher's grace running out: either way the interaction is gone from the run.
    const answered = normalizeRoute(opened, [run({ interactions: [] })])
    expect(answered.stack.map((level) => level.kind)).toEqual(["list", "run"])
  })

  it("targets the RUN when `x` is pressed on the pane — a question has nothing of its own to stop", () => {
    const opened = drive(initialRouteState("run-1"), ["drill"], [asking])
    expect(selectedControl(opened, [asking], "stop")).toEqual({ action: "stop.run", runId: "run-1" })
  })

  it("counts and orders every waiting interaction across runs, oldest first", () => {
    const other = run({
      runId: "run-2",
      interactions: [interaction({ requestID: "req-0", raisedAt: 1_000 })],
    })
    expect(pendingInteractions([asking, other]).map((entry) => entry.requestID)).toEqual(["req-0", "req-1"])
    expect(listRows([asking, other], [], "all").map((row) => row.pendingQuestions)).toEqual([1, 1])
    expect(findInteraction([asking], "run-1", "req-1")?.requestID).toBe("req-1")
    expect(findInteraction([asking], "run-1", "nope")).toBeNull()
  })

  it("opens the pane from a deep link on the stack the run browser would have built", () => {
    const linked = openQuestion(initialRouteState(), "run-1", "req-1")
    // `list → run → question`, so `esc` walks back out through the run the question belongs to rather than to
    // wherever the user happened to be when the badge lit up.
    expect(linked.stack.map((level) => level.kind)).toEqual(["list", "run", "question"])
    expect(normalizeRoute(linked, [asking]).stack).toHaveLength(3)
  })
})
