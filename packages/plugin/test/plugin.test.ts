import { afterEach, beforeEach, describe, expect, it } from "bun:test"
import { existsSync } from "node:fs"
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { WorkflowPlugin, normalizeArgs } from "../src/index"
import pluginDefault from "../src/index"
import { makeFakeClient } from "./fake-client"

const SIMPLE_WORKFLOW = `
import { defineWorkflow } from "@opencode-ai/workflow"
export default defineWorkflow({
  meta: { name: "greet", description: "greet someone" },
  async run({ agent, args }) {
    return await agent(\`greet \${args.name}\`, { subagent: "general" })
  },
})
`

function fakePluginInput(
  client: ReturnType<typeof makeFakeClient>,
  extra: { directory?: string; worktree?: string } = {},
) {
  // `client` (always) + `directory`/`worktree` (for registry discovery); cast covers the rest of PluginInput.
  return { client, ...extra } as unknown as Parameters<typeof WorkflowPlugin>[0]
}

type Hooks = Awaited<ReturnType<typeof WorkflowPlugin>>
type WorkflowTool = NonNullable<NonNullable<Hooks["tool"]>[string]>

function fakeToolCtx(sessionID: string) {
  return {
    sessionID,
    messageID: "m1",
    agent: "build",
    directory: "/tmp",
    worktree: "/tmp",
    abort: new AbortController().signal,
    metadata: () => {},
    ask: async () => {},
  } as unknown as Parameters<WorkflowTool["execute"]>[1]
}

/** Resolve the registered `workflow` tool, asserting it exists (narrows away `undefined`). */
function workflowTool(hooks: Hooks): WorkflowTool {
  const wf = hooks.tool?.workflow
  if (!wf) throw new Error("expected a `workflow` tool to be registered")
  return wf
}

describe("WorkflowPlugin (adapter)", () => {
  it("default-exports a file plugin with an id and a server function", () => {
    expect(pluginDefault.id).toBe("opencode-dynamic-workflows")
    expect(typeof pluginDefault.server).toBe("function")
  })

  it("registers a `workflow` tool", async () => {
    const hooks = await WorkflowPlugin(fakePluginInput(makeFakeClient()))
    expect(hooks.tool?.workflow).toBeDefined()
    expect(typeof workflowTool(hooks).execute).toBe("function")
  })

  it("executes an inline workflow end-to-end against the injected client", async () => {
    const client = makeFakeClient({ reply: "Hi, Sam!" })
    const hooks = await WorkflowPlugin(fakePluginInput(client))
    const result = await workflowTool(hooks).execute(
      { source: SIMPLE_WORKFLOW, args: { name: "Sam" } },
      fakeToolCtx("session-42"),
    )

    expect(typeof result).toBe("object")
    const out = result as { title: string; output: string; metadata?: Record<string, unknown> }
    expect(out.title).toBe("greet")
    expect(out.output).toContain("Hi, Sam!")
    expect(out.metadata?.units).toBe(1)

    // out-of-band visibility: the child session is listed in the output and carried in metadata
    expect(out.output).toContain("ran in child sessions")
    expect(out.output).toContain("child-1")
    expect(out.metadata?.childSessions).toHaveLength(1)

    // the Run was parented to the invoking session
    expect(client.createCalls[0]?.parentID).toBe("session-42")
    expect(client.promptCalls[0]?.agent).toBe("general")
  })

  it("returns a failure result (does not throw) on bad source", async () => {
    const hooks = await WorkflowPlugin(fakePluginInput(makeFakeClient()))
    const result = await workflowTool(hooks).execute(
      { source: "not a workflow", args: undefined },
      fakeToolCtx("s1"),
    )
    const out = result as { title: string; output: string }
    expect(out.title).toBe("workflow failed")
    expect(out.output).toContain("Error:")
  })

  // Regression: the GitLab/DWS "workflow" provider's toolExecutor JSON.parses only the OUTER tool-args blob
  // (opencode session/llm.ts:132), so a nested `args` field emitted as a JSON string reaches execute() as a
  // STRING. The adapter must restore the parsed-object contract before running, or a typed meta.args schema
  // rejects the string ("expected object, received string"). See normalizeArgs.
  it("coerces a JSON-string `args` to an object so a typed workflow runs", async () => {
    const client = makeFakeClient({ reply: "Hi, Sam!" })
    const hooks = await WorkflowPlugin(fakePluginInput(client))
    const result = await workflowTool(hooks).execute(
      // args arrives as a STRING, exactly as the workflow-provider seam delivers it
      { source: SIMPLE_WORKFLOW, args: '{"name":"Sam"}' as unknown as Record<string, unknown> },
      fakeToolCtx("session-99"),
    )
    const out = result as { title: string; output: string }
    expect(out.title).toBe("greet")
    expect(out.output).toContain("Hi, Sam!") // ran — the workflow saw args.name = "Sam", not a raw string
    // the prompt actually interpolated the parsed field, proving args.name was a string "Sam" not undefined
    expect(client.promptCalls[0]?.parts).toEqual([{ type: "text", text: "greet Sam" }])
  })
})

describe("config hook (/workflow command injection)", () => {
  it("injects a single static `workflow` command with a $ARGUMENTS template", async () => {
    const hooks = await WorkflowPlugin(fakePluginInput(makeFakeClient()))
    expect(typeof hooks.config).toBe("function")
    const cfg: { command?: Record<string, { template: string; description?: string }> } = {}
    await hooks.config!(cfg as never)
    const cmd = cfg.command?.workflow
    expect(cmd).toBeDefined()
    expect(cmd!.template).toContain("$ARGUMENTS")
    expect(cmd!.template).toContain("workflow") // instructs calling the workflow tool
    expect(typeof cmd!.description).toBe("string")
  })

  it("does not clobber a user-defined `workflow` command (idempotent ??=)", async () => {
    const hooks = await WorkflowPlugin(fakePluginInput(makeFakeClient()))
    const cfg = { command: { workflow: { template: "MINE", description: "mine" } } }
    await hooks.config!(cfg as never)
    expect(cfg.command.workflow.template).toBe("MINE")
  })

  it("preserves other commands when injecting", async () => {
    const hooks = await WorkflowPlugin(fakePluginInput(makeFakeClient()))
    const cfg: { command: Record<string, { template: string }> } = { command: { other: { template: "x" } } }
    await hooks.config!(cfg as never)
    expect(cfg.command.other).toEqual({ template: "x" })
    expect(cfg.command.workflow).toBeDefined()
  })
})

// A durable Workflow file (meta.name is the registry key for a top-level file).
const GREET_DURABLE = `
import { defineWorkflow } from "@opencode-ai/workflow"
export default defineWorkflow({
  meta: { name: "greet", description: "greet someone by name" },
  async run({ agent, args }) { return await agent(\`greet \${args.name}\`, { subagent: "general" }) },
})
`
const DEEP_DURABLE = `
import { defineWorkflow, z } from "@opencode-ai/workflow"
export default defineWorkflow({
  meta: { name: "deep", description: "deep research", whenToUse: "for hard questions", args: z.object({ q: z.string() }) },
  async run({ args }) { return args.q },
})
`
// An ad-hoc Workflow to promote; meta.name "promoted" so a top-level save keys as "promoted".
const PROMOTE_SRC = `
import { defineWorkflow } from "@opencode-ai/workflow"
export default defineWorkflow({
  meta: { name: "promoted", description: "a promoted workflow" },
  async run() { return "PROMOTED_OK" },
})
`
// A workflow to write AFTER plugin construction (AC#1 single-instance in-session discovery).
const LATE_DURABLE = `
import { defineWorkflow } from "@opencode-ai/workflow"
export default defineWorkflow({ meta: { name: "late", description: "added mid-session" }, async run() { return "LATE_OK" } })
`
// Two of these (same meta.name "dup") across scopes force a cross-scope collision in list mode.
const dupWf = (ret: string) =>
  `import { defineWorkflow } from "@opencode-ai/workflow"\n` +
  `export default defineWorkflow({ meta: { name: "dup", description: "dup" }, async run() { return ${JSON.stringify(ret)} } })\n`

describe("workflow tool: durable registry (list + run-by-name)", () => {
  const KEYS = ["OPENCODE_TEST_HOME", "XDG_CONFIG_HOME", "OPENCODE_DISABLE_PROJECT_CONFIG", "OPENCODE_CONFIG_DIR"] as const
  const saved: Record<string, string | undefined> = {}
  for (const k of KEYS) saved[k] = process.env[k]

  let home = ""
  let project = ""

  beforeEach(async () => {
    home = await mkdtemp(path.join(os.tmpdir(), "wf-home-"))
    project = await mkdtemp(path.join(os.tmpdir(), "wf-proj-"))
    // Isolate scope resolution: point home + XDG at empty temp dirs so the real ~/.config/opencode and
    // ~/.opencode are NOT scanned; only the project's .opencode/workflows is in play.
    process.env.OPENCODE_TEST_HOME = home
    process.env.XDG_CONFIG_HOME = path.join(home, ".config")
    delete process.env.OPENCODE_DISABLE_PROJECT_CONFIG
    delete process.env.OPENCODE_CONFIG_DIR
  })
  afterEach(async () => {
    for (const k of KEYS) {
      if (saved[k] === undefined) delete process.env[k]
      else process.env[k] = saved[k]
    }
    await rm(home, { recursive: true, force: true })
    await rm(project, { recursive: true, force: true })
  })

  async function writeWorkflow(rel: string, contents: string): Promise<void> {
    const abs = path.join(project, ".opencode", "workflows", rel)
    await mkdir(path.dirname(abs), { recursive: true })
    await writeFile(abs, contents, "utf8")
  }

  it("lists durable workflows with keys, descriptions, and args schema", async () => {
    await writeWorkflow("greet.ts", GREET_DURABLE)
    await writeWorkflow("research/deep.ts", DEEP_DURABLE) // nested → key "research:deep"
    const hooks = await WorkflowPlugin(fakePluginInput(makeFakeClient(), { directory: project, worktree: project }))
    const res = (await workflowTool(hooks).execute({ list: true }, fakeToolCtx("s"))) as {
      title: string
      output: string
      metadata?: { workflows?: { key: string; args?: Record<string, unknown> }[] }
    }
    expect(res.title).toContain("workflows")
    expect(res.output).toContain("greet")
    expect(res.output).toContain("research:deep")
    // the args schema must be in the model-visible OUTPUT (not just metadata) so run-by-name fills args right
    expect(res.output).toContain("args:")
    expect(res.output).toContain('"q"') // research:deep's args schema property, rendered into the output text
    const wfs = res.metadata?.workflows ?? []
    expect(wfs.map((w) => w.key).sort()).toEqual(["greet", "research:deep"])
    // also surfaced structurally in metadata for the UI
    const deep = wfs.find((w) => w.key === "research:deep")
    expect((deep?.args as { properties?: Record<string, unknown> })?.properties).toHaveProperty("q")
  })

  it("echoes the expected args JSON Schema when run-by-name args fail validation", async () => {
    await writeWorkflow("research/deep.ts", DEEP_DURABLE) // requires { q: string }
    const hooks = await WorkflowPlugin(fakePluginInput(makeFakeClient(), { directory: project, worktree: project }))
    const res = (await workflowTool(hooks).execute({ name: "research:deep", args: { wrong: 1 } }, fakeToolCtx("s"))) as { title: string; output: string }
    expect(res.title).toContain("invalid args")
    expect(res.output).toContain("q") // names the offending/expected field
    expect(res.output).toContain("JSON Schema") // and echoes the full schema so the model corrects first-try
  })

  it("runs a durable workflow by its registry key", async () => {
    await writeWorkflow("greet.ts", GREET_DURABLE)
    const client = makeFakeClient({ reply: "Hi, Sam!" })
    const hooks = await WorkflowPlugin(fakePluginInput(client, { directory: project, worktree: project }))
    const res = (await workflowTool(hooks).execute({ name: "greet", args: { name: "Sam" } }, fakeToolCtx("s-1"))) as {
      title: string
      output: string
    }
    expect(res.title).toBe("greet")
    expect(res.output).toContain("Hi, Sam!")
    expect(client.promptCalls[0]?.parts).toEqual([{ type: "text", text: "greet Sam" }])
    expect(client.createCalls[0]?.parentID).toBe("s-1") // parented to the invoking session
  })

  it("returns a clear miss (listing registered keys) for an unknown name", async () => {
    await writeWorkflow("greet.ts", GREET_DURABLE)
    const hooks = await WorkflowPlugin(fakePluginInput(makeFakeClient(), { directory: project, worktree: project }))
    const res = (await workflowTool(hooks).execute({ name: "nope" }, fakeToolCtx("s"))) as { title: string; output: string }
    expect(res.title).toContain("unknown")
    expect(res.output).toContain("greet") // names what IS registered
    expect(res.output).toContain("nope")
  })

  it("reports nothing-to-run when given no name/source/list", async () => {
    const hooks = await WorkflowPlugin(fakePluginInput(makeFakeClient(), { directory: project, worktree: project }))
    const res = (await workflowTool(hooks).execute({}, fakeToolCtx("s"))) as { title: string; output: string }
    expect(res.title).toContain("nothing to run")
  })

  it("injects a /<name> command per discovered workflow (nested key → '/' convention) plus the live /workflow", async () => {
    await writeWorkflow("greet.ts", GREET_DURABLE) // key "greet" → command "greet"
    await writeWorkflow("research/deep.ts", DEEP_DURABLE) // key "research:deep" → command "research/deep"
    const hooks = await WorkflowPlugin(fakePluginInput(makeFakeClient(), { directory: project, worktree: project }))
    const cfg: { command?: Record<string, { template: string; description?: string }> } = {}
    await hooks.config!(cfg as never)
    const cmds = cfg.command ?? {}

    expect(cmds.workflow).toBeDefined() // live catch-all fallback
    expect(cmds.greet).toBeDefined() // top-level workflow → /greet
    expect(cmds["research/deep"]).toBeDefined() // nested key "research:deep" → /research/deep
    expect(cmds["research:deep"]).toBeUndefined() // the ':'-key is NOT the command name

    // the per-workflow template bakes the ':'-key as the tool `name` and feeds $ARGUMENTS as the request
    expect(cmds.greet!.template).toContain('name: "greet"')
    expect(cmds["research/deep"]!.template).toContain('name: "research:deep"')
    expect(cmds["research/deep"]!.template).toContain("$ARGUMENTS")
    // a compact, readable arg summary (NOT the raw JSON Schema dump)
    expect(cmds["research/deep"]!.template).toContain("q:") // the arg field, summarized
    expect(cmds["research/deep"]!.template).not.toContain("JSON Schema")
    expect(cmds.greet!.template).toContain("Args — none") // greet declares no args schema
  })

  it("does not clobber a user command that shares a workflow's name (??= → user wins)", async () => {
    await writeWorkflow("greet.ts", GREET_DURABLE)
    const hooks = await WorkflowPlugin(fakePluginInput(makeFakeClient(), { directory: project, worktree: project }))
    const cfg = { command: { greet: { template: "MINE", description: "mine" } } }
    await hooks.config!(cfg as never)
    expect(cfg.command.greet.template).toBe("MINE")
  })

  it("promotes inline source to a durable file (verbatim), then runs it by name with no restart", async () => {
    const client = makeFakeClient()
    const hooks = await WorkflowPlugin(fakePluginInput(client, { directory: project, worktree: project }))
    const res = (await workflowTool(hooks).execute({ source: PROMOTE_SRC, save: "promoted" }, fakeToolCtx("s"))) as {
      title: string
      output: string
      metadata?: { key?: string; path?: string }
    }
    expect(res.title).toContain("promoted")
    expect(res.metadata?.key).toBe("promoted") // top-level → key is meta.name
    const saved = path.join(project, ".opencode", "workflows", "promoted.ts")
    expect(res.metadata?.path).toBe(saved)
    expect(await readFile(saved, "utf8")).toBe(PROMOTE_SRC) // byte-for-byte verbatim

    // discoverable + runnable by name immediately (fresh hooks, same fs) — no restart
    const hooks2 = await WorkflowPlugin(fakePluginInput(client, { directory: project, worktree: project }))
    const run = (await workflowTool(hooks2).execute({ name: "promoted" }, fakeToolCtx("s2"))) as { title: string; output: string }
    expect(run.title).toBe("promoted")
    expect(run.output).toContain("PROMOTED_OK")
  })

  it("promotes into a namespace subfolder (key uses ':')", async () => {
    const hooks = await WorkflowPlugin(fakePluginInput(makeFakeClient(), { directory: project, worktree: project }))
    const res = (await workflowTool(hooks).execute({ source: PROMOTE_SRC, save: "research/promoted" }, fakeToolCtx("s"))) as {
      metadata?: { key?: string }
    }
    expect(res.metadata?.key).toBe("research:promoted") // subfolder namespace + meta.name
    expect(existsSync(path.join(project, ".opencode", "workflows", "research", "promoted.ts"))).toBe(true)
  })

  it("refuses to overwrite an existing workflow file (save conflict), leaving it untouched", async () => {
    await writeWorkflow("greet.ts", GREET_DURABLE)
    const hooks = await WorkflowPlugin(fakePluginInput(makeFakeClient(), { directory: project, worktree: project }))
    const res = (await workflowTool(hooks).execute({ source: PROMOTE_SRC, save: "greet" }, fakeToolCtx("s"))) as { title: string }
    expect(res.title).toContain("conflict")
    expect(await readFile(path.join(project, ".opencode", "workflows", "greet.ts"), "utf8")).toBe(GREET_DURABLE)
  })

  it("save requires source", async () => {
    const hooks = await WorkflowPlugin(fakePluginInput(makeFakeClient(), { directory: project, worktree: project }))
    const res = (await workflowTool(hooks).execute({ save: "x" }, fakeToolCtx("s"))) as { title: string }
    expect(res.title).toContain("nothing to save")
  })

  it("rejects a `save` name that escapes the workflows dir (path traversal), writing nothing", async () => {
    const hooks = await WorkflowPlugin(fakePluginInput(makeFakeClient(), { directory: project, worktree: project }))
    const res = (await workflowTool(hooks).execute({ source: PROMOTE_SRC, save: "../../evil" }, fakeToolCtx("s"))) as { title: string }
    expect(res.title).toContain("invalid save name")
    expect(existsSync(path.join(project, "evil.ts"))).toBe(false) // nothing written outside workflows/
    expect(existsSync(path.join(project, "..", "evil.ts"))).toBe(false)
  })

  // AC#1 (the load-bearing live criterion), in-process: a workflow written AFTER the plugin is constructed is
  // discoverable + runnable on the SAME instance — proving the registry is rebuilt per call (not cached at
  // construction). Guards against a future refactor that hoists discovery into the factory closure.
  it("discovers + runs a workflow written AFTER construction, on the same instance (no restart)", async () => {
    const client = makeFakeClient()
    const hooks = await WorkflowPlugin(fakePluginInput(client, { directory: project, worktree: project }))

    const before = (await workflowTool(hooks).execute({ list: true }, fakeToolCtx("s"))) as { metadata?: { workflows?: { key: string }[] } }
    expect((before.metadata?.workflows ?? []).some((w) => w.key === "late")).toBe(false)

    await writeWorkflow("late.ts", LATE_DURABLE) // written mid-session, AFTER construction

    const after = (await workflowTool(hooks).execute({ list: true }, fakeToolCtx("s"))) as { metadata?: { workflows?: { key: string }[] } }
    expect((after.metadata?.workflows ?? []).some((w) => w.key === "late")).toBe(true)

    const run = (await workflowTool(hooks).execute({ name: "late" }, fakeToolCtx("s2"))) as { title: string; output: string }
    expect(run.title).toBe("late")
    expect(run.output).toContain("LATE_OK")
  })

  // AC#2: list mode surfaces cross-scope collisions + load failures (not silently dropped).
  it("list surfaces a cross-scope collision and a load failure", async () => {
    const globalWf = path.join(home, ".config", "opencode", "workflows", "g.ts")
    await mkdir(path.dirname(globalWf), { recursive: true })
    await writeFile(globalWf, dupWf("GLOBAL"), "utf8") // global-scope "dup"
    await writeWorkflow("p.ts", dupWf("PROJECT")) // project-scope "dup" → cross-scope collision (project wins)
    await writeWorkflow("broken.ts", "export const nope = 1") // load failure

    const hooks = await WorkflowPlugin(fakePluginInput(makeFakeClient(), { directory: project, worktree: project }))
    const res = (await workflowTool(hooks).execute({ list: true }, fakeToolCtx("s"))) as {
      output: string
      metadata?: { collisions?: { key: string; sameScope: boolean }[]; failures?: { absPath: string }[] }
    }
    expect((res.metadata?.collisions ?? []).some((c) => c.key === "dup" && c.sameScope === false)).toBe(true)
    expect((res.metadata?.failures ?? []).some((f) => f.absPath.endsWith("broken.ts"))).toBe(true)
    expect(res.output).toContain("collision")
    expect(res.output).toContain("failed to load")
  })
})

describe("normalizeArgs", () => {
  it("parses a JSON-string into its value (the workflow-provider seam)", () => {
    expect(normalizeArgs('{"topics":["a","b"]}')).toEqual({ topics: ["a", "b"] })
    expect(normalizeArgs("[1,2,3]")).toEqual([1, 2, 3])
  })

  it("passes a non-string value through untouched (every normal tool-call path)", () => {
    const obj = { topics: ["a"] }
    expect(normalizeArgs(obj)).toBe(obj) // same reference — no round-trip
    expect(normalizeArgs(undefined)).toBeUndefined()
    expect(normalizeArgs(42)).toBe(42)
  })

  it("leaves a non-JSON string AS the string (a legit z.string() meta.args)", () => {
    // "hello" is not JSON; must not throw and must not be mangled — meta.args validation then decides.
    expect(normalizeArgs("hello")).toBe("hello")
    // a bare number-looking string would JSON.parse to a number, which would be WRONG for a z.string() arg;
    // guard: only parse when it looks like a JSON object/array, so "123"/"true" stay strings.
    expect(normalizeArgs("123")).toBe("123")
    expect(normalizeArgs("true")).toBe("true")
  })
})
