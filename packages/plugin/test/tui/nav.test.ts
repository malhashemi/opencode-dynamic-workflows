import { describe, expect, test } from "bun:test"
import { current, cursor, cycleFilter, filterEntries, initialNav, moveCursor, pop, push, setCursor, visibleWindow } from "../../src/tui/nav"
import { entry, run } from "./fixtures"

describe("navigation", () => {
  test("library → run → unit and back; the root stays", () => {
    let nav = initialNav()
    nav = push(nav, { kind: "run", runId: "r" })
    nav = push(nav, { kind: "unit", runId: "r", unitId: "u" })
    expect(push(nav, { kind: "unit", runId: "r", unitId: "u" })).toBe(nav)
    expect(current(nav)).toEqual({ kind: "unit", runId: "r", unitId: "u" })
    nav = pop(nav)!
    nav = pop(nav)!
    expect(current(nav).kind).toBe("library")
    expect(pop(nav)).toBeNull()
  })

  test("deep links start in a Run, with or without the library underneath", () => {
    expect(initialNav({ runId: "r", unitId: "u" }).stack.map((view) => view.kind)).toEqual(["library", "run", "unit"])
    expect(initialNav({ runId: "r", root: "run" }).stack.map((view) => view.kind)).toEqual(["run"])
  })

  test("cursors are per view and clamp to the list", () => {
    let nav = initialNav()
    nav = moveCursor(nav, 5, 3)
    expect(cursor(nav, 3)).toBe(2)
    expect(cursor(nav, 1)).toBe(0)
    nav = push(nav, { kind: "run", runId: "r" })
    expect(cursor(nav, 10)).toBe(0)
    nav = setCursor(nav, -4, 10)
    expect(cursor(nav, 10)).toBe(0)
  })

  test("filters cycle and select Runs", () => {
    const entries = [entry(run({ runId: "live" })), { ...entry(run({ runId: "wait" })), waiting: true }, entry(run({ runId: "bad", status: "failed" }), false)]
    let nav = initialNav()
    nav = cycleFilter(nav)
    expect(nav.filter).toBe("live")
    expect(filterEntries(entries, "live").map((e) => e.runId)).toEqual(["live", "wait"])
    expect(filterEntries(entries, "waiting").map((e) => e.runId)).toEqual(["wait"])
    expect(filterEntries(entries, "failed").map((e) => e.runId)).toEqual(["bad"])
  })

  test("the visible window follows the cursor", () => {
    expect(visibleWindow(5, 4, 10)).toEqual({ start: 0, end: 5 })
    expect(visibleWindow(100, 50, 10)).toEqual({ start: 45, end: 55 })
    expect(visibleWindow(100, 99, 10)).toEqual({ start: 90, end: 100 })
  })
})
