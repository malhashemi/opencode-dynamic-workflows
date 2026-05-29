/**
 * opencode plugin entry — registers the `workflow` orchestrator tool via the legacy `Hooks.tool` surface.
 *
 * The tool's `execute` closes over the injected SDK `client` and uses the invoking session as the Run's
 * parent. It is the only place we touch the real SDK client, so the single boundary cast to our narrow
 * {@link WorkflowClient} lives here. Loaded as a local file plugin via an absolute path in `opencode.json`.
 */
import { tool } from "@opencode-ai/plugin"
import type { Plugin } from "@opencode-ai/plugin"
import type { WorkflowClient } from "./client"
import { runWorkflow, type RunWorkflowOutput } from "./orchestrator"

const PLUGIN_ID = "opencode-dynamic-workflows"

const WORKFLOW_TOOL_DESCRIPTION = `Run a deterministic multi-subagent Workflow (walking skeleton).

Pass \`source\`: a TypeScript module that default-exports defineWorkflow({ meta, run }) from
"@opencode-ai/workflow". The \`run\` function receives a context with:
  - agent(prompt, { subagent? }) → Promise<string | null>  // runs one Unit as a named subagent
    (subagent defaults to "general"); returns the subagent's final text, or null if the Unit failed.
  - args   // the JSON value you pass as the tool's \`args\`
  - log(message), phase(title)  // progress

Example source:
  import { defineWorkflow } from "@opencode-ai/workflow"
  export default defineWorkflow({
    meta: { name: "summarize", description: "summarize a topic" },
    async run({ agent, args }) {
      return await agent(\`Summarize: \${args.topic}\`, { subagent: "general" })
    },
  })

NOTE (v1 skeleton): structured output (schema), parallel/pipeline, worktrees, checkpoints, and resume are
not wired yet — a single sequential agent() path only.`

function formatOutput(out: RunWorkflowOutput): string {
  const lines: string[] = []
  lines.push(typeof out.result === "string" ? out.result : JSON.stringify(out.result, null, 2))
  if (out.state.errors.length > 0) {
    lines.push("", `⚠ ${out.state.errors.length} unit(s) failed:`)
    for (const e of out.state.errors) lines.push(`  - [${e.subagent}] ${e.error}`)
  }
  return lines.join("\n")
}

export const WorkflowPlugin: Plugin = async ({ client }) => {
  const wfClient = client as unknown as WorkflowClient
  return {
    tool: {
      workflow: tool({
        description: WORKFLOW_TOOL_DESCRIPTION,
        args: {
          source: tool.schema.string().describe("Inline Workflow source: export default defineWorkflow({...})."),
          args: tool.schema.any().optional().describe("JSON value exposed to the Workflow as `args`."),
        },
        async execute(input, ctx) {
          ctx.metadata({ title: "workflow: starting" })
          try {
            const out = await runWorkflow({
              source: input.source,
              args: input.args,
              client: wfClient,
              parentSessionID: ctx.sessionID,
              events: {
                onLog: (m) => ctx.metadata({ title: `workflow: ${m}` }),
                onPhase: (t) => ctx.metadata({ title: `workflow phase: ${t}` }),
              },
            })
            return {
              title: out.meta.name,
              output: formatOutput(out),
              metadata: {
                workflow: out.meta.name,
                units: out.state.unitCount,
                phases: out.state.phases,
                logs: out.state.logs,
                errors: out.state.errors,
              },
            }
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error)
            return { title: "workflow failed", output: `Error: ${message}` }
          }
        },
      }),
    },
  }
}

export default { id: PLUGIN_ID, server: WorkflowPlugin }
