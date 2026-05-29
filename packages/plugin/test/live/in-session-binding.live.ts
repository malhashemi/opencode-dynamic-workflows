/**
 * LIVE — per-workflow command injection + the in-session freeze, against a REAL opencode server.
 *
 * NOT a `*.test.ts`: boots a real `opencode serve` (spawned by createOpencode, inheriting cwd). Run by hand:
 *
 *     bun run packages/plugin/test/live/in-session-binding.live.ts
 *
 * What it confirms (no model needed — pure command-registry assertions):
 *  - The REAL plugin, loaded by path, discovers a temp project's durable Workflows IN ITS config hook
 *    (buildRegistry → import each module) and injects one `/<key>` command each + the live `/workflow`
 *    fallback — visible in `client.command.list()`. This is the first exercise of buildRegistry running
 *    INSIDE the config hook in real opencode (the earlier probe ran in a workflow-less dir).
 *  - Nested key `research:deep` maps to the `/research/deep` command (opencode's nested convention).
 *  - The FREEZE: a workflow file written AFTER boot does NOT get a `/command` (the command registry is built
 *    once per process) — it stays reachable by name via the `workflow` tool + the live `/workflow` fallback.
 *
 * Exit 0 iff the per-workflow commands + fallback registered and the freeze held.
 */
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { createOpencode } from "@opencode-ai/sdk"

const wf = (name: string) =>
  `import { defineWorkflow } from "@opencode-ai/workflow"\n` +
  `export default defineWorkflow({ meta: { name: ${JSON.stringify(name)}, description: "live ${name}" }, async run() { return "ok" } })\n`

async function writeWorkflow(project: string, rel: string, name: string): Promise<void> {
  const abs = path.join(project, ".opencode", "workflows", rel)
  await mkdir(path.dirname(abs), { recursive: true })
  await writeFile(abs, wf(name), "utf8")
}

async function listCommandNames(client: unknown): Promise<string[]> {
  const res = await (client as { command: { list: () => Promise<{ data?: unknown }> } }).command.list()
  const data = (res?.data ?? res) as unknown
  const arr = Array.isArray(data) ? data : Object.entries((data as Record<string, unknown>) ?? {}).map(([name, v]) => ({ name, ...(v as object) }))
  return (arr as { name: string }[]).map((c) => c.name)
}

async function main() {
  const pluginPath = path.resolve(import.meta.dir, "../../src/index.ts")
  const project = await mkdtemp(path.join(os.tmpdir(), "wf-live-proj-"))
  await writeWorkflow(project, "greet.ts", "greet") // → /greet
  await writeWorkflow(project, "research/deep.ts", "deep") // key research:deep → /research/deep

  const origCwd = process.cwd()
  process.chdir(project) // the spawned `opencode serve` inherits cwd → project dir = this temp project
  const port = 40000 + Math.floor((Date.now() % 20000))
  console.log(`• booting opencode in ${project}\n  plugin: ${pluginPath}`)
  const { client, server } = await createOpencode({
    port,
    config: { logLevel: "ERROR", plugin: [pluginPath] },
    timeout: 30000,
  })

  let ok = true
  const check = (cond: boolean, label: string) => {
    console.log(`  ${cond ? "✓" : "✗"} ${label}`)
    if (!cond) ok = false
  }

  try {
    const names = await listCommandNames(client)
    console.log(`  command.list() → ${names.length} commands`)
    check(names.includes("workflow"), "live /workflow fallback registered")
    check(names.includes("greet"), "top-level workflow → /greet")
    check(names.includes("research/deep"), "nested key research:deep → /research/deep (opencode '/' convention)")
    check(!names.includes("research:deep"), "the ':'-key is NOT the command name")

    // FREEZE: write a NEW workflow after boot; its command must NOT appear (registry frozen per process).
    await writeWorkflow(project, "added-late.ts", "added-late")
    const after = await listCommandNames(client)
    check(!after.includes("added-late"), "freeze: a workflow added after boot gets NO /command until reload")

    console.log(ok ? "\n✓ PASS: per-workflow command injection + freeze confirmed live." : "\n✗ FAIL")
    if (!ok) process.exitCode = 1
  } finally {
    await server.close()
    process.chdir(origCwd)
    await rm(project, { recursive: true, force: true })
  }
}

main().catch((e) => {
  console.error("\nlive test threw:")
  console.error(e)
  process.exitCode = 1
})
