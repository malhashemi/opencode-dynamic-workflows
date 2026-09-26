/**
 * The composed acceptance probe (plan P5): the package as users install it.
 *
 * `bun pm pack` (runs `prepack` → the build) → the packed files in a throwaway git repo → a clean project that
 * configures `git+file://…#<sha>` → OpenCode installs it like any git plugin. Then: server, RPC, TUI entry,
 * web app, a durable Workflow with a typed Unit, a capability, a headless ask, and the tool path.
 *
 *     bun test ./packages/plugin/test/live/acceptance.live.ts --timeout 600000
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { existsSync } from "node:fs"
import { mkdir, mkdtemp, readdir, realpath, rm } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { drive, PLUGIN_PATH, startLive, toolOutput, until, type LiveServer } from "./harness"

const ACCEPT = `import { defineWorkflow, z } from "@malhashemi/opencode-dynamic-workflows/workflow"
export default defineWorkflow({
  meta: { name: "accept", description: "acceptance: typed Unit, capability, headless ask", args: z.object({ n: z.number().int() }) },
  async run({ agent, ask, $, args, phase }) {
    phase("ask")
    const answers = await ask({ header: "Mode", prompt: "Which mode?", options: [{ label: "A", description: "" }, { label: "B", description: "" }] }, { fallback: [["B"]] })
    phase("work")
    const Sum = z.object({ total: z.number() })
    const sum = await agent(\`Compute \${args.n} + 1 and submit it as total.\`, { schema: Sum, label: "sum" })
    const echo = await $\`printf %s \${"ok"}\`
    return { mode: answers[0]?.[0], total: sum?.total ?? null, shell: echo.stdout }
  },
})
`

let server: LiveServer
let scratch: string

beforeAll(async () => {
  scratch = await mkdtemp(path.join(await realpath(os.tmpdir()), "opencode", "wf-accept-"))
  // The published manifest has no build scripts (a git install would try to "prepare" it), so build first.
  const build = Bun.spawnSync(["bun", "run", "build"], { cwd: path.join(PLUGIN_PATH, "..", "..") })
  if (build.exitCode !== 0) throw new Error(`bun run build failed:\n${build.stderr.toString()}`)
  const pack = Bun.spawnSync(["bun", "pm", "pack", "--destination", scratch], { cwd: PLUGIN_PATH })
  if (pack.exitCode !== 0) throw new Error(`bun pm pack failed:\n${pack.stderr.toString()}${pack.stdout.toString()}`)
  const tarball = (await readdir(scratch)).find((file) => file.endsWith(".tgz"))!
  const repo = path.join(scratch, "repo")
  await mkdir(repo)
  await Bun.$`tar -xzf ${path.join(scratch, tarball)} -C ${repo} --strip-components 1`.quiet()
  await Bun.$`git init -q && git add -A && git -c user.email=a@b -c user.name=probe commit -qm pack`.cwd(repo).quiet()
  const sha = (await Bun.$`git rev-parse HEAD`.cwd(repo).text()).trim()
  server = await startLive({ plugin: `git+file://${repo}#${sha}`, files: { ".opencode/workflows/accept.ts": ACCEPT } })
}, 300_000)

afterAll(async () => {
  await server?.stop()
  if (scratch) await rm(scratch, { recursive: true, force: true })
})

describe("acceptance: installed package", () => {
  test("server and RPC answer; the registry sees the project Workflow", async () => {
    const info = (await server.workflow.info({})) as any
    expect(info.protocol).toBe(1)
    const listing = (await server.workflow.listWorkflows({})) as any
    expect(listing.workflows.map((w: any) => w.key)).toContain("accept")
    expect(listing.failures).toEqual([])
  })

  test("a durable Run: headless ask fallback, typed Unit, capability", async () => {
    const { runId } = (await server.workflow.startRun({ name: "accept", args: { n: 41 } })) as any
    const run = await until(async () => {
      const { run: current } = (await server.workflow.getRun({ runId })) as any
      return current.status !== "running" && current.status !== "queued" ? current : undefined
    }, 180_000, 500)
    expect(run.status).toBe("succeeded")
    const { result } = (await server.workflow.getResult({ runId })) as any
    expect(result).toEqual({ mode: "B", total: 42, shell: "ok" })
  }, 240_000)

  test("the model runs it through the tool and gets a working web link", async () => {
    const { messages } = await drive(server, 'Call the workflow tool with {"name":"accept","args":{"n":1}}. Then reply with its summary line only.')
    const output = toolOutput(messages, "workflow") ?? ""
    expect(output).toContain("accept · succeeded")
    const link = output.match(/http:\/\/127\.0\.0\.1:\d+\/runs\/[0-9a-f-]{36}/)?.[0]
    expect(link).toBeTruthy()
    const page = await fetch(link!)
    expect(page.status).toBe(200)
    expect(await page.text()).toContain("<script")
  }, 240_000)
  test("the installed package (installed when the location booted) carries the built TUI and web app", async () => {
    const found = await Array.fromAsync(new Bun.Glob("**/opencode-dynamic-workflows/package.json").scan({ cwd: path.join(server.root, "cache"), dot: true, absolute: true }))
    expect(found.length).toBeGreaterThan(0)
    const pkg = path.dirname(found[0]!)
    expect(existsSync(path.join(pkg, "dist", "tui.js"))).toBe(true)
    expect(existsSync(path.join(pkg, "dist", "web", "index.html"))).toBe(true)
    expect(existsSync(path.join(pkg, "docs", "protocol", "README.md"))).toBe(true)
  })

})
