import { describe, expect, test } from "bun:test"

import {
  LIBRARY_COLUMNS,
  UNIT_COLUMNS,
  fit,
  formatCost,
  layout,
  libraryCells,
  renderHeader,
  renderRow,
  runStatus,
  sidebarLines,
  stripText,
  truncate,
  unitCells,
  unitName,
  numberedLines,
  wrapLines,
} from "../../src/tui/format"
import { entry, run, unit } from "./fixtures"

describe("status", () => {
  test("glyph and word for every state; waiting overrides running", () => {
    expect(runStatus({ status: "running", waiting: false })).toEqual({ glyph: "●", word: "running", tone: "info" })
    expect(runStatus({ status: "running", waiting: true }).word).toBe("waiting")
    expect(runStatus({ status: "failed", waiting: true }).word).toBe("failed")
    expect(unitCells(unit({ status: "repairing" }), 0).status).toBe("↻ repairing")
    expect(unitCells(unit({ status: "replayed" }), 0)).toMatchObject({ status: "↺ replayed", tokens: "", cost: "" })
  })
})

describe("numbers", () => {
  test("cost is honest about small amounts", () => {
    expect(formatCost(0)).toBe("$0")
    expect(formatCost(0.0042)).toBe("$0.004")
    expect(formatCost(1.234)).toBe("$1.23")
  })

  test("unit name falls back to the prompt's first line", () => {
    expect(unitName(unit({ label: "scan" }))).toBe("scan")
    expect(unitName(unit({ prompt: "\n  Review the diff\nmore" }))).toBe("Review the diff")
  })
})

describe("layout", () => {
  test("80 columns keep identity, status, counts and elapsed; wide screens show everything", () => {
    const narrow = layout(LIBRARY_COLUMNS, 76).map((column) => column.id)
    expect(narrow).toEqual(expect.arrayContaining(["status", "workflow", "units", "elapsed"]))
    expect(narrow).not.toContain("phase")
    expect(layout(LIBRARY_COLUMNS, 160).map((column) => column.id)).toEqual(LIBRARY_COLUMNS.map((column) => column.id))
    const tiny = layout(LIBRARY_COLUMNS, 40).map((column) => column.id)
    expect(tiny).toEqual(["status", "workflow", "units"])
    expect(layout(UNIT_COLUMNS, 60).map((column) => column.id)).toEqual(
      expect.arrayContaining(["status", "name", "elapsed"]),
    )
  })

  test("rows fit the width exactly, numbers right-aligned", () => {
    const columns = layout(LIBRARY_COLUMNS, 100)
    const r = run({
      units: [unit({ status: "succeeded", endedAt: 2_000 }), unit({ unitId: "u2", ordinal: 1 })],
      currentPhase: "work",
    })
    const row = renderRow(columns, libraryCells(entry(r), 61_000))
    expect(row.length).toBe(100)
    expect(renderHeader(columns).length).toBe(100)
    expect(row).toContain("1/2")
    expect(row).toContain("1m00s")
    expect(row).toContain("phase 2/2")
  })

  test("truncate and fit", () => {
    expect(truncate("hello world", 5)).toBe("hell…")
    expect(truncate("a\n b", 10)).toBe("a b")
    expect(fit("7", 3, "right")).toBe("  7")
  })

  test("wrapLines breaks at words and keeps blank lines", () => {
    expect(wrapLines("alpha beta gamma\n\ndelta", 11)).toEqual(["alpha beta", "gamma", "", "delta"])
    expect(wrapLines("x".repeat(10), 4)).toEqual(["xxxx", "xxxx", "xx"])
  })
})

describe("strip and sidebar", () => {
  test("hidden with no live Run; one Run shows its detail; several collapse", () => {
    expect(stripText([entry(run({ status: "succeeded" }), false)], 0, 80)).toBe("")
    const one = stripText([{ ...entry(run({ currentPhase: "plan", units: [unit()] })), waiting: true }], 11_000, 120)
    expect(one).toContain("⟡ review")
    expect(one).toContain("phase 1/2")
    expect(one).toContain("0/1 units")
    expect(one).toContain("10s")
    expect(one).toContain("waiting")
    const many = stripText([entry(run()), entry(run({ runId: "b" }))], 0, 80)
    expect(many).toContain("2 workflows running")
  })

  test("the strip drops low-priority parts before it truncates identity", () => {
    const text = stripText([{ ...entry(run({ currentPhase: "plan" })), waiting: true }], 11_000, 40)
    expect(text.length).toBeLessThanOrEqual(40)
    expect(text).toContain("⟡ review")
    expect(text).toContain("units")
  })

  test("sidebar lines", () => {
    const [first, second] = sidebarLines(entry(run({ currentPhase: "work" })), 5_000, 30)
    expect(first).toBe("● review")
    expect(second).toContain("phase 2/2")
  })
})

describe("numberedLines", () => {
  test("numbers every line, aligns the numbers, and keeps indentation", () => {
    const source = Array.from({ length: 10 }, (_, index) => (index === 1 ? "  indented" : `line ${index + 1}`)).join(
      "\n",
    )
    const out = numberedLines(source, 40)
    expect(out).toHaveLength(10)
    expect(out[0]).toBe(" 1 │ line 1")
    expect(out[1]).toBe(" 2 │   indented")
    expect(out[9]).toBe("10 │ line 10")
  })

  test("cuts a long line under a blank gutter and loses no text", () => {
    const out = numberedLines(`const x = ${"a".repeat(30)}\nend`, 20)
    expect(out.every((row) => row.length <= 20)).toBe(true)
    expect(out.at(-1)).toBe("2 │ end")
    expect(out.slice(1, -1).every((row) => row.startsWith("  │ "))).toBe(true)
    expect(
      out
        .slice(0, -1)
        .map((row) => row.slice(4))
        .join(""),
    ).toBe(`const x = ${"a".repeat(30)}`)
  })

  test("keeps blank lines", () => {
    expect(numberedLines("a\n\nb", 20)).toEqual(["1 │ a", "2 │ ", "3 │ b"])
  })
})
