import { expect, test } from "bun:test"
import path from "node:path"

test("the package README (the npm page) matches the repository README", () => {
  const result = Bun.spawnSync(["bun", "run", path.join(import.meta.dir, "..", "script", "sync-readme.ts"), "--check"])
  expect(result.stderr.toString()).toBe("")
  expect(result.exitCode).toBe(0)
})
