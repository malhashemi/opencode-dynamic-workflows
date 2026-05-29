import { describe, expect, it } from "bun:test"
import { WorkflowPlugin } from "../src/index"
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
})
