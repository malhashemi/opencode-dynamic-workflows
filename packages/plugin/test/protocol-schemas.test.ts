import { expect, test } from "bun:test"
import path from "node:path"

test("the published protocol JSON Schemas match the zod source", () => {
  const result = Bun.spawnSync([
    "bun",
    "run",
    path.join(import.meta.dir, "..", "script", "protocol-schemas.ts"),
    "--check",
  ])
  expect(result.stderr.toString()).toBe("")
  expect(result.exitCode).toBe(0)
})

test("the OpenAPI document is self-consistent: every $ref resolves and operation ids are unique", async () => {
  const { openApiDocument } = await import("../src/protocol/openapi")
  const doc = openApiDocument() as {
    paths: Record<string, Record<string, { operationId: string }>>
    components: { schemas: Record<string, unknown> }
  }
  const refs = [...JSON.stringify(doc).matchAll(/"\$ref":"#\/components\/schemas\/([^"]+)"/g)].map((m) => m[1]!)
  expect(refs.length).toBeGreaterThan(10)
  for (const name of refs) expect(doc.components.schemas[name]).toBeDefined()
  const ids = Object.values(doc.paths).flatMap((methods) => Object.values(methods).map((op) => op.operationId))
  expect(new Set(ids).size).toBe(ids.length)
})
