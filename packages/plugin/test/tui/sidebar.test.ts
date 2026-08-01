import { describe, expect, it } from "bun:test"
import type { RunSnapshot, UnitSnapshot } from "../../src/runs"
import { formatElapsed, registerSidebar, sidebarViewModel, toSidebarRunLine } from "../../src/tui/sidebar"
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
    currentPhase: "Review",
    units: [unit("ok", 1), unit("running", 2), unit("queued", 3), unit("failed", 4)],
    logs: [],
    errors: [],
    tokensSpent: 0,
    startedAt: 1_000,
    endedAt: null,
    ...overrides,
  }
}

describe("workflow sidebar view model", () => {
  it("formats elapsed time deterministically", () => {
    expect(formatElapsed(999)).toBe("0s")
    expect(formatElapsed(65_000)).toBe("1m05s")
    expect(formatElapsed(3_720_000)).toBe("1h02m")
  })

  it("renders workflow, phase, settled/total counts, and elapsed text", () => {
    expect(toSidebarRunLine(run(), 131_000)).toEqual({
      runId: "run-1",
      workflow: "research",
      phase: "Review",
      settled: 2,
      total: 4,
      elapsed: "2m10s",
      text: "research · Review · 2/4 units · 2m10s",
    })
  })

  it("returns only active runs and an empty state when none are active", () => {
    expect(sidebarViewModel([run({ status: "done" })], 2_000)).toEqual([])
    expect(sidebarViewModel([run(), run({ runId: "done", status: "done" })], 2_000).map((line) => line.runId)).toEqual(["run-1"])
  })

  it("registers only the sidebar_content slot", () => {
    const fake = createFakeTuiApi()
    expect(registerSidebar(fake.api, () => [run()])).toBe("slot-1")
    expect(fake.slots).toHaveLength(1)
    expect(Object.keys(fake.slots[0]?.slots ?? {})).toEqual(["sidebar_content"])
    expect(fake.routes).toEqual([])
    expect(fake.keymapLayers).toEqual([])
    expect(fake.attention).toEqual([])
  })
})
