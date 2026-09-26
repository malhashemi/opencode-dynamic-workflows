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
