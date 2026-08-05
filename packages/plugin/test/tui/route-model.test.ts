/**
 * Navigation, without a terminal.
 *
 * Everything a run browser gets wrong is invisible in a screenshot: a cursor left past the end of a filtered
 * list, a drill into a row that settled a frame earlier, a stack still pointing at a run whose engine has
 * gone. Those are the assertions here. `route.test.tsx` proves the same model actually renders.
 */
import { describe, expect, it } from "bun:test"
import { toRunSummary, type RunSummary } from "../../src/journal"
import type { PendingInteraction, ResolvedInteraction, RunSnapshot, UnitSnapshot } from "../../src/runs"
import {
  answerSummary,
  breadcrumb,
  cycleQuestion,
  findInteraction,
  findResolved,
  initialRouteState,
  listRows,
  multiSelectQuestion,
  normalizeRoute,
  openQuestion,
  pendingInteractions,
  questionTabs,
  questionRowCount,
  reduceRoute,
  toggleChoice,
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
    resolved: [],
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

describe("listRows: the day a run started", () => {
  // `startedAt` alone was ambiguous the moment History started carrying runs from earlier sessions: "14:03"
  // does not say which 14:03. The day column answers that — and stays EMPTY for today, because a column
  // repeating one date down every row of a list opened today is width spent on nothing.
  const at = (year: number, month: number, day: number, hour = 14, minute = 3) =>
    new Date(year, month, day, hour, minute).getTime()
  const now = at(2026, 7, 5, 9, 0) // 5 Aug 2026, 09:00

  const dayOf = (startedAt: number) => listRows([run({ runId: "r", startedAt })], [], "all", now)[0]?.startedOn

  it("is empty for a run started today", () => {
    expect(dayOf(at(2026, 7, 5, 8, 30))).toBe("")
  })

  it("reads `yesterday` for the calendar day before, however few hours ago that was", () => {
    // 23:50 yesterday is forty minutes before 00:10 today, and an elapsed-hours rule would call both the same
    // day for most of the following day. People read `yesterday` off a calendar, not off a stopwatch.
    expect(dayOf(at(2026, 7, 4, 23, 50))).toBe("yesterday")
    expect(dayOf(at(2026, 7, 4, 0, 5))).toBe("yesterday")
  })

  it("names the day earlier in the year, and adds the year beyond it", () => {
    expect(dayOf(at(2026, 7, 1))).toBe("Aug 1")
    expect(dayOf(at(2026, 0, 9))).toBe("Jan 9")
    expect(dayOf(at(2025, 11, 31))).toBe("Dec 31 2025")
  })

  it("dates a journal row the same way it dates a live one", () => {
    const rows = listRows([], [summary({ runId: "old", startedAt: at(2026, 7, 3) })], "all", now)
    expect(rows[0]?.startedOn).toBe("Aug 3")
    expect(rows[0]?.startedAt).toBe("14:03")
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

/**
 * A settled run must not have anything on it still claiming to be running.
 *
 * The regression: the phase glyph chain ended `index === currentIndex ? "running" : …` and never consulted
 * `run.status`, so a phase with no units of its own — `finish` in `asks-the-human`, which only calls `ask` —
 * spun forever after the run had finished. A phase row is one of the two places a user looks to answer "is this
 * over?", and it was answering "no" about a run that was done.
 */
describe("runRows: nothing spins on a run that is over", () => {
  const phaseless = (status: RunSnapshot["status"]) =>
    run({
      status,
      endedAt: 9_000,
      phases: ["plan", "finish"],
      currentPhase: "finish",
      units: [unit({ unitId: "u1", phase: "plan", status: "ok", endedAt: 2_000 })],
    })

  it("closes a unit-less current phase with the run's own outcome", () => {
    expect(runRows(phaseless("done")).find((row) => row.id === "finish")?.glyph).toBe("ok")
    expect(runRows(phaseless("failed")).find((row) => row.id === "finish")?.glyph).toBe("failed")
    // `⊘`, not `✗`: a run the user stopped did not fail, and the list level has said so since Phase 2.
    expect(runRows(phaseless("aborted")).find((row) => row.id === "finish")?.glyph).toBe("stopped")
  })

  it("leaves a live run's current phase running, which is the whole point of the glyph", () => {
    expect(runRows(phaseless("running")).find((row) => row.id === "finish")?.glyph).toBe("running")
  })

  it("closes a unit the run left mid-flight, rather than spinning it forever", () => {
    const killed = run({
      status: "aborted",
      endedAt: 9_000,
      units: [unit({ unitId: "u1", phase: "gather", status: "running" })],
    })
    expect(runRows(killed).find((row) => row.id === "u1")?.glyph).toBe("stopped")
    expect(runRows(killed).find((row) => row.id === "gather")?.glyph).toBe("stopped")
  })

  it("never renders `running` anywhere on a settled run", () => {
    for (const status of ["done", "failed", "aborted"] as const) {
      const rows = runRows(
        run({
          status,
          endedAt: 9_000,
          units: [
            unit({ unitId: "u1", phase: "plan", status: "ok", endedAt: 2_000 }),
            unit({ unitId: "u2", phase: "gather", status: "running" }),
            unit({ unitId: "u3", phase: "synthesize", status: "queued", startedAt: null }),
          ],
        }),
      )
      expect(rows.some((row) => row.glyph === "running")).toBe(false)
    }
  })
})

/**
 * Answered questions, as rows you can find again.
 *
 * The user's words: *"the answers are not navigable once answered"* and *"the run surface should show any
 * questions asked and what was the options and the answers"*. A resolved interaction used to simply disappear,
 * so the entire record of a decision a person made mid-run lasted exactly as long as the frame it was on.
 */
describe("runRows: answered questions are kept, filed, and navigable", () => {
  it("attaches an agent question to the unit that raised it, directly beneath it", () => {
    const rows = runRows(
      run({
        units: [unit({ unitId: "unit-1", ordinal: 1, phase: "gather" })],
        resolved: [resolved()],
      }),
    )
    const unitIndex = rows.findIndex((row) => row.id === "unit-1")
    expect(rows[unitIndex + 1]).toMatchObject({ kind: "interaction", id: "req-1", glyph: "answered", indent: 1 })
    // The row says what was chosen: a mark nobody can decode is decoration.
    expect(rows[unitIndex + 1]?.label).toBe("Answered")
    expect(rows[unitIndex + 1]?.detail).toContain("MLA")
    expect(rows[unitIndex + 1]?.detail).toContain("Citations")
  })

  it("files a script question under the phase the run was in when it asked", () => {
    const rows = runRows(
      run({
        units: [unit({ unitId: "u1", phase: "plan", status: "ok", endedAt: 2_000 })],
        resolved: [resolved({ origin: "script", unitId: null, depth: 1, phase: "plan" })],
      }),
    )
    const phaseIndex = rows.findIndex((row) => row.id === "plan")
    const answerIndex = rows.findIndex((row) => row.kind === "interaction")
    const nextPhase = rows.findIndex((row) => row.id === "gather")
    // Inside the `plan` block, after its units — not stranded at the top or the bottom of the run.
    expect(answerIndex).toBeGreaterThan(phaseIndex)
    expect(answerIndex).toBeLessThan(nextPhase)
    expect(rows[answerIndex]?.indent).toBe(1)
  })

  it("keeps an answer whose phase the run no longer knows, rather than dropping it", () => {
    const rows = runRows(run({ units: [], resolved: [resolved({ origin: "script", unitId: null, phase: "gone" })] }))
    expect(rows.filter((row) => row.kind === "interaction")).toHaveLength(1)
  })

  it("says when nobody chose, rather than pretending an answer was given", () => {
    const rows = runRows(run({ units: [], resolved: [resolved({ unitId: null, phase: null, by: "automation", answers: [] })] }))
    const row = rows.find((candidate) => candidate.kind === "interaction")
    expect(row?.label).toBe("Automated")
    expect(row?.detail).toContain("answer not recorded")
  })

  it("keeps waiting questions pinned above everything, answered ones in place", () => {
    const rows = runRows(
      run({
        units: [unit({ unitId: "unit-1", phase: "gather" })],
        interactions: [interaction({ requestID: "req-2" })],
        resolved: [resolved()],
      }),
    )
    expect(rows[0]).toMatchObject({ kind: "interaction", id: "req-2", glyph: "question" })
    expect(rows.findIndex((row) => row.id === "req-1")).toBeGreaterThan(0)
  })

  it("opens an answered question with the same ⏎ that opens a waiting one", () => {
    const answered = run({ units: [], resolved: [resolved({ unitId: null, phase: null })] })
    const rows = runRows(answered)
    const index = rows.findIndex((row) => row.kind === "interaction")
    const opened = drive(initialRouteState("run-1"), Array(index).fill("down").concat("drill"), [answered])
    expect(opened.stack.at(-1)).toMatchObject({ kind: "question", requestID: "req-1" })
    expect(findResolved([answered], "run-1", "req-1")?.answers).toEqual([["MLA"]])
    expect(findInteraction([answered], "run-1", "req-1")).toBeNull()
  })

  it("summarises a multi-part answer as the phrase a row can show", () => {
    expect(answerSummary(resolved({ answers: [["MLA"], ["EU", "US"]] }))).toBe("MLA · EU, US")
    expect(answerSummary(resolved({ answers: [] }))).toBe("")
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

function questionForm(): PendingInteraction["questions"] {
  return [
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
  ]
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
    questions: questionForm(),
    raisedAt: 2_000,
    graceEndsAt: 302_000,
    ...overrides,
  }
}

function resolved(overrides: Partial<ResolvedInteraction> = {}): ResolvedInteraction {
  return {
    requestID: "req-1",
    kind: "question",
    origin: "agent",
    sessionID: "child-1",
    unitId: "unit-1",
    depth: 2,
    phase: "gather",
    questions: questionForm(),
    raisedAt: 2_000,
    answers: [["MLA"]],
    by: "human",
    resolvedAt: 5_000,
    ...overrides,
  }
}

/**
 * The `question` level — the answer pane as a member of the drill stack.
 *
 * Making the pane a level rather than a modal buys three things that are all asserted here: it is reached by
 * the same ⏎ that opens a unit, `esc` walks out of it the way it walks out of everything else, and — the one
 * that only a level can do — it survives the question being ANSWERED, as a record rather than a form.
 */
describe("route model: the answer pane as a level", () => {
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
      // A freshly opened question is at its first question with nothing collected and nothing ticked.
      index: 0,
      answers: [],
      chosen: [],
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

  it("drops the pane when the request leaves without leaving a record behind", () => {
    const opened = drive(initialRouteState("run-1"), ["drill"], [asking])
    expect(opened.stack).toHaveLength(3)
    // Nothing pending and nothing recorded: as far as this snapshot knows, the request never existed.
    const gone = normalizeRoute(opened, [run({ interactions: [] })])
    expect(gone.stack.map((level) => level.kind)).toEqual(["list", "run"])
  })

  it("keeps the level on the RECORD once the question is answered", () => {
    const opened = drive(initialRouteState("run-1"), ["drill"], [asking])
    const answered = normalizeRoute(opened, [run({ interactions: [], resolved: [resolved()] })])
    // Still three levels: the pane becomes a read-only record rather than evaporating. Answering NAVIGATES
    // (see `route.tsx`); it does not rely on being evicted from under the user.
    expect(answered.stack.map((level) => level.kind)).toEqual(["list", "run", "question"])
    expect(breadcrumb(answered, [run({ interactions: [], resolved: [resolved()] })])).toContain("question (answered)")
  })

  /**
   * The regression that a test should have caught the first time.
   *
   * `back` used to send `question.reject`, and `back` is bound to `escape,left,h` — so `esc`, `←` and `h`, the
   * three keys everyone reaches for to step out of a screen, silently handed a pending decision to automation.
   * A user hit exactly that. Navigation must never dispose of a question.
   */
  it("never turns navigation into a decision: `back` on the pane is not a control action", () => {
    const opened = drive(initialRouteState("run-1"), ["drill"], [asking])
    expect(selectedControl(opened, [asking], "back" as never)).toBeNull()
    // …and the level simply pops, leaving the question exactly where it was.
    const left = drive(opened, ["back"], [asking])
    expect(left.stack.map((level) => level.kind)).toEqual(["list", "run"])
    expect(asking.interactions).toHaveLength(1)
  })

  it("hands the question to automation on `x` — the deliberate key, not the way out", () => {
    const opened = drive(initialRouteState("run-1"), ["drill"], [asking])
    expect(selectedControl(opened, [asking], "stop")).toEqual({
      action: "question.reject",
      runId: "run-1",
      requestID: "req-1",
    })
  })

  it("offers nothing to hand back once the question has been answered", () => {
    const answered = run({ interactions: [], resolved: [resolved()] })
    const opened = openQuestion(initialRouteState(), "run-1", "req-1")
    expect(selectedControl(opened, [answered], "stop")).toBeNull()
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

/**
 * A question that accepts more than one answer.
 *
 * `multiple` arrived with Phase 4 — mirrored from the host's own `QuestionInfo`, carried by `ctx.ask`, declared
 * on `InteractionQuestion`, and read by nothing. A question asking for several answers therefore took exactly
 * one, silently, and the author had no way to tell. These are the assertions that make the field mean something.
 */
describe("route model: a question that accepts more than one answer", () => {
  function regions(overrides: Partial<PendingInteraction["questions"][number]> = {}) {
    return {
      header: "Regions",
      prompt: "Which regions should the report cover?",
      options: [
        { label: "EU", description: "European Union" },
        { label: "US", description: "United States" },
        { label: "APAC", description: "Asia-Pacific" },
      ],
      multiple: true,
      custom: false,
      ...overrides,
    }
  }
  const asking = run({ interactions: [interaction({ questions: [regions()] })] })

  it("ticks the highlighted option in, and the same key takes it back out", () => {
    const one = drive(initialRouteState("run-1"), ["drill", "toggle"], [asking])
    expect(one.stack.at(-1)).toMatchObject({ chosen: ["EU"] })

    const two = drive(one, ["down", "toggle"], [asking])
    expect(two.stack.at(-1)).toMatchObject({ chosen: ["EU", "US"] })

    // A set you cannot un-tick is a decision you cannot correct.
    expect(drive(two, ["toggle"], [asking]).stack.at(-1)).toMatchObject({ chosen: ["EU"] })
  })

  it("keeps the order the user built, not the order the options were offered", () => {
    const built = drive(
      initialRouteState("run-1"),
      ["drill", "down", "down", "toggle", "up", "up", "toggle"],
      [asking],
    )
    expect(built.stack.at(-1)).toMatchObject({ chosen: ["APAC", "EU"] })
  })

  it("names the question the key belongs to, and only that one", () => {
    const opened = drive(initialRouteState("run-1"), ["drill"], [asking])
    expect(multiSelectQuestion(opened, [asking])?.header).toBe("Regions")
    // Off the pane there is nothing to tick, whatever the question underneath says.
    expect(multiSelectQuestion(drive(opened, ["back"], [asking]), [asking])).toBeNull()
  })

  it("does nothing on a single-choice question, where ⏎ already answers with the cursor", () => {
    const single = run({ interactions: [interaction()] })
    const opened = drive(initialRouteState("run-1"), ["drill", "toggle"], [single])
    expect(opened.stack.at(-1)).toMatchObject({ chosen: [] })
    expect(multiSelectQuestion(opened, [single])).toBeNull()
  })

  it("does nothing on the custom row, where typing is the answer", () => {
    const withCustom = run({ interactions: [interaction({ questions: [regions({ custom: true })] })] })
    const onCustom = drive(initialRouteState("run-1"), ["drill", "down", "down", "down", "toggle"], [withCustom])
    // The custom row sits past the last option; it is a way in to the field, not a tick target.
    expect(onCustom.stack.at(-1)).toMatchObject({ selected: 3, chosen: [] })
  })

  it("does nothing on a question that has already been answered", () => {
    const settled = run({
      interactions: [],
      resolved: [resolved({ questions: [regions()], answers: [["EU", "US"]] })],
    })
    const opened = openQuestion(initialRouteState(), "run-1", "req-1")
    // Identity: a record has no set to build, and a key that appears to work and changes nothing is worse than
    // one that is not offered.
    expect(toggleChoice(opened, [settled])).toBe(opened)
  })

  it("clamps the cursor against the question ON SCREEN, not against the first one", () => {
    const mixed = run({
      interactions: [
        interaction({
          questions: [
            regions(),
            {
              header: "Depth",
              prompt: "How deep?",
              options: [{ label: "shallow", description: "" }],
              multiple: false,
              custom: false,
            },
          ],
        }),
      ],
    })
    const onSecond: RouteState = {
      filter: "all",
      stack: [
        { kind: "list", selected: 0 },
        { kind: "run", runId: "run-1", selected: 0 },
        {
          kind: "question",
          runId: "run-1",
          requestID: "req-1",
          selected: 2,
          custom: null,
          index: 1,
          answers: [["EU"]],
          chosen: [],
        },
      ],
    }
    // The second question offers one option. A cursor left on the third row of the FIRST question would be
    // sitting on nothing — which is what the row count did before it consulted the level's own index.
    expect(questionRowCount(mixed.interactions[0]!, 1)).toBe(1)
    expect(normalizeRoute(onSecond, [mixed]).stack.at(-1)).toMatchObject({ selected: 0, index: 1 })
    // …and the rows already collected survive normalization, because they are the answer being built.
    expect(normalizeRoute(onSecond, [mixed]).stack.at(-1)).toMatchObject({ answers: [["EU"]] })
  })
})

describe("moving between the questions of one form", () => {
  // A form used to go one way only: `⏎` answered question one and there was no route back to change it. The
  // native ask tool lets you move between questions, and a form you cannot revise is a form you have to get
  // right first time.
  const twoPart = (): PendingInteraction =>
    interaction({
      questions: [
        {
          header: "Depth",
          prompt: "How deep?",
          options: [
            { label: "quick", description: "" },
            { label: "thorough", description: "" },
          ],
          multiple: false,
          custom: false,
        },
        {
          header: "Sections",
          prompt: "Which sections?",
          options: [
            { label: "sources", description: "" },
            { label: "gaps", description: "" },
          ],
          multiple: true,
          custom: false,
        },
      ],
    })

  const onQuestionTwo = (form: PendingInteraction, runs: readonly RunSnapshot[]) => {
    const opened = openQuestion(initialRouteState(), "run-1", form.requestID)
    // Answer the first question the way the pane does, then step forward.
    const advanced = { ...opened, stack: [...opened.stack.slice(0, -1), { ...opened.stack.at(-1)!, index: 1, answers: [["thorough"]] }] } as RouteState
    return normalizeRoute(advanced, runs)
  }

  it("steps `back` to the previous question instead of leaving the pane", () => {
    const form = twoPart()
    const runs = [run({ interactions: [form] })]
    const second = onQuestionTwo(form, runs)
    expect(second.stack.at(-1)).toMatchObject({ kind: "question", index: 1 })

    const first = reduceRoute(second, "back", runs)
    // Still on the pane — `back` moved WITHIN the form.
    expect(first.stack.at(-1)).toMatchObject({ kind: "question", index: 0 })
    // …and what was said to question one is on the cursor, so revisiting is reading rather than re-deciding.
    expect(first.stack.at(-1)).toMatchObject({ selected: 1 })
  })

  it("leaves the pane only from the first question", () => {
    const form = twoPart()
    const runs = [run({ interactions: [form] })]
    const opened = openQuestion(initialRouteState(), "run-1", form.requestID)
    expect(opened.stack.at(-1)).toMatchObject({ kind: "question", index: 0 })

    const out = reduceRoute(opened, "back", runs)
    expect(out.stack.at(-1)?.kind).not.toBe("question")
  })
})

describe("moving between separate waiting questions", () => {
  // Several questions can wait at once — the badge has always counted them globally — and reaching the second
  // used to mean leaving the pane, walking back to the list, and drilling into a different run.
  const first = interaction({ requestID: "req-1" })
  const second = interaction({ requestID: "req-2", questions: [{ ...questionForm()[0]!, header: "Regions" }] })

  it("shows no tabs when only one question is waiting — a one-tab strip is furniture", () => {
    const runs = [run({ interactions: [first] })]
    const state = openQuestion(initialRouteState(), "run-1", "req-1")
    expect(questionTabs(state, runs)).toEqual([])
  })

  it("lists every waiting question, marking the one on screen", () => {
    const runs = [run({ interactions: [first, second] })]
    const state = openQuestion(initialRouteState(), "run-1", "req-1")
    const tabs = questionTabs(state, runs)
    expect(tabs.map((tab) => tab.label)).toEqual(["Citations", "Regions"])
    expect(tabs.map((tab) => tab.current)).toEqual([true, false])
    // One run, so the workflow name would distinguish nothing and is left off every tab.
    expect(tabs.every((tab) => tab.workflow === "")).toBe(true)
  })

  it("qualifies tabs with the workflow only when the waiting set spans runs", () => {
    const runs = [
      run({ runId: "run-1", workflow: "deep-research", interactions: [first] }),
      run({ runId: "run-2", workflow: "asks-complex", interactions: [second] }),
    ]
    const state = openQuestion(initialRouteState(), "run-1", "req-1")
    expect(questionTabs(state, runs).map((tab) => tab.workflow)).toEqual(["deep-research", "asks-complex"])
  })

  it("cycles to the next waiting question and wraps, across runs", () => {
    const runs = [
      run({ runId: "run-1", interactions: [first] }),
      run({ runId: "run-2", interactions: [second] }),
    ]
    const state = openQuestion(initialRouteState(), "run-1", "req-1")

    const next = cycleQuestion(state, runs)
    expect(next.stack.at(-1)).toMatchObject({ kind: "question", runId: "run-2", requestID: "req-2" })
    // The stack is REBUILT rather than having its top swapped: leaving run-1's level underneath would make
    // `esc` walk out through a run the question on screen has nothing to do with.
    expect(next.stack.some((level) => level.kind === "run" && level.runId === "run-1")).toBe(false)

    expect(cycleQuestion(next, runs).stack.at(-1)).toMatchObject({ requestID: "req-1" })
  })

  it("offers nothing to cycle when the level is reading back an answered record", () => {
    const runs = [run({ interactions: [first, second], resolved: [resolved({ requestID: "req-9" })] })]
    const state = openQuestion(initialRouteState(), "run-1", "req-9")
    expect(questionTabs(state, runs)).toEqual([])
    expect(cycleQuestion(state, runs)).toBe(state)
  })
})
