---
name: dynamic-workflows
description: How to write a Workflow for the `workflow` / `workflow_inline` tools — the defineWorkflow API, typed Units, pipeline vs parallel, questions, resume, quality patterns and worked examples. Load before writing a Workflow script.
---

# Writing a Workflow

A Workflow is a TypeScript module that fans work out to subagents and combines their results with ordinary code.
Each `agent()` call is one **Unit**: a fresh OpenCode session that runs one subagent on one prompt. The script is
where you encode the structure of the work — what fans out, what verifies, what synthesizes — so the control flow
is deterministic and the models do only the parts that need a model.

Reach for one when the work is **broad** (cover many files, areas or sources in parallel), needs **confidence**
(independent attempts, adversarial checks before you commit), or is **bigger than one context** (audits,
migrations, sweeps). Often the best move is hybrid: scout inline first (list the files, read the diff, find the
work-list), then write a Workflow that pipelines over it.

Common single-phase shapes, which you can chain across turns (read each result before designing the next):
- **Understand** — parallel readers over subsystems → one structured map
- **Design** — N independent approaches → judges → synthesis from the winner
- **Review** — dimensions → find → adversarially verify each finding
- **Research** — multi-angle sweep → deep-read → synthesize
- **Migrate** — discover sites → change each → verify

## The module

```ts
import { defineWorkflow, z } from "opencode-dynamic-workflows/workflow"

export default defineWorkflow({
  meta: {
    name: "review-changes",                        // the key once saved (a folder adds a prefix: team:review-changes)
    description: "Review changed files, verify each finding",
    whenToUse: "Before committing a change",       // optional; shown when Workflows are listed
    phases: [{ title: "review" }, { title: "verify" }],   // optional; one per phase title you use
    args: z.object({ files: z.array(z.string()).min(1) }), // optional; validated before any Unit starts
  },
  async run({ agent, pipeline, parallel, collect, phase, log, args }) {
    // …
    return { /* whatever the caller should get back */ }
  },
})
```

- It is real TypeScript (types, generics, `import type` all fine), run by Bun. Import only the authoring module
  and Node/Bun built-ins; an inline script cannot import relative files (a saved one can).
- `meta` is ordinary code — constants and computed values are fine.
- Declare `meta.phases` when you know them: progress then shows the whole plan, with the unreached phases queued.
  Titles are matched exactly against `phase()` calls and `agent({ phase })`.
- `args` arrive in `run` already parsed by `meta.args`. An object whose fields all have defaults also runs with no
  args. Pass arrays and objects as JSON values in the tool call, not as JSON strings.
- Whatever `run` returns is the Workflow's result (the tool shows it to you). Return compact, structured data.

## The context

| Member | Behaviour |
| --- | --- |
| `agent(prompt, opts?)` | One Unit. Resolves to the final text, or — with `schema` — to the validated value. A failed Unit resolves to **`null`** and is added to `errors`; it never throws. |
| `pipeline(items, ...stages)` | Each item runs through all stages on its own, with **no barrier** between items. Stages get `(previous, item, index)`. A stage that throws turns that item into `null` and skips its later stages. |
| `parallel(thunks)` | Runs `() => Promise` thunks concurrently and waits for all — a **barrier**. A thunk that throws becomes `null`; the call never rejects. |
| `collect(xs)` | Drops the `null`s, with the narrowed type. |
| `errors` | Every dropped Unit so far: `{ unit, prompt, subagent, error }`. |
| `phase(title)`, `log(message)` | Progress. `log` lines are what the person reads while it runs. |
| `ask(questions, { fallback, graceMs? })` | Asks the person (see below). |
| `budget` | `{ total, spent(), remaining() }` in output tokens for this Run. |
| `signal` | The Run's `AbortSignal`. |
| `$`, `file`, `fetch` | Shell, files and HTTP, confined to the project (see below). |
| `workflow(name, args?)` | Run a **saved** Workflow as one step of this Run and get its result (see below). |
| `worktrees()` | The worktrees kept by `isolation: "worktree"` Units that changed files. |

### `agent()` options

| Option | Use |
| --- | --- |
| `schema` | A zod schema (`z`), or a plain JSON Schema object → a typed, validated result. Use an **object** at the root. |
| `label` | The Unit's name in progress and in its session title. Always set it inside `pipeline`/`parallel` (`label: file`). |
| `phase` | Put this Unit in a phase explicitly. Use it inside `pipeline`/`parallel`: the global `phase()` changes under concurrent stages. |
| `subagent` (alias `agentType`) | Which subagent runs the Unit. Default `general`; `explore` is a fast read-only one — use it for readers and verifiers. |
| `model` | `"provider/model"` or `"provider/model#variant"`. Omit to use the subagent's model. Set it only when a stage clearly needs a different model. |
| `effort` | With `model`: its reasoning variant (e.g. `"low"`, `"high"`), same as `"provider/model#high"`. Ignored without `model`. |
| `retries` | Repair turns for a typed Unit (default 2). |
| `timeoutMs` | A deadline for this Unit. There is none by default. |
| `permissions` | Rules for this Unit's session, e.g. `[{ action: "edit", resource: "*", effect: "deny" }]`. |
| `isolation` | `"worktree"`: run the Unit in a fresh git worktree — for Units that **edit files in parallel** (see below). |
| `location` | Run the Unit in a directory you prepared yourself. |

### Typed Units

With `schema`, the Unit gets a `workflow_result` tool whose input is your schema. Every call is validated, so the
model fixes a bad call in the same turn. If it answers in prose instead, the engine accepts JSON in the reply
when it validates, then sends up to `retries` repair turns in the **same session**, then tries one extraction
call; if all fail the Unit is `null`. So:

- Prefer typed Units between stages. Later stages then receive discrete fields (claims with their sources,
  verdicts with evidence) instead of prose they must re-parse — prose between stages is where pipelines lose
  their citations.
- Keep schemas small and concrete; use `.describe()` on fields whose meaning is not obvious.
- Put the instruction for the *work* in the prompt; the engine adds the instruction to submit the result.

### Writing Unit prompts

A Unit starts with **none of your context**: not the conversation, not what you scouted. Put everything it needs in
the prompt — the task, the exact files or items, the question to answer, what "done" looks like. Its final answer
is data for your script, not a message to a person. Tell reviewers and researchers to report only (not to fix,
not to ask).

### Questions to the person

```ts
const [[depth]] = await ask(
  { header: "Depth", prompt: "How deep?", options: [{ label: "Quick", description: "3 areas" }, { label: "Thorough", description: "8 areas" }] },
  { fallback: [["Quick"]] },
)
```

`fallback` is required: it answers at once when nobody is watching, so a Run never hangs. Add `graceMs` to hand
the question to the fallback after a wait; without it the question waits for an answer. `multiple: true` allows
several labels, `custom: true` allows free text. Ask only what arguments could not have told you in advance —
typically a choice that depends on what an earlier phase found.

A Unit's model can also ask through its own `question` tool; the person answers it the same way (headless, the
Unit is told nobody is available and proceeds).

### Capabilities

```ts
const diff = await $`git diff ${base} -- ${file}`   // tagged template: values are shell-quoted
const status = await $("git status --short", { timeoutMs: 30_000 })
if (diff.exitCode !== 0) throw new Error(diff.stderr)
const text = await file.read("README.md")          // project files only
await file.write(".opencode/reports/out.md", report)
```

Use them to gather facts cheaply before spending Units, and to write outputs. Paths may not leave the project.
Shell commands stop when the Run stops (default timeout 120 s).

### Composing saved Workflows

```ts
const review = await workflow("review-diff", { base: "main" })   // a saved Workflow, by key
```

The child shares this Run's concurrency cap, budget, errors and stop signal; its Units and phases appear as
`review-diff › …`. Its args are validated against its own `meta.args` (a bad call throws — catch it if you want to
continue). One level only. Use it to build a larger process out of Workflows that already work on their own.

### Units that edit files in parallel

Parallel Units editing the same checkout overwrite each other. Give each its own worktree:

```ts
const results = await pipeline(modules, (m) =>
  agent(`Migrate ${m} to the new API. Commit your change with a clear message.`, { label: m, isolation: "worktree" }),
)
for (const tree of worktrees()) log(`review and merge: ${tree.branch} (${tree.directory})`)
```

A worktree is removed when its Unit changed nothing; otherwise it is kept and listed by `worktrees()` so the
script (or the person) can merge it — e.g. a final Unit, or `$\`git merge ${branch}\``. Worktrees cost setup time
and disk: use them only for Units that write. The plugin must be active in the worktree, so it has to be
configured in a committed `opencode.json` (or globally); otherwise those Units fail with a clear message.

## pipeline by default

Default to `pipeline`. Use a barrier only when a stage needs cross-item context from *all* results of the previous
stage:

- dedup or merge across the full set before expensive work,
- stop early when the total is zero,
- a prompt that compares against "the other findings".

A barrier is not justified by "I need to map/filter first" (do it inside a stage) or "the stages are
conceptually separate" (that is what `pipeline` models). The smell:

```ts
const a = await parallel(xs.map((x) => () => agent(find(x))))
const b = a.filter(Boolean).flatMap(split)          // no cross-item dependency…
const c = await parallel(b.map((y) => () => agent(verify(y))))   // …so this barrier only wastes time
```

Rewrite it as `pipeline(xs, (x) => agent(find(x)), (found) => parallel(split(found).map(…)))`: each item verifies
as soon as its own finding is ready. Wall-clock becomes the slowest single chain, not the sum of the slowest per
stage.

The canonical review:

```ts
const results = await pipeline(
  DIMENSIONS,
  (d) => agent(d.prompt, { label: `review:${d.key}`, phase: "review", subagent: "explore", schema: Findings }),
  (review, d) =>
    review &&
    parallel(review.findings.map((f) => () =>
      agent(`Adversarially verify against the code. Default to holds=false if unsure.\n${JSON.stringify(f)}`, {
        label: `verify:${f.file}`, phase: "verify", subagent: "explore", schema: Verdict,
      }).then((v) => ({ ...f, dimension: d.key, verdict: v })),
    )),
)
const confirmed = collect(results).flat().filter((f) => f.verdict?.holds)
```

A barrier that *is* correct — dedup across every finding before verification:

```ts
const all = collect(await parallel(FINDERS.map((f) => () => agent(f.prompt, { phase: "find", schema: Bugs }))))
const unique = dedupeByFileAndLine(all.flatMap((r) => r.bugs))   // genuinely needs all of them
const verdicts = await parallel(unique.map((b) => () => agent(verifyPrompt(b), { phase: "verify", schema: Verdict })))
```

## Loops and budgets

```ts
let draft: string = first            // type the loop variable as string, not string | null
for (let round = 0; round < 4; round++) {
  const critique = await agent(`Critique:\n${draft}`, { schema: Critique })
  if (!critique || critique.score >= 8) break
  const revised = await agent(`Revise to fix:\n${critique.issues.join("\n")}\n\n${draft}`)
  if (!revised) break
  draft = revised
}
```

`meta.budget: 200_000` is advisory: read `budget.remaining()` to scale depth. `meta.budget: { tokens: 200_000,
hard: true }` stops the Run once it is spent. Guard budget loops on `budget.total` — with no budget,
`remaining()` is `Infinity`:

```ts
while (budget.total !== null && budget.remaining() > 50_000) { /* another round */ }
```

Limits stop runaway scripts with a clear error: 1000 Units per Run, 4096 items per `parallel`/`pipeline` call,
250 model requests per Unit (`meta.limits` to change). At most 5 Units of a Run run at once (the plugin option
`maxConcurrentUnits`; `meta.concurrency` can lower it), and at most 5 Runs execute at once; extra ones queue.

## Quality patterns

Pick by task and compose freely:

- **Adversarial verify** — N independent skeptics per finding, each told to refute; keep it only if a majority
  cannot. Stops plausible-but-wrong findings.
- **Perspective-diverse verify** — give each verifier a distinct lens (correctness, security, does it reproduce)
  instead of N identical refuters.
- **Model diversity** — the same task on two different models (`model:`), then a judge. Independent errors are
  less correlated across models than across samples of one model.
- **Judge panel** — N attempts from different angles, parallel judges score them, synthesize from the winner and
  graft the best ideas from the others.
- **Loop until dry** — for unknown-size discovery, keep finding until K consecutive rounds add nothing new. Dedup
  against everything *seen*, not only what was confirmed, or rejected findings return every round.
- **Multi-modal sweep** — searchers that look in different ways (by file, by content, by history); each is blind
  to what the others find.
- **Completeness critic** — a last Unit asks "what is missing: an angle not run, a claim unverified, a source
  unread?" Its answer is the next round of work.
- **No silent caps** — if you bound coverage (top N, sampling, no retry), `log()` what was dropped.

Scale to what was asked: "find any bugs" → a few finders and single verification; "audit thoroughly" → a larger
finder pool, 3–5 verifiers per finding, a synthesis stage.

## Running what you wrote

- `workflow_inline({ source, args })` runs a script you just wrote; the person approves inline code before it runs.
- `workflow_inline({ source, save: "team/review" })` saves it as a durable Workflow (`.opencode/workflows/team/review.ts`)
  instead. Its key is `team:<meta.name>`; `workflow({ name: key, args })` then runs it without approval, and the key
  (with `/` for `:`) becomes a command. `workflow({ list: true })` shows the saved ones.
- `background: true` returns at once with a run id. When the Run ends, a notification with its summary and a
  result preview arrives in your session — continue other work meanwhile instead of polling
  (`workflow({ status })` / `workflow({ result })` are there when you need them earlier).
- Durable Workflows can import their own relative files and are the right home for anything run twice.

## Resume

`workflow({ resume: runId })` re-runs the Workflow from its journal: Units are matched **by start order and
prompt**. Every Unit whose prompt is unchanged returns its recorded result at once, answers to `ask` are replayed,
and from the first changed prompt onward everything runs live. Keep prompts deterministic — a timestamp or random
value in a prompt makes resume re-run it. Units that failed are re-run.

## Worked example — every Unit typed, two models, verify before reporting

```ts
import { defineWorkflow, z } from "opencode-dynamic-workflows/workflow"

const Plan = z.object({ areas: z.array(z.object({ name: z.string(), files: z.array(z.string()).min(1), question: z.string() })).max(4) })
const Findings = z.object({ findings: z.array(z.object({ file: z.string(), line: z.number().int().nullable(), claim: z.string() })).max(5) })
const Verified = z.object({ verdicts: z.array(z.object({ claim: z.string(), holds: z.boolean(), evidence: z.string() })) })
const Report = z.object({ summary: z.string(), risks: z.array(z.object({ title: z.string(), file: z.string(), fix: z.string() })).max(5) })

export default defineWorkflow({
  meta: {
    name: "code-audit",
    description: "Plan areas, investigate each, verify every finding against the code, report",
    phases: [{ title: "plan" }, { title: "investigate → verify" }, { title: "report" }],
    args: z.object({ root: z.string().default("src") }).default({ root: "src" }),
    permissions: [{ action: "edit", resource: "*", effect: "deny" }],   // auditors read, never write
  },
  async run({ agent, pipeline, collect, phase, log, $, args }) {
    phase("plan")
    const files = (await $`git ls-files ${args.root}`).stdout
    const plan = await agent(`Plan a correctness audit of these files. Pick up to 4 areas, each with its files and one sharp question.\n${files}`, { label: "planner", schema: Plan })
    if (!plan) throw new Error("planning failed")

    phase("investigate → verify")
    const verified = collect(
      await pipeline(
        plan.areas,
        (area) => agent(`Read ${area.files.join(", ")} and answer: ${area.question}. Report concrete findings with file and line only.`, { label: `investigate:${area.name}`, subagent: "explore", schema: Findings }),
        // A different `model:` here makes the verifier independent of the investigator (model diversity).
        (found, area) => found && agent(`Check each finding against the actual code; it holds only if the code really does that.\n${JSON.stringify(found.findings)}`, { label: `verify:${area.name}`, subagent: "explore", schema: Verified }),
      ),
    )
    const upheld = verified.flatMap((v) => v.verdicts.filter((x) => x.holds))
    log(`${upheld.length} finding(s) upheld`)

    phase("report")
    return agent(`Write the audit report from these verified findings:\n${JSON.stringify(upheld)}`, { label: "report", schema: Report })
  },
})
```
