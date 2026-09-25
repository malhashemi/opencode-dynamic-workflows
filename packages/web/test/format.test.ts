import { describe, expect, test } from "bun:test"
import { formatCost, formatCount, formatDuration, prettyValue, shortLocation, tokenizeJson } from "../src/format"
import { describeFields, parseArgs, templateFor, validateJson } from "../src/schema"

describe("format", () => {
  test("durations", () => {
    expect(formatDuration(450)).toBe("450ms")
    expect(formatDuration(3200)).toBe("3.2s")
    expect(formatDuration(42_000)).toBe("42s")
    expect(formatDuration(184_000)).toBe("3m 04s")
    expect(formatDuration(2 * 3_600_000 + 5 * 60_000)).toBe("2h 05m")
  })

  test("counts and cost", () => {
    expect(formatCount(812)).toBe("812")
    expect(formatCount(1234)).toBe("1.2k")
    expect(formatCount(56_700)).toBe("57k")
    expect(formatCount(1_250_000)).toBe("1.3M")
    expect(formatCost(0)).toBe("$0")
    expect(formatCost(0.00123)).toBe("$0.0012")
    expect(formatCost(1.5)).toBe("$1.50")
  })

  test("pretty values and JSON tokens", () => {
    expect(prettyValue('{"a":1}')).toEqual({ text: '{\n  "a": 1\n}', json: true })
    expect(prettyValue("plain")).toEqual({ text: "plain", json: false })
    const tokens = tokenizeJson('{\n  "a": "b",\n  "n": -1.5,\n  "t": null\n}')
    expect(tokens.filter((t) => t.kind === "key").map((t) => t.text)).toEqual(['"a"', '"n"', '"t"'])
    expect(tokens.find((t) => t.kind === "string")!.text).toBe('"b"')
    expect(tokens.find((t) => t.kind === "number")!.text).toBe("-1.5")
    expect(tokens.map((t) => t.text).join("")).toBe('{\n  "a": "b",\n  "n": -1.5,\n  "t": null\n}')
  })

  test("short locations", () => {
    expect(shortLocation("/Users/me/dev/project")).toBe("…/dev/project")
    expect(shortLocation("/tmp")).toBe("/tmp")
  })
})

describe("args schema", () => {
  const schema = {
    $schema: "https://json-schema.org/draft/2020-12/schema",
    type: "object",
    properties: {
      topic: { type: "string", minLength: 1, description: "what to research" },
      count: { type: "integer", minimum: 1, maximum: 5 },
      mode: { type: "string", enum: ["fast", "deep"] },
      tags: { type: "array", items: { type: "string" } },
    },
    required: ["topic", "count"],
    additionalProperties: false,
  }

  test("template has the required fields with typed placeholders", () => {
    expect(templateFor(schema)).toEqual({ topic: "", count: 1 })
  })

  test("validation reports paths", () => {
    expect(validateJson(schema, { topic: "bees", count: 2 })).toEqual([])
    expect(validateJson(schema, { topic: "", count: 9, mode: "slow", tags: [1], extra: true })).toEqual([
      "args.topic: at least 1 characters",
      "args.count: must be ≤ 5",
      "args.mode: must be one of \"fast\", \"deep\"",
      "args.tags[0]: expected string, got integer",
      "args.extra: not allowed",
    ])
    expect(validateJson(schema, { count: 1.5 })).toEqual(["args.topic: required", "args.count: expected integer, got number"])
  })

  test("parseArgs: JSON errors, empty input, and schema checks", () => {
    expect(parseArgs("", null)).toEqual({ ok: true, value: undefined })
    expect(parseArgs("", schema).ok).toBe(false)
    expect(parseArgs("{", schema).ok).toBe(false)
    expect(parseArgs('{"topic":"x","count":1}', schema)).toEqual({ ok: true, value: { topic: "x", count: 1 } })
  })

  test("field summary", () => {
    expect(describeFields(schema).map((f) => `${f.name}:${f.type}:${f.required}`)).toEqual([
      "topic:string:true",
      "count:integer:true",
      'mode:"fast" | "deep":false',
      "tags:string[]:false",
    ])
  })
})
