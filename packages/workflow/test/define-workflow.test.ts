import { describe, expect, it } from "bun:test"
import { defineWorkflow, z } from "../src/index"

describe("defineWorkflow", () => {
  it("returns the config unchanged when meta + run are valid", () => {
    const run = async () => "ok"
    const config = defineWorkflow({ meta: { name: "demo", description: "a demo" }, run })
    expect(config.meta.name).toBe("demo")
    expect(config.run).toBe(run)
  })

  it("preserves optional meta fields", () => {
    const config = defineWorkflow({
      meta: {
        name: "demo",
        description: "a demo",
        whenToUse: "when demoing",
        phases: [{ title: "Scan", detail: "look around" }],
        concurrency: 3,
      },
      run: async () => undefined,
    })
    expect(config.meta.phases).toEqual([{ title: "Scan", detail: "look around" }])
    expect(config.meta.concurrency).toBe(3)
  })

  it("throws when meta.name is missing or empty", () => {
    expect(() => defineWorkflow({ meta: { name: "", description: "d" }, run: async () => {} })).toThrow(
      /meta\.name/,
    )
    // @ts-expect-error — name omitted on purpose
    expect(() => defineWorkflow({ meta: { description: "d" }, run: async () => {} })).toThrow(/meta\.name/)
  })

  it("rejects a meta.name containing reserved chars (':', '/', '\\', whitespace)", () => {
    for (const bad of ["a:b", "a/b", "a\\b", "a b", "has\ttab"]) {
      expect(() => defineWorkflow({ meta: { name: bad, description: "d" }, run: async () => {} })).toThrow(/meta\.name/)
    }
    // a clean name (incl. hyphen/underscore/dot) is fine — these are how registry keys + commands are formed
    for (const ok of ["deep-research", "rate_pr", "v1.2", "greet"]) {
      expect(defineWorkflow({ meta: { name: ok, description: "d" }, run: async () => {} }).meta.name).toBe(ok)
    }
  })

  it("throws when meta.description is missing", () => {
    // @ts-expect-error — description omitted on purpose
    expect(() => defineWorkflow({ meta: { name: "demo" }, run: async () => {} })).toThrow(/description/)
  })

  it("throws when run is not a function", () => {
    // @ts-expect-error — run wrong type on purpose
    expect(() => defineWorkflow({ meta: { name: "demo", description: "d" }, run: 42 })).toThrow(/run/)
  })

  it("re-exports a working zod as z", () => {
    const schema = z.object({ a: z.string() })
    expect(schema.parse({ a: "x" })).toEqual({ a: "x" })
  })
})
