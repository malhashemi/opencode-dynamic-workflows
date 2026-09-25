# opencode-dynamic-workflows

Deterministic multi-subagent **Workflows** for [OpenCode](https://opencode.ai) V2. A Workflow is a small
TypeScript program that fans work out to subagents — each `agent()` call is one **Unit**, an ordinary
OpenCode session — and combines their results with plain code: `parallel`, `pipeline`, typed results,
questions to a person, budgets and limits.

You watch and steer Runs in a TUI panel (`/workflows`) and in a web app, and any client can use the
versioned [protocol](./docs/protocol/README.md).

```ts
// .opencode/workflows/review-files.ts
import { defineWorkflow, z } from "opencode-dynamic-workflows/workflow"

export default defineWorkflow({
  meta: { name: "review-files", description: "review each file, then summarise", args: z.object({ files: z.array(z.string()) }) },
  async run({ agent, pipeline, collect, args }) {
    const Finding = z.object({ file: z.string(), severity: z.enum(["low", "medium", "high"]), summary: z.string() })
    const findings = collect(await pipeline(args.files, (file) => agent(`Review ${file}.`, { label: file, schema: Finding })))
    return agent(`Summarise for a reviewer:\n${JSON.stringify(findings)}`)
  },
})
```

Then ask the model to "run review-files on src/a.ts and src/b.ts", or type `/review-files src/a.ts src/b.ts`.

## Requirements

- OpenCode **2.0.16** or later (the V2 plugin API). Not compatible with OpenCode V1.
- Any model OpenCode can use. Typed results work best with models that call tools reliably; the engine
  falls back to JSON in text, a repair turn, and an extraction step.

## Install

Add the package to `plugins` in `opencode.json` (project) or your global config:

```jsonc
{
  "plugins": [
    "opencode-dynamic-workflows",
    // or with options:
    { "package": "opencode-dynamic-workflows", "options": { "inline": "ask", "gateway": { "port": 4320 } } }
  ]
}
```

From a checkout of this repository, run `bun install && bun run build` and use the absolute path of
`packages/plugin` instead. A git spec (`git+https://…#<ref>`) works for a repository whose root is the packed
package (`bun run pack` output). The TUI part loads automatically with the server part.

## Options

| Option | Default | Meaning |
| --- | --- | --- |
| `inline` | `"ask"` | Inline (model-written) Workflows: `ask` a person each time (or "always for this project"), `allow`, or `deny`. Headless `ask` refuses. |
| `inlineCapabilities` | `true` | Give inline Runs `ctx.$`, `ctx.file`, `ctx.fetch`. |
| `retention` | `"keep"` | `delete-on-success`: Runs that succeed are marked for cleanup; `/workflows cleanup` in the TUI deletes their Unit sessions. Press `d` on any finished Run to delete its Unit sessions. |
| `limits` | `{ maxUnits: 1000, maxItemsPerCall: 4096, maxUnitSteps: 250 }` | Hard limits per Run / call / Unit. |
| `gateway` | `{ enabled: true, bind: "loopback", port: 4320, auth: "token", allowedOrigins: [], web: true }` | The HTTP + SSE Gateway and web app. See [security](./docs/security.md). |

## Using it

**Tools the model gets**

- `workflow` — `list`; run a durable Workflow by `name` (+ `args`, `background`); `status`, `result`,
  `stop`, `resume` (alias `resumeFromRunId`) a Run by id; `save_run` to keep an inline Run's script.
- `workflow_inline` — run model-written `source` (or a project file via `scriptPath`) after approval;
  `save` it as a durable Workflow instead.
- Inside Units only: `workflow_result` (typed results) and the engine-answered `question` tool.

**Commands**

- `/workflow <key> <request>` and one `/<key>` command per durable Workflow (namespaces become `/`), kept in
  sync when Workflow files change.
- `/workflows` in the TUI: the library of Runs, a Run view (phases, Units, activity, result), Unit detail,
  and the controls (stop, stop/restart a Unit, resume, save, cleanup). `/workflows pair` shows a code for a
  remote browser.

**Where Workflows live**

`.opencode/workflows/**/*.ts` (or `workflow/`) in the project and every parent directory, the global config
directory, and `$OPENCODE_CONFIG_DIR`. A subfolder becomes a namespace: `workflows/team/review.ts` with
`meta.name: "review"` has the key `team:review`. The nearest scope wins a key collision.

**Web app**

Every tool result links to the Run in the web app, served by the Gateway (default
`http://127.0.0.1:4320`). A browser on the same machine pairs itself for control actions.

## Authoring reference

`run(ctx)` receives:

| Member | What it does |
| --- | --- |
| `agent(prompt, opts?)` | One Unit. Returns its final text, or — with `schema` (zod or a JSON Schema object) — a validated value. A failed Unit returns `null` and is added to `errors`; it never throws. Options: `subagent` (alias `agentType`, default `general`), `label`, `phase`, `model` (`"provider/model#variant"` or `{ providerID, modelID }`), `effort` (variant), `schema`, `retries` (repair turns, default 2), `timeoutMs`, `permissions`, `location` (another directory, e.g. a worktree). |
| `parallel(thunks)` | Run thunks concurrently and wait for all (a barrier). Failures become `null`. |
| `pipeline(items, ...stages)` | Each item runs its stages independently — no barrier between items. |
| `collect(xs)` | Drop the `null`s, narrowed type. |
| `errors` | Every dropped Unit: `{ unit, prompt, subagent, error }`. |
| `args` | The Run's `args`, validated against `meta.args` before anything starts. |
| `log(msg)`, `phase(title)` | Progress in the TUI and web app. |
| `ask(question(s), { fallback, graceMs? })` | Ask a person. The `fallback` answers at once when nobody is attached, so a Run never hangs. |
| `budget` | `{ total, spent(), remaining() }` in output tokens. |
| `signal` | The Run's `AbortSignal`. |
| `$`, `file`, `fetch` | Shell, files and HTTP, confined to the project and recorded in the Run's activity. |

`meta`: `name`, `description`, `whenToUse`, `phases`, `args` (zod), `concurrency`, `unitTimeout`,
`budget` (`number`, or `{ tokens, hard: true }` to stop at the limit), `permissions` (rules for every Unit),
`limits`, `interaction: { permissions: "ask" | "auto" | "deny", graceMs }`.

Import from `opencode-dynamic-workflows/workflow`. Workflows written for the old name
`@opencode-ai/workflow` still load. More in [`docs/examples/`](./docs/examples).

### How typed results work

A Unit with a `schema` gets a `workflow_result` tool whose input is your schema. The tool validates each call,
so the model can correct itself in the same turn. If the model answers in text, the engine tries the JSON in
that text, then sends up to `retries` repair turns in the same session, then extracts the value with a plain
generation call. Every Unit records which path produced its value (`resultPath`) and every attempt.

### Runs survive

Every Run is journaled under `.opencode/workflows/runs/<runId>/`. A plugin reload does not stop running
Runs. If the OpenCode service dies, the Run reads back as `interrupted`; `resume` starts a new Run that
replays the Units (and answers) the old one finished, by start order, and runs the rest live.

## Security

Inline Workflows are model-written code that runs with your privileges; a person approves each one by
default. Units get OpenCode's permission rules plus a policy that never lets a headless Run hang on a
permission. The Gateway binds loopback and needs a token for control. Read [docs/security.md](./docs/security.md).

## Protocol

Runs, Units, interactions, events and errors are a versioned protocol over OpenCode plugin RPC and over the
Gateway (HTTP + SSE): [docs/protocol/README.md](./docs/protocol/README.md), with JSON Schemas.

## Troubleshooting

- **The plugin does not load from a local directory.** OpenCode resolves a directory plugin's entry by path
  (`<dir>/server` or `<dir>/index`), not through `package.json` exports. This package ships `server.ts`,
  `rpc.ts` and a `tui` entry at its root for that reason.
- **Inline Workflows are refused in `opencode run`.** Nobody can approve them headless. Approve "always for
  this project" once from the TUI or web app, save the script as a durable Workflow, or set `inline: "allow"`.
- **A Unit fails with "exceeded its step limit".** The Unit made more model requests than
  `limits.maxUnitSteps` (a loop guard). Raise the limit for Workflows whose Units legitimately do long work.

## Development

```sh
bun install
bun run typecheck
bun test                                                 # engine, protocol, TUI models (no OpenCode needed)
bun run build                                            # dist/tui.js, dist/web, schema check
bun run pack                                             # build, then the publishable tarball
bun test ./packages/plugin/test/live --timeout 300000    # real OpenCode on a private server (cheap model)
```

The live harness starts `opencode serve` with its own database under `$TMPDIR/opencode`; it never touches
your configuration. `WF_LIVE_MODEL` picks the model (default `google/gemini-3.1-flash-lite`).
