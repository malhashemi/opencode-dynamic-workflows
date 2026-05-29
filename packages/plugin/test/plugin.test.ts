import { describe, expect, it } from "bun:test"
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

function fakePluginInput(client: ReturnType<typeof makeFakeClient>) {
  // Only `client` is used by the plugin; cast covers the unused PluginInput fields.
  return { client } as unknown as Parameters<typeof WorkflowPlugin>[0]
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
    expect(client.createCalls[0]?.body?.parentID).toBe("session-42")
    expect(client.promptCalls[0]?.body?.agent).toBe("general")
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
    expect(client.promptCalls[0]?.body?.parts).toEqual([{ type: "text", text: "greet Sam" }])
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
