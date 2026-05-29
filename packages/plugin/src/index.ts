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

const WORKFLOW_TOOL_DESCRIPTION = `Run a deterministic multi-subagent Workflow.

Pass \`source\`: a TypeScript module that default-exports defineWorkflow({ meta, run }) from
"@opencode-ai/workflow". The \`run\` function receives a context with:
  - agent(prompt, { subagent?, label?, phase?, model? }) → Promise<string | null>
    Runs one Unit as a named subagent (default "general") in its OWN child session; returns the subagent's
    final text, or null if the Unit failed (the failure is recorded in ctx.errors — never silently dropped).
  - parallel(thunks) → Promise<Array<T | null>>
    Fan a list of Units out CONCURRENTLY and wait for all to settle (a barrier). Bounded by
    meta.concurrency (default ~CPU-based). Results are positionally aligned to the input; a Unit that
    fails/throws becomes a null slot (the fan-out is NOT aborted) and is appended to ctx.errors.
  - collect(xs) → T[]   // drop the null slots from a parallel result AND type-narrow to T[]
  - errors   // ReadonlyArray<{ unit, prompt, subagent, error }> of every dropped Unit so far
  - args     // the JSON value you pass as the tool's \`args\`
  - log(message), phase(title)  // progress

Example (fan-out + collect):
  import { defineWorkflow } from "@opencode-ai/workflow"
  export default defineWorkflow({
    meta: { name: "summarize-each", description: "summarize each topic in parallel", concurrency: 4 },
    async run({ parallel, collect, args }) {
      const results = await parallel(
        args.topics.map((t) => () => agentSummarize(t)),  // each thunk runs one Unit
      )
      return collect(results)   // drops the Units that failed; the rest stay visible in ctx.errors
    },
  })

VISIBILITY: each Unit runs in its own child session — open any of them from the native session list to watch
its transcript live (the output below also lists them). There is no inline live widget for this tool yet
(rich in-run rendering is a tracked follow-up; see the orchestration spec).

NOTE: structured output (schema), pipeline, worktrees, checkpoints, and resume are not wired yet — this slice
adds parallel/collect/errors on top of the sequential agent() path.`

/** Cap the per-Unit session listing in the output text; the full list is always in metadata.childSessions. */
const MAX_LISTED_SESSIONS = 20

function formatOutput(out: RunWorkflowOutput): string {
  const lines: string[] = []
  lines.push(typeof out.result === "string" ? out.result : JSON.stringify(out.result, null, 2))

  const withSession = out.state.units.filter((u) => u.sessionID)
  if (withSession.length > 0) {
    lines.push("", `↳ ${withSession.length} unit(s) ran in child sessions (open from the session list):`)
    for (const u of withSession.slice(0, MAX_LISTED_SESSIONS)) {
      lines.push(`  - ${u.ok ? "✓" : "✗"} ${u.label ?? u.subagent} → ${u.sessionID}`)
    }
    const extra = withSession.length - MAX_LISTED_SESSIONS
    if (extra > 0) lines.push(`  - …and ${extra} more (see metadata.childSessions)`)
  }

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
          // Accumulate child-session refs as Units settle and re-emit them on the running tool part. No
          // current renderer consumes this for a tool named "workflow" (both the web UI and the TUI name-gate
          // the rich card to "task"), but it persists on the part for out-of-band navigation and a future
          // widget / upstream change. See the orchestration spec's rendering note.
          const childSessions: { sessionID: string; label: string | null; subagent: string; ok: boolean }[] = []
          try {
            const out = await runWorkflow({
              source: input.source,
              args: input.args,
              client: wfClient,
              parentSessionID: ctx.sessionID,
              events: {
                onLog: (m) => ctx.metadata({ title: `workflow: ${m}` }),
                onPhase: (t) => ctx.metadata({ title: `workflow phase: ${t}` }),
                onUnit: (u) => {
                  if (!u.sessionID) return
                  childSessions.push({ sessionID: u.sessionID, label: u.label, subagent: u.subagent, ok: u.ok })
                  ctx.metadata({ title: `workflow: ${childSessions.length} unit(s) started`, metadata: { childSessions } })
                },
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
                childSessions: out.state.units,
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
