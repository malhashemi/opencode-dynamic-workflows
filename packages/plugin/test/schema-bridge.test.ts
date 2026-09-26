/**
 * The Schema-bridge in isolation — NO live opencode, NO git (the structured-output AC). It is the only piece
 * of the structured path that is pure (zod ⇄ JSON Schema), so it carries the bulk of the unit coverage:
 * round-tripping the worked-example schemas, parsing a valid payload to the typed object, and rejecting an
 * invalid (or merely zod-refinement-invalid) payload with a recorded error.
 */
import { describe, expect, it } from "bun:test"

import { DEFAULT_RETRIES, parseStructured, toJsonSchema, fromJsonSchema } from "../src/schema-bridge"
import { z } from "../src/workflow"

describe("toJsonSchema", () => {
  it("converts a worked-example object schema to a draft-7 JSON Schema (no $schema wrapper)", () => {
    const Finding = z.object({ title: z.string(), score: z.number(), tags: z.array(z.string()) })
    const js = toJsonSchema(Finding)

    expect(js.$schema).toBeUndefined() // stripped — core strips it too, and the tool input wants a clean object
    expect(js.type).toBe("object")
    expect(js.properties).toMatchObject({
      title: { type: "string" },
      score: { type: "number" },
      tags: { type: "array", items: { type: "string" } },
    })
    expect(js.required).toEqual(["title", "score", "tags"])
  })

  it("round-trips an enum + optional field", () => {
    const Triage = z.object({ severity: z.enum(["low", "high"]), note: z.string().optional() })
    const js = toJsonSchema(Triage)
    expect((js.properties as Record<string, unknown>).severity).toMatchObject({ enum: ["low", "high"] })
    expect(js.required).toEqual(["severity"]) // optional field is not required
  })

  it("produces a plain JSON-serialisable object (it must survive the wire to opencode)", () => {
    const js = toJsonSchema(z.object({ a: z.string() }))
    expect(() => JSON.stringify(js)).not.toThrow()
    expect(JSON.parse(JSON.stringify(js))).toEqual(js)
  })

  it("throws a clear author-facing error when given a non-zod value", () => {
    // Author misuse (not a Unit failure): surface it loudly rather than sending garbage to the model loop.
    expect(() => toJsonSchema({ not: "a schema" } as unknown as z.ZodType)).toThrow()
  })
})

describe("parseStructured", () => {
  it("parses a valid payload to the typed object", () => {
    const Finding = z.object({ title: z.string(), score: z.number() })
    const r = parseStructured(Finding, { title: "x", score: 3 })
    expect(r.ok).toBe(true)
    if (r.ok) {
      const _typed: { title: string; score: number } = r.value // compile-time: typed as the schema's output
      expect(_typed).toEqual({ title: "x", score: 3 })
    }
  })

  it("applies zod transforms / defaults the JSON Schema alone could not", () => {
    const WithDefault = z.object({ n: z.number(), kind: z.string().default("generic") })
    const r = parseStructured(WithDefault, { n: 1 })
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.value).toEqual({ n: 1, kind: "generic" })
  })

  it("rejects a structurally-invalid payload with a recorded error string", () => {
    const Finding = z.object({ title: z.string(), score: z.number() })
    const r = parseStructured(Finding, { title: "x", score: "not-a-number" })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(typeof r.error).toBe("string")
  })

  it("rejects a payload that is JSON-Schema-valid but fails a zod refinement", () => {
    // The AI SDK validates against JSON Schema; refinements live only in zod, so this is exactly what the
    // re-parse exists to catch. `{ n: -1 }` is a valid number per JSON Schema but fails the refinement.
    const Positive = z.object({ n: z.number() }).refine((o) => o.n > 0, "n must be positive")
    const r = parseStructured(Positive, { n: -1 })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error).toMatch(/positive/i)
  })
})

describe("DEFAULT_RETRIES", () => {
  it("matches opencode's format retryCount default (2)", () => {
    expect(DEFAULT_RETRIES).toBe(2)
  })
})

describe("audit round 4 — JSON Schema conversion matches JSON Schema", () => {
  it("a required key without a properties entry must be present", () => {
    const s = fromJsonSchema({ type: "object", required: ["id"], properties: {} })
    expect(s.safeParse({}).success).toBe(false)
    expect(s.safeParse({ id: 1 }).success).toBe(true)
  })
  it("type still applies next to enum", () => {
    const s = fromJsonSchema({ type: "string", enum: ["ok", null] })
    expect(s.safeParse("ok").success).toBe(true)
    expect(s.safeParse(null).success).toBe(false)
  })
  it("boolean items: false accepts only an empty array, true anything", () => {
    expect(fromJsonSchema({ type: "array", items: false }).safeParse([1]).success).toBe(false)
    expect(fromJsonSchema({ type: "array", items: false }).safeParse([]).success).toBe(true)
    expect(
      fromJsonSchema({ type: "object", properties: { a: { type: "array", items: true } } }).safeParse({ a: [1, "x"] })
        .success,
    ).toBe(true)
  })
})
