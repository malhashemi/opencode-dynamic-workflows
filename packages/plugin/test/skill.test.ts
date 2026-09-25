import { afterAll, expect, test } from "bun:test"
import { mkdtemp, readFile, rm } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { SKILL_PATH, parseSkill } from "../src/host/skill"
import { loadWorkflow } from "../src/loader"
import { WORKFLOW_INLINE_DESCRIPTION, WORKFLOW_TOOL_DESCRIPTION } from "../src/host/description"

const cacheDir = await mkdtemp(path.join(os.tmpdir(), "wf-skill-"))
afterAll(() => rm(cacheDir, { recursive: true, force: true }))

test("the authoring skill parses, and the tool descriptions point to it", async () => {
  const skill = parseSkill(await readFile(SKILL_PATH, "utf8"))
  expect(skill.id).toBe("dynamic-workflows")
  expect(skill.content.startsWith("# Writing a Workflow")).toBe(true)
  expect(WORKFLOW_TOOL_DESCRIPTION).toContain("`dynamic-workflows` skill")
  expect(WORKFLOW_INLINE_DESCRIPTION).toContain("`dynamic-workflows` skill")
})

test("every complete module in the skill and the tool descriptions loads", async () => {
  const skill = await readFile(SKILL_PATH, "utf8")
  const blocks = [...skill.matchAll(/```ts\n([\s\S]*?)```/g)].map((m) => m[1]!)
  const modules = [...blocks, WORKFLOW_TOOL_DESCRIPTION.slice(WORKFLOW_TOOL_DESCRIPTION.indexOf("import {"))].filter(
    (block) => block.includes("export default defineWorkflow"),
  )
  expect(modules.length).toBeGreaterThanOrEqual(3)
  for (const source of modules) {
    const dedented = source.replace(/^ {2}/gm, "")
    const { config } = await loadWorkflow(dedented.slice(0, dedented.lastIndexOf("})") + 2), { cacheDir })
    expect(config.meta.name.length).toBeGreaterThan(0)
  }
})
