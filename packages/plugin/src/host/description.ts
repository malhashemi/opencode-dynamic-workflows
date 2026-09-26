/**
 * What the model reads about the tools. Scope: how to write and run a Workflow. The full authoring guide is the
 * `dynamic-workflows` skill (`skill/dynamic-workflows/SKILL.md`); these descriptions stay short and point to it.
 */

const SKILL_POINTER =
  "Before writing a Workflow, load the `dynamic-workflows` skill: the full API, pipeline vs parallel, typed Units, questions, resume, quality patterns and worked examples."

const CONTEXT_REFERENCE = `A Workflow is a TypeScript module: export default defineWorkflow({ meta, run }), imported from
"@malhashemi/opencode-dynamic-workflows/workflow". meta: { name, description, whenToUse?, phases?: [{ title }], args?: zod schema,
concurrency?, budget?, permissions?, limits? }. run(ctx) returns the result. ctx:
  - agent(prompt, opts?) → one Unit (a fresh session with NONE of your context — make the prompt self-contained).
    Resolves to its final text, or with \`schema\` (zod \`z\` or JSON Schema, object at the root) to the validated value.
    A failed Unit resolves to null (recorded in ctx.errors); it never throws.
    opts: label, phase, subagent ("general" default, "explore" read-only), model ("provider/model#variant"), effort,
          schema, retries, timeoutMs, permissions, location
  - pipeline(items, ...stages) — per-item stage chains, NO barrier between items. The default for multi-stage work.
  - parallel(thunks) — a barrier; use only when a stage needs all results of the previous one.
  - collect(xs) drops nulls · phase(title) · log(message) · args · budget · signal · errors
  - ask(question, { fallback }) — ask the person; the fallback answers when nobody is watching.
  - $\\\`cmd \\\${value}\\\` / file.read|write / fetch — shell, files, HTTP confined to the project.
  - workflow(name, args) — run a saved Workflow as one step · agent(…, { isolation: "worktree" }) for Units that edit
    files in parallel; worktrees() lists the ones kept.`

const EXAMPLE = `Example — review each file, verify each finding as soon as its review is done:
  import { defineWorkflow, z } from "@malhashemi/opencode-dynamic-workflows/workflow"
  const Findings = z.object({ findings: z.array(z.object({ line: z.number().int().nullable(), claim: z.string() })) })
  const Verdict = z.object({ holds: z.boolean(), evidence: z.string() })
  export default defineWorkflow({
    meta: { name: "review-files", description: "Review files, verify each finding", phases: [{ title: "review" }, { title: "verify" }],
      args: z.object({ files: z.array(z.string()).min(1) }) },
    async run({ agent, pipeline, parallel, collect, args }) {
      const results = await pipeline(
        args.files,
        (file) => agent(\`Review \${file} for bugs. Report concrete findings with line numbers only.\`, { label: file, phase: "review", subagent: "explore", schema: Findings }),
        (review, file) => review && parallel(review.findings.map((f) => () =>
          agent(\`In \${file}, does this hold? Check the code. \${f.claim}\`, { label: \`verify:\${file}\`, phase: "verify", subagent: "explore", schema: Verdict })
            .then((v) => ({ file, ...f, holds: v?.holds ?? false })))),
      )
      return collect(results).flat().filter((f) => f.holds)
    },
  })`

export const WORKFLOW_TOOL_DESCRIPTION = `Run and inspect Workflows: deterministic scripts that fan work out to subagents.

MODES (pick one):
  - list: true — the saved (durable) Workflows: key, description, args JSON Schema.
  - name: "<key>" (+ args) — run a saved Workflow. background: true returns at once with a runId; a notification
    arrives in this session when the Run ends, so continue other work instead of polling.
  - status / result / stop / resume (alias resumeFromRunId): "<runId>" — inspect, fetch, stop or resume a Run.
    Resume replays the Units a Run already finished (matched by start order and prompt) and runs the rest live.
  - save_run: "<runId>" — keep an inline Run's script as a saved Workflow.
To run a script you write yourself, use \`workflow_inline\`. Pass args as JSON values, not JSON strings.

${SKILL_POINTER}

${CONTEXT_REFERENCE}

${EXAMPLE}`

export const WORKFLOW_INLINE_DESCRIPTION = `Run a Workflow script you write now (inline). The person approves inline code before it runs.

Arguments: source (the module), or scriptPath (a project file holding it); args (validated against meta.args);
background (return at once with a runId); save: "<folder/name>" — save it under .opencode/workflows/ instead of
running it, after which workflow({ name }) runs it by key.

${SKILL_POINTER}

${CONTEXT_REFERENCE}

${EXAMPLE}`

export const RESULT_TOOL_DESCRIPTION =
  "Submit the final, structured result of this workflow Unit. Call exactly once when your work is complete; the input must match the schema."

export const WORKFLOW_COMMAND_TEMPLATE = `Run a durable Workflow. The first word of the request is the workflow key; the rest is what to run it on.

Call \`workflow({ name: "<first word>", args })\`, building \`args\` from the rest of the request. If the key or its
args are unclear (or the request is empty), call \`workflow({ list: true })\` first, then run the best match.

**Request:** $ARGUMENTS`
