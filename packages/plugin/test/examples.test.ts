import { afterAll, expect, test } from "bun:test"
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises"
import os from "node:os"
import path from "node:path"

import { loadWorkflow } from "../src/loader"

const cacheDir = await mkdtemp(path.join(os.tmpdir(), "wf-examples-"))
afterAll(() => rm(cacheDir, { recursive: true, force: true }))
const dir = path.join(import.meta.dir, "..", "docs", "examples")

test("every example Workflow loads and declares its metadata", async () => {
  const files = (await readdir(dir)).filter((file) => file.endsWith(".ts"))
  expect(files.length).toBeGreaterThanOrEqual(3)
  for (const file of files) {
    const source = await readFile(path.join(dir, file), "utf8")
    const { config } = await loadWorkflow(source, { cacheDir, sourcePath: path.join(dir, file) })
    expect(config.meta.name).toBe(file.replace(/\.ts$/, ""))
    expect(config.meta.description.length).toBeGreaterThan(0)
  }
})
