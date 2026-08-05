import { describe, expect, it } from "bun:test"
import type { RunSnapshot, UnitSnapshot } from "../../src/runs"
import {
  formatElapsed,
  phasePosition,
  registerSidebar,
  sidebarViewModel,
  toSidebarRunRow,
} from "../../src/tui/sidebar"
import { createFakeTuiApi } from "./fake-api"

function unit(status: UnitSnapshot["status"], ordinal: number): UnitSnapshot {
  return {
    unitId: `unit-${ordinal}`,
    ordinal,
    label: null,
    subagent: "general",
    phase: "Review",
    status,
    sessionID: status === "ok" ? `child-${ordinal}` : null,
    prompt: "work",
    startedAt: status === "queued" ? null : 1_000,
    endedAt: status === "ok" || status === "failed" ? 2_000 : null,
  }
}

function run(overrides: Partial<RunSnapshot> = {}): RunSnapshot {
  return {
    runId: "run-1",
    workflow: "research",
    provenance: "durable",
    parentSessionID: "parent",
    status: "running",
    phases: ["Review"],
    phasesDeclared: true,
    currentPhase: "Review",
    units: [unit("ok", 1), unit("running", 2), unit("queued", 3), unit("failed", 4)],
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

/** A run carrying Phase 4's `interactions` field before that field exists on `RunSnapshot`. */
function withInteractions(base: RunSnapshot, count: number): RunSnapshot {
  return {
    ...base,
    interactions: Array.from({ length: count }, (_x, i) => ({
      requestID: `q-${i}`,
      kind: "question" as const,
      origin: "agent" as const,
      sessionID: "ses_child",
      unitId: null,
      depth: 3,
      phase: null,
      questions: [{ header: "Pick", prompt: "Which?", options: [], multiple: false, custom: false }],
      // Ascending, so "oldest waiting" is `q-0` — the request the badge deep-links to.
      raisedAt: 1_000 + i,
      graceEndsAt: null,
    })),
  }
}

describe("workflow sidebar view model", () => {
  it("formats elapsed time deterministically", () => {
    expect(formatElapsed(999)).toBe("0s")
    expect(formatElapsed(65_000)).toBe("1m05s")
    expect(formatElapsed(3_720_000)).toBe("1h02m")
  })

  it("renders a live run as two lines: name + counts/elapsed, then phase position + title", () => {
    expect(toSidebarRunRow(run(), 131_000)).toEqual({
      runId: "run-1",
      workflow: "research",
      status: "running",
      counts: "2/4",
      elapsed: "2m10s",
      detail: "phase 1/1 · Review",
    })
  })

  it("positions the current phase among all observed phases", () => {
    expect(phasePosition(run({ phases: ["Plan", "Review", "Ship"], currentPhase: "Review" }))).toBe("phase 2/3")
    // An undeclared `phase("x")` is still appended to `run.phases` by the store, so it still gets a position.
    expect(phasePosition(run({ phases: ["Ad hoc"], currentPhase: "Ad hoc" }))).toBe("phase 1/1")
  })

  it("falls back to `starting` with no position before the run declares a phase", () => {
    const row = toSidebarRunRow(run({ phases: [], currentPhase: null, units: [] }), 4_000)
    expect(row.detail).toBe("starting")
    expect(row.counts).toBe("0/0")
    expect(row.elapsed).toBe("3s")
  })

  it("collapses a settled run to a single line — its outcome is the news, not its phase", () => {
    const done = toSidebarRunRow(run({ status: "done", endedAt: 131_000 }), 999_000)
    expect(done.detail).toBeNull()
    expect(done.status).toBe("done")
    // Elapsed freezes at the end, rather than counting on past completion.
    expect(done.elapsed).toBe("2m10s")

    expect(toSidebarRunRow(run({ status: "aborted", endedAt: 2_000 })).detail).toBeNull()
  })

  it("keeps a second line for a failure, because `it broke` without `how much` sends the user hunting", () => {
    const errors = [
      { subagent: "general", error: "boom" },
      { subagent: "general", error: "bang" },
    ] as RunSnapshot["errors"]
    expect(toSidebarRunRow(run({ status: "failed", errors, endedAt: 2_000 })).detail).toBe("2 units failed")
    expect(toSidebarRunRow(run({ status: "failed", errors: errors.slice(0, 1), endedAt: 2_000 })).detail).toBe(
      "1 unit failed",
    )
    // A run can fail without any unit failing — the script itself threw.
    expect(toSidebarRunRow(run({ status: "failed", errors: [], endedAt: 2_000 })).detail).toBe("failed")
  })

  it("keeps settled runs in the strip, live first, most recently ended next", () => {
    // The old model dropped a settled run immediately, so a three-second workflow never showed its outcome.
    const view = sidebarViewModel(
      [
        run({ runId: "newer-live", startedAt: 5_000 }),
        run({ runId: "ended-first", status: "done", endedAt: 6_000 }),
        run({ runId: "older-live", startedAt: 1_000 }),
        run({ runId: "ended-last", status: "failed", endedAt: 8_000 }),
      ],
      9_000,
    )
    expect(view.rows.map((row) => row.runId)).toEqual(["older-live", "newer-live", "ended-last", "ended-first"])
  })

  it("shows nothing at all only when there are no runs whatsoever", () => {
    expect(sidebarViewModel([], 2_000)).toEqual({ rows: [], pendingQuestions: 0, oldestPending: null })
    expect(sidebarViewModel([run({ status: "done", endedAt: 2_000 })], 2_000).rows).toHaveLength(1)
  })

  it("keeps the question badge at zero until a run reports pending interactions", () => {
    expect(sidebarViewModel([run()], 2_000).pendingQuestions).toBe(0)
    expect(sidebarViewModel([withInteractions(run(), 2)], 2_000).pendingQuestions).toBe(2)
    // A settled run's questions never reach the badge — the sidebar is a "what's live" strip.
    expect(sidebarViewModel([withInteractions(run({ status: "done" }), 3)], 2_000).pendingQuestions).toBe(0)
  })

  it("registers only the sidebar_content slot", () => {
    const fake = createFakeTuiApi()
    expect(registerSidebar(fake.api, () => [run()])).toBe("slot-1")
    expect(fake.slots).toHaveLength(1)
    expect(Object.keys(fake.slots[0]?.slots ?? {})).toEqual(["sidebar_content"])
    expect(fake.slots[0]?.order).toBe(350) // between built-in LSP (300) and todo (400)
    expect(fake.routes).toEqual([])
    expect(fake.keymapLayers).toEqual([])
    expect(fake.attention).toEqual([])
  })
})
