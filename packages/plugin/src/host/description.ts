/**
 * What the model reads about the tools. Kept accurate to the engine (G14): every context member, working
 * examples, and the modes that retrieve Runs later.
 */

const CONTEXT_REFERENCE = `The \`run\` function receives a context:
  - agent(prompt, opts?) → Promise<T | null>
    One Unit: a fresh OpenCode session running a subagent (default "general"). Resolves to the subagent's final
    text, or — with \`schema\` (a zod schema from \`z\`, or a plain JSON Schema object) — to a VALIDATED object the
    Unit submitted through its \`workflow_result\` tool (invalid submissions are corrected in the same session).
    A failed Unit resolves to null and is recorded in ctx.errors; it never throws.
    opts: subagent (alias agentType), label, phase, model ("provider/model#variant" or {providerID, modelID}),
          effort (model variant, e.g. "high"), schema, retries (repair turns, default 2), timeoutMs (no default),
          permissions ([{ action, resource, effect }], applied to that Unit's session), location (a worktree dir)
  - parallel(thunks) → Promise<Array<T | null>>   concurrent barrier; failures become null slots
  - pipeline(items, ...stages) → Promise<Array<last | null>>   per-item stage chains, NO barrier between items;
    each stage gets (runningValue, originalItem, index); a throwing stage drops that item to null
  - collect(xs) → T[]   drop the nulls and narrow the type
  - errors   every dropped Unit so far: { unit, prompt, subagent, error }
  - args     the tool's \`args\`, validated against meta.args (zod) before anything runs
  - log(message), phase(title)   progress shown in the TUI panel and the web app
  - ask(question | questions, { fallback, graceMs? }) → Promise<string[][]>
    Ask the person a question mid-run (labels are a closed set; \`custom: true\` allows free text). \`fallback\` is
    REQUIRED and answers at once when nobody is attached (headless), so a Run never hangs.
  - budget   { total, spent(), remaining() } in output tokens. Advisory unless meta.budget = { tokens, hard: true }.
  - signal   the Run's AbortSignal (stopping the Run interrupts every Unit).

meta: { name, description, whenToUse?, phases?: [{ title, detail? }], args?: zod schema, concurrency?, unitTimeout?,
        budget?: number | { tokens, hard? }, permissions?: rules for every Unit, limits?: { maxUnits, maxItemsPerCall,
        maxUnitSteps }, interaction?: { permissions?: "ask" | "auto" | "deny", graceMs? } }

One shared limiter (meta.concurrency, default ~CPU-based) caps Units in flight across the whole Run. Hard limits
(default 1000 Units, 4096 items per call, 250 model steps per Unit) stop runaway scripts with a clear error.`

const EXAMPLE = `Example:
  import { defineWorkflow, z } from "opencode-dynamic-workflows/workflow"
  export default defineWorkflow({
    meta: { name: "review-files", description: "review each file, then summarise", args: z.object({ files: z.array(z.string()) }) },
    async run({ agent, pipeline, collect, phase, args }) {
      phase("review")
      const Finding = z.object({ file: z.string(), severity: z.enum(["low", "medium", "high"]), summary: z.string() })
      const findings = collect(await pipeline(args.files, (file) => agent(\`Review \${file} for bugs.\`, { label: file, schema: Finding })))
      phase("summary")
      return agent(\`Summarise these findings for a reviewer:\\n\${JSON.stringify(findings)}\`)
    },
  })`

export const WORKFLOW_TOOL_DESCRIPTION = `Run and inspect deterministic multi-subagent Workflows (durable ones, saved under .opencode/workflows/).

MODES (pick one):
  - list: true — list durable Workflows: key, description, when to use, args JSON Schema.
  - name: "<key>" (+ args) — run a durable Workflow by key. Keys are "<folder>:…:<meta.name>". Add
    background: true to return at once with the runId; otherwise the call waits for the result.
  - status: "<runId>" — where a Run is (phase, Units, failures). Works across sessions and restarts.
  - result: "<runId>" — a finished Run's result (its status if still running).
  - stop: "<runId>" — stop a running Run.
  - resume: "<runId>" — re-run an interrupted/failed Run, replaying the Units it already finished.
  - save_run: "<runId>" — promote an inline Run's script to a durable Workflow.
To run inline Workflow source, use the \`workflow_inline\` tool.

Every Unit runs in its own OpenCode session ("⟡ wf · …" in the session list). Users watch and steer Runs in the
TUI panel (/workflows) and the web app (the link in the result). Relay the result's summary line and link.

${CONTEXT_REFERENCE}

${EXAMPLE}`

export const WORKFLOW_INLINE_DESCRIPTION = `Run an INLINE (ad-hoc) Workflow: a TypeScript module you write, that default-exports
defineWorkflow({ meta, run }) imported from "opencode-dynamic-workflows/workflow".

Inline Workflows run with the user's permissions inside OpenCode, so the user approves each one (or approves inline
Workflows for the project) before it starts. Headless (no TUI or web app attached) it is refused unless the
project allows inline Workflows. Prefer a durable Workflow (the \`workflow\` tool) when one fits.

Arguments: source (required), args (validated against meta.args), background (return at once with the runId),
save: "<name>" (instead of running: save the source as .opencode/workflows/<name>.ts; "/" makes a namespace).

${CONTEXT_REFERENCE}

${EXAMPLE}`

export const RESULT_TOOL_DESCRIPTION =
  "Submit the final, structured result of this workflow Unit. Call exactly once when your work is complete; the input must match the schema."

export const WORKFLOW_COMMAND_TEMPLATE = `Run a durable Workflow. The first word of the request is the workflow key; the rest is what to run it on.

Call \`workflow({ name: "<first word>", args })\`, building \`args\` from the rest of the request. If the key or its
args are unclear (or the request is empty), call \`workflow({ list: true })\` first, then run the best match.

**Request:** $ARGUMENTS`
