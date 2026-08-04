/**
 * Navigation, without a terminal.
 *
 * Everything a run browser gets wrong is invisible in a screenshot: a cursor left past the end of a filtered
 * list, a drill into a row that settled a frame earlier, a stack still pointing at a run whose engine has
 * gone. Those are the assertions here. `route.test.tsx` proves the same model actually renders.
 */
import { describe, expect, it } from "bun:test"
import type { RunSnapshot, UnitSnapshot } from "../../src/runs"
import {
  breadcrumb,
  initialRouteState,
  listRows,
  normalizeRoute,
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
    tokensSpent: 0,
    startedAt: 1_000,
    endedAt: null,
    ...overrides,
  }
}

/** Drive a sequence of actions against one set of runs, the way a keystroke run would. */
function drive(state: RouteState, actions: Parameters<typeof reduceRoute>[1][], runs: readonly RunSnapshot[]) {
  return actions.reduce((current, action) => reduceRoute(current, action, runs), state)
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
    expect(listRows(runs, "all").map((row) => row.runId)).toEqual([
      "live-new",
      "live-old",
      "finished",
      "broken",
      "stopped",
    ])
  })

  it("filters by status, keeping a stopped run with the failures so `x` never hides its own result", () => {
    expect(listRows(runs, "active").map((row) => row.runId)).toEqual(["live-new", "live-old"])
    expect(listRows(runs, "done").map((row) => row.runId)).toEqual(["finished"])
    expect(listRows(runs, "failed").map((row) => row.runId)).toEqual(["broken", "stopped"])
  })

  it("describes a live run by where it is and a settled one by how it ended", () => {
    const [live] = listRows([run({ units: [unit(), unit({ unitId: "unit-2", status: "ok", endedAt: 2_000 })] })], "all")
    expect(live?.position).toBe("phase 2/3")
    expect(live?.phase).toBe("gather")
    expect(live?.units).toBe("1/2")
    expect(live?.glyph).toBe("running")

    const [settled] = listRows([run({ status: "done", endedAt: 4_000, units: [unit({ status: "ok", endedAt: 3_000 })] })], "all")
    // A settled run's phase title is stale news; its outcome takes the column.
    expect(settled?.phase).toBe("done")
    expect(settled?.units).toBe("1/1")
    expect(settled?.glyph).toBe("done")
    expect(settled?.elapsed).toBe("3s")
  })

  it("carries the columns a list needs to read as a timeline, not just a pile of durations", () => {
    const [row] = listRows([run({ tokensSpent: 41_200, units: [unit(), unit({ unitId: "u2", status: "ok" })] })], "all")
    expect(row?.tokens).toBe("41k")
    expect(row?.startedAt).toMatch(/^\d{2}:\d{2}$/)
    expect(row?.phaseRatio).toBeCloseTo(2 / 3)
    expect(row?.unitRatio).toBeCloseTo(1 / 2)
  })

  it("omits the phase meter and denominator for a workflow that never declared its phases", () => {
    // `phase 1/1` on the first of three undeclared phases does not merely round badly — it asserts the run is
    // on its last phase.
    const undeclared = run({ phases: ["Plan"], phasesDeclared: false, currentPhase: "Plan" })
    const [row] = listRows([undeclared], "all")
    expect(row?.position).toBe("phase 1")
    expect(row?.phaseRatio).toBeNull()
  })

  it("marks every row live until Phase 3 merges journal history in", () => {
    expect(listRows(runs, "all").every((row) => row.live)).toBe(true)
    expect(listRows(runs, "all").every((row) => row.pendingQuestions === 0)).toBe(true)
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

  it("treats a truncated structured answer as text rather than as broken JSON", () => {
    // The engine caps long outputs, which can cut mid-token. Rendering that through a JSON highlighter shows
    // a parse failure where the user asked to see an answer.
    const cut = run({ units: [unit({ unitId: "u1", status: "ok", endedAt: 4_000, output: '{"areas":["a' })] })
    expect(unitDetail(cut, "u1")?.output?.kind).toBe("text")
  })

  it("has no answer for a unit that has not finished", () => {
    expect(unitDetail(run(), "unit-1")?.output).toBeNull()
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
    for (const action of ["up", "drill", "filter", "save", "restart", "resume"] as const) {
      expect(selectedControl(initialRouteState(), runs, action)).toBeNull()
    }
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
