/**
 * opencode plugin entry — registers the `workflow` orchestrator tool via the legacy `Hooks.tool` surface.
 *
 * The tool's `execute` closes over the injected SDK `client` and uses the invoking session as the Run's
 * parent. It is the only place we touch the real SDK client, so the single boundary cast to our narrow
 * {@link WorkflowClient} lives here. Loaded as a local file plugin via an absolute path in `opencode.json`.
 */
import { existsSync } from "node:fs"
import { mkdir, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { tool } from "@opencode-ai/plugin"
import type { Plugin, PluginOptions, ToolContext } from "@opencode-ai/plugin"
import { createOpencodeClient } from "@opencode-ai/sdk/v2"
import type { WorkflowClient } from "./client"
import { createControlRegistry, createInteractionController, type ControlResult } from "./control"
import { removeDescriptor, writeDescriptor } from "./discovery"
import { startEndpoint, type EndpointOptions } from "./endpoint"
import { createJournal, journalRoot, subscribeJournal, type Journal } from "./journal"
import { loadWorkflowConfig, runWorkflow, runWorkflowFromFile, type RunWorkflowOutput } from "./orchestrator"
import { formatElapsed, formatTokens, phasePosition, settledUnits } from "./progress"
import { buildRegistry, type Registry, type RegistryEntry } from "./registry"
import { createRunStore, type RunEvent, type RunSnapshot, type RunStore } from "./runs"
import { toJsonSchema } from "./schema-bridge"

/** The structural shape every mode of the `workflow` tool returns. */
type WorkflowToolResult = { title: string; output: string; metadata?: Record<string, unknown> }

const PLUGIN_ID = "opencode-dynamic-workflows"

const WORKFLOW_TOOL_DESCRIPTION = `Run a deterministic multi-subagent Workflow.

MODES (pick one):
  - \`name\`: run a DURABLE Workflow registered under a "workflows" directory, by its registry key. Keys are
    \`<subfolder>:<...>:<meta.name>\` (a nested folder is a ":"-joined namespace); a top-level file is just
    \`<meta.name>\`. Pass its \`args\` alongside. Call with \`list: true\` first to discover keys + each
    Workflow's args schema. An unknown name returns the list of registered keys.
  - \`source\`: run INLINE ad-hoc Workflow source (below). To keep one, promote it with \`save\` (next bullet).
  - \`list: true\`: list available durable Workflows (key, description, whenToUse, args JSON Schema) and return,
    without running anything.
  - \`save: "<name>"\` (with \`source\`): PROMOTE the inline \`source\` to durable — a verbatim save to
    \`<project>/.opencode/workflows/<save>.ts\` (a \`/\` in \`save\` becomes a namespace). Validates the source
    first, won't overwrite an existing file, and returns the resolved registry key (which may differ from the
    filename — the key is the path namespace + \`meta.name\`). Runnable by name immediately, no restart.
  - \`status: "<runId>"\`: report where a Run is (or was) — phase, settled/total Units, failures, elapsed. Answers
    for a LIVE Run from memory and for a finished one from the on-disk journal, so it works across sessions and
    after a restart. Every completed Run's output names its own runId.
  - \`result: "<runId>"\`: return the consolidated result of a completed Run from the journal. If it is still
    running you get its status instead, so this is safe to call at any time.

\`source\` is a TypeScript module that default-exports defineWorkflow({ meta, run }) from
"@opencode-ai/workflow". The \`run\` function receives a context with:
  - agent(prompt, { subagent?, label?, phase?, model?, schema?, retries? }) → Promise<T | null>
    Runs one Unit as a named subagent (default "general") in its OWN child session. Without \`schema\`, resolves
    to the subagent's final text. With a zod \`schema\` (import { z } from "@opencode-ai/workflow"), requests
    native structured output and resolves to the schema's INFERRED TYPE — a validated object, not text — so a
    later step can read its fields directly. A StructuredOutputError or a payload that fails the schema is
    retried up to \`retries\` (default 2); a failed Unit resolves to null and is recorded in ctx.errors (never
    silently dropped).
  - parallel(thunks) → Promise<Array<T | null>>
    Fan a list of Units out CONCURRENTLY and wait for all to settle (a barrier). Results are positionally
    aligned to the input; a Unit that fails/throws becomes a null slot (the fan-out is NOT aborted) and is
    appended to ctx.errors.
  - pipeline(items, ...stages) → Promise<Array<lastResult | null>>
    Run each item down the stage chain INDEPENDENTLY — NO barrier between items (item A can be in stage 3
    while item B is still in stage 1). Each stage gets (runningValue, originalItem, index). A stage that
    THROWS drops that item to null (skipping its remaining stages) and records it in ctx.errors; others keep
    flowing. The default for staged per-item work; pair with collect() to feed survivors to a synthesis Unit.
  - collect(xs) → T[]   // drop the null slots from a parallel/pipeline result AND type-narrow to T[]
  - errors   // ReadonlyArray<{ unit, prompt, subagent, error }> of every dropped Unit so far
  - args     // the value you pass as the tool's \`args\` (a JSON value — object/array/etc); if meta.args is a
             // zod schema it is VALIDATED + typed before the run starts (invalid input fails immediately,
             // naming the offending field). A JSON string is accepted and parsed for you.
  - log(message), phase(title)  // progress

CONCURRENCY: one shared limiter caps how many Units run at once across the WHOLE run (default ~CPU-based,
or meta.concurrency). agent() is the only thing that launches a Unit, so parallel and pipeline both draw
from that one cap — total in-flight Units never exceeds it, however many fan-outs are mid-flight.

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

Example (structured output — the result is typed, compute on its fields with no re-parsing):
  import { defineWorkflow, z } from "@opencode-ai/workflow"
  export default defineWorkflow({
    meta: { name: "rate", description: "structured rating of a PR" },
    async run({ agent }) {
      const Rating = z.object({ score: z.number(), reason: z.string() })
      const r = await agent("Rate this PR 0-10 and give a one-line reason.", { schema: Rating })
      return r && { doubled: r.score * 2, reason: r.reason }   // r is { score, reason }, not text
    },
  })

Example (typed args + pipeline + collect → synthesis):
  import { defineWorkflow, z } from "@opencode-ai/workflow"
  export default defineWorkflow({
    meta: { name: "review-each", description: "review then verify each file", args: z.object({ files: z.array(z.string()) }) },
    async run({ agent, pipeline, collect, args }) {
      const reviewed = await pipeline(
        args.files,                                         // args is typed { files: string[] }, already validated
        (file) => agent(\`Review \${file} for bugs.\`),       // stage 1: one Unit per file
        (review) => agent(\`Verify: \${review}\`),            // stage 2: starts per-file as soon as stage 1 lands
      )
      return collect(reviewed)   // survivors only; dropped files stay visible in ctx.errors
    },
  })

VISIBILITY: each Unit runs in its own child session — open any of them from the native session list to watch
its transcript live (the output below also lists them). There is no inline live widget for this tool yet
(rich in-run rendering is a tracked follow-up; see the orchestration spec).

COMMANDS: each durable Workflow is exposed at init as its own \`/<key>\` slash command (key \`a:b\` → \`/a/b\`,
mirroring opencode's nested convention); a live \`/workflow\` command is the catch-all (and reaches workflows
added mid-session, which don't get their own command until a reload). Every command just drives THIS tool.

NOTE: durable-Workflow discovery + run-by-name + per-workflow commands + ad-hoc→durable promotion are wired.
Per-agent permission filtering of \`list\` and ask/deny/allow gating of runs are a tracked follow-up (the list
here is unfiltered). Worktrees, checkpoints, nested workflow(), and resume are not wired yet.`

/**
 * Template for the single static `/workflow` slash command. The command layer CANNOT force a tool call
 * (`toolChoice` can't name a tool; a command's parts can't carry a synthetic tool call — verified), so this
 * is an INSTRUCTION the model follows: route `/workflow <key> <args…>` to the `workflow` tool by name. The
 * one workflow NAME is the command's `$ARGUMENTS`, resolved at execute-time against the live registry — there
 * is exactly one command, not one per workflow (opencode freezes the command name set per process).
 *
 * Note: opencode expands `$ARGUMENTS` (and runs its `` !`…` `` shell substitution) on the template before
 * sending — same behavior as every other command; a `<key>` containing that pattern is the user's own shell.
 */
const WORKFLOW_COMMAND_TEMPLATE = `Run a durable Workflow. The first word of the request is the workflow key; the rest is the request to run it on.

Call \`workflow({ name: "<first word>", args })\`, building \`args\` from the rest of the request. If the key or
its args are unclear (or the request is empty), call \`workflow({ list: true })\` first to see the keys + arg
schemas, then run the best match. Run by name — do not paste source.

**Request:** $ARGUMENTS`

/**
 * Restore the parsed-object contract for the one core caller that breaks it. The GitLab/DWS "workflow" model
 * provider's toolExecutor runs `tool.execute(JSON.parse(argsJson), …)` (opencode `session/llm.ts:132`), which
 * JSON-parses only the OUTER tool-args blob — so a nested `args` field the service emitted as a JSON string
 * arrives here as a string instead of a value. Every other tool-call path (the Vercel AI SDK wrapper and the
 * native llm runtime) parses + validates the model input against the schema first, so `args` is already an
 * object there and this is a no-op. Our `args: z.any().optional()` is too permissive to reject the string, so
 * we normalize at the boundary (the mirror of that seam) rather than teaching the provider-agnostic engine a
 * transport quirk.
 *
 * Guarded two ways: (1) only a string is touched; (2) only a string that *looks* like a JSON object/array is
 * parsed — so a legitimate `meta.args: z.string()` value like "hello", "123", or "true" is passed through
 * unchanged (parsing those would be lossy: `JSON.parse("123")` is the number 123). A string that looks like
 * JSON but fails to parse also falls through untouched; `meta.args` validation then gives the real error.
 */
export function normalizeArgs(args: unknown): unknown {
  if (typeof args !== "string") return args
  const trimmed = args.trim()
  if (!(trimmed.startsWith("{") || trimmed.startsWith("["))) return args
  try {
    return JSON.parse(trimmed)
  } catch {
    return args
  }
}

/** Cap the per-Unit session listing in the output text; the full list is always in metadata.childSessions. */
const MAX_LISTED_SESSIONS = 20

/**
 * The one line a model relays into its reply: `deep-research · done · 14/14 units · 2m10s · 41k tok`.
 *
 * The returned text is the ONLY zero-install surface that renders everywhere (native TUI, desktop/web app,
 * `opencode run`, SDK callers) — the app's generic tool card shows neither our title, our metadata, nor our
 * output body, so anything the user must see rides the model's reply. Phase 5 appends the dashboard URL here.
 *
 * `run` is the terminal store snapshot; it carries the status/timing/tokens the engine's return value does not.
 */
function runSummaryLine(out: RunWorkflowOutput, run?: RunSnapshot): string {
  const settled = out.state.units.length
  const parts = [out.meta.name, run?.status ?? "done", `${settled}/${Math.max(out.state.unitCount, settled)} units`]
  if (run) parts.push(formatElapsed((run.endedAt ?? Date.now()) - run.startedAt))
  const tokens = run?.tokensSpent ?? out.state.tokensSpent
  if (tokens > 0) parts.push(`${formatTokens(tokens)} tok`)
  return parts.join(" · ")
}

function formatOutput(out: RunWorkflowOutput, run?: RunSnapshot): string {
  const lines: string[] = []
  lines.push(typeof out.result === "string" ? out.result : JSON.stringify(out.result, null, 2))
  lines.push("", runSummaryLine(out, run))
  // The id, in the text rather than only in metadata, because the model reads the text — and without it the
  // `status`/`result` modes are unreachable for the run that just happened.
  if (run) lines.push(`run ${run.runId} — later: workflow({ result: "${run.runId}" })`)

  if (out.state.errors.length > 0) {
    lines.push("", `⚠ ${out.state.errors.length} unit(s) failed:`)
    for (const e of out.state.errors) lines.push(`  - [${e.subagent}] ${e.error}`)
  }

  const withSession = out.state.units.filter((u) => u.sessionID)
  if (withSession.length > 0) {
    lines.push("", `↳ ${withSession.length} unit(s) ran in child sessions (open from the session list):`)
    for (const u of withSession.slice(0, MAX_LISTED_SESSIONS)) {
      lines.push(`  - ${u.ok ? "✓" : "✗"} ${u.label ?? u.subagent} → ${u.sessionID}`)
    }
    const extra = withSession.length - MAX_LISTED_SESSIONS
    if (extra > 0) lines.push(`  - …and ${extra} more (see metadata.childSessions)`)
  }
  return lines.join("\n")
}

/** Build the tool result for a completed Run — shared by the run-by-name and run-ad-hoc paths. */
function runResult(out: RunWorkflowOutput, run?: RunSnapshot): WorkflowToolResult {
  return {
    title: out.meta.name,
    output: formatOutput(out, run),
    metadata: {
      ...(run ? { runId: run.runId } : {}),
      workflow: out.meta.name,
      units: out.state.unitCount,
      phases: out.state.phases,
      logs: out.state.logs,
      errors: out.state.errors,
      childSessions: out.state.units,
    },
  }
}

/**
 * A run's state, in one line, from a snapshot of any age: `deep-research · done · 14/14 units · 2m10s · 41k tok`.
 *
 * Shared by the live and journaled paths on purpose — a user asking `status` should not be able to tell which
 * one answered, because the answer is the same fact either way.
 */
function snapshotSummaryLine(run: RunSnapshot): string {
  const parts = [run.workflow, run.status, `${settledUnits(run)}/${run.units.length} units`]
  parts.push(formatElapsed((run.endedAt ?? Date.now()) - run.startedAt))
  if (run.tokensSpent > 0) parts.push(`${formatTokens(run.tokensSpent)} tok`)
  return parts.join(" · ")
}

function statusLines(run: RunSnapshot, live: boolean): string[] {
  const lines = [snapshotSummaryLine(run)]
  const position = [phasePosition(run), run.currentPhase ?? (run.status === "running" ? "starting" : "")]
    .filter(Boolean)
    .join(" ")
  if (position) lines.push(position)
  lines.push(`run ${run.runId} · ${run.provenance} · ${live ? "live" : "from the journal"}`)
  if (run.errors.length > 0) {
    lines.push("", `⚠ ${run.errors.length} unit(s) failed:`)
    for (const error of run.errors) lines.push(`  - [${error.subagent}] ${error.error}`)
  }
  return lines
}

function unknownRunResult(runId: string): WorkflowToolResult {
  return {
    title: "workflow: unknown run",
    output:
      `No Run with id "${runId}" is running, and none is recorded in this project's journal ` +
      "(`.opencode/workflows/runs/`). Check the id from the Run's own output, or start a new Run.",
  }
}

/**
 * `status` — where a Run is, live or long finished.
 *
 * The live store is consulted FIRST because it is the only source that is current to the millisecond; the
 * journal answers for everything the process no longer holds, which after a restart is everything.
 */
async function statusResult(runId: string, store: RunStore, journal: Journal | null): Promise<WorkflowToolResult> {
  const live = store.get(runId)
  const run = live ?? (await journal?.read(runId))?.run
  if (!run) return unknownRunResult(runId)
  return {
    title: `${run.workflow}: ${run.status}`,
    output: statusLines(run, live !== undefined).join("\n"),
    metadata: {
      runId: run.runId,
      workflow: run.workflow,
      status: run.status,
      phase: run.currentPhase,
      units: run.units.length,
      settledUnits: settledUnits(run),
      errors: run.errors,
      live: live !== undefined,
    },
  }
}

/**
 * `result` — what a Run produced.
 *
 * A still-running Run answers with its status rather than with an error: "not yet" is a real answer, and one
 * the caller can act on without having to know to ask a different question.
 */
async function resultResult(runId: string, store: RunStore, journal: Journal | null): Promise<WorkflowToolResult> {
  const record = await journal?.read(runId)
  const live = store.get(runId)
  if (!record && !live) return unknownRunResult(runId)

  const run = live ?? record?.run
  if (!record?.run || run?.status === "running") {
    const status = await statusResult(runId, store, journal)
    return { ...status, output: `That Run has not finished yet.\n\n${status.output}` }
  }

  const result = record.result
  const body =
    result === null || result === undefined
      ? `That Run ended \`${record.run.status}\` without a result.`
      : typeof result === "string"
        ? result
        : JSON.stringify(result, null, 2)
  return {
    title: `${record.run.workflow}: result`,
    output: [body, "", ...statusLines(live ?? record.run, live !== undefined)].join("\n"),
    metadata: {
      runId: record.run.runId,
      workflow: record.run.workflow,
      status: record.run.status,
      units: record.run.units.length,
      settledUnits: settledUnits(record.run),
      errors: record.run.errors,
    },
  }
}

/** Best-effort JSON Schema for a Workflow's `args` (so the model can build valid args); undefined if none/non-zod. */
function argsSchemaOf(argsSchema: unknown): Record<string, unknown> | undefined {
  if (!argsSchema) return undefined
  try {
    return toJsonSchema(argsSchema as Parameters<typeof toJsonSchema>[0])
  } catch {
    return undefined
  }
}

/**
 * Map a registry key to its slash-command name. Our keys are `:`-joined (`research:deep`); opencode's own
 * nested-command convention is `/`-joined (`git/commit`), so a namespaced workflow gets `/research/deep`. The
 * command's template still calls the tool with the original `:`-key, so the registry key is unchanged.
 */
function commandNameForKey(key: string): string {
  return key.replaceAll(":", "/")
}

/** A compact, human-readable one-line arg summary from a workflow's schema, e.g. `phrase: string (required)`. */
function argsSummary(argsSchema: unknown): string {
  const js = argsSchemaOf(argsSchema)
  const props = js?.properties as Record<string, Record<string, unknown>> | undefined
  if (!props || Object.keys(props).length === 0) return "none"
  const required = new Set(Array.isArray(js?.required) ? (js?.required as string[]) : [])
  return Object.entries(props)
    .map(([name, p]) => {
      let type = typeof p.type === "string" ? p.type : "any"
      if (Array.isArray(p.enum)) type = p.enum.map((e) => JSON.stringify(e)).join("|")
      if (type === "array") type = `${(p.items as { type?: string } | undefined)?.type ?? "any"}[]`
      const def = p.default !== undefined ? ` = ${JSON.stringify(p.default)}` : ""
      const req = required.has(name) && p.default === undefined ? " (required)" : ""
      return `${name}: ${type}${def}${req}`
    })
    .join(", ")
}

/**
 * Template for a single workflow's own `/<name>` command. Bakes the workflow's `:`-key (the tool's `name` arg)
 * + a clean arg summary, and feeds the user's `$ARGUMENTS` as the request the model turns into `args`. (The
 * precise full JSON Schema is available via `list` and echoed on a validation miss, for complex/edge args.)
 */
function perWorkflowTemplate(entry: RegistryEntry): string {
  const lines = [`**${entry.key}** — ${entry.meta.description}`]
  if (entry.meta.whenToUse) lines.push(`_${entry.meta.whenToUse}_`)
  lines.push(
    "",
    `Run it by calling \`workflow({ name: ${JSON.stringify(entry.key)}, args })\`, building \`args\` from the request below — do not paste source.`,
    `Args — ${argsSummary(entry.meta.args)}`,
    "",
    "**Request:** $ARGUMENTS",
  )
  return lines.join("\n")
}

/** Render the `list: true` mode — the (unfiltered) registry of durable Workflows, plus any collisions/failures. */
function listResult(reg: Registry) {
  const entries = [...reg.entries.values()].sort((a, b) => a.key.localeCompare(b.key))
  const lines: string[] = []
  if (entries.length === 0) {
    lines.push("No durable Workflows found. Add a `defineWorkflow` module under `<scope>/.opencode/workflows/`, or promote an ad-hoc one.")
  } else {
    lines.push(`${entries.length} durable Workflow(s) available — run one with workflow({ name: "<key>", args }):`)
    for (const e of entries) {
      lines.push(`  - ${e.key} — ${e.meta.description}`)
      if (e.meta.whenToUse) lines.push(`      when: ${e.meta.whenToUse}`)
      // The args schema MUST be in the output text (not just metadata) — the model reads `output`, not the
      // UI-only `metadata`. Without this the model guesses arg names when running by name / via /workflow.
      const schema = argsSchemaOf(e.meta.args)
      lines.push(`      args: ${schema ? JSON.stringify(schema) : "(none — pass args:{} or omit)"}`)
    }
  }
  if (reg.collisions.length > 0) {
    lines.push("", `⚠ ${reg.collisions.length} key collision(s):`)
    for (const c of reg.collisions) {
      const why = c.sameScope
        ? "two files in the SAME scope declare this key — rename one"
        : "a higher-priority scope shadowed another"
      lines.push(`  - ${c.key}: kept ${c.kept} (shadowed ${c.shadowed}) — ${why}`)
    }
  }
  if (reg.failures.length > 0) {
    lines.push("", `⚠ ${reg.failures.length} Workflow file(s) failed to load:`)
    for (const f of reg.failures) lines.push(`  - ${f.absPath}: ${f.error}`)
  }
  return {
    title: `workflows (${entries.length})`,
    output: lines.join("\n"),
    metadata: {
      workflows: entries.map((e) => ({ key: e.key, description: e.meta.description, whenToUse: e.meta.whenToUse, args: argsSchemaOf(e.meta.args) })),
      collisions: reg.collisions,
      failures: reg.failures,
    },
  }
}

function failResult(error: unknown) {
  const message = error instanceof Error ? error.message : String(error)
  return { title: "workflow failed", output: `Error: ${message}` }
}

function dashboardOptions(options: PluginOptions | undefined): EndpointOptions {
  const dashboard = options?.dashboard
  if (typeof dashboard !== "object" || dashboard === null || Array.isArray(dashboard)) return {}
  const value = dashboard as Record<string, unknown>
  return {
    enabled: typeof value.enabled === "boolean" ? value.enabled : undefined,
    port: typeof value.port === "number" ? value.port : undefined,
    host: typeof value.host === "string" ? value.host : undefined,
  }
}

/**
 * OpenCode's canonical state directory — the rendezvous point where the server target publishes its endpoint
 * descriptor and the TUI target (via `api.state.path.state`) looks for it.
 *
 * Computed locally, on purpose. The obvious implementation asks the running host (`GET /path`), but a server
 * plugin is initialized *inside* an instance's bootstrap and that instance answers no HTTP until every
 * plugin's init resolves — so awaiting our own host deadlocks it. Observed on a real 1.18.10 host: with the
 * plugin installed, `/path?directory=<project>` never returns and the TUI never paints a single frame.
 *
 * Deriving it is exact rather than approximate: the host's value is itself a pure XDG computation
 * (`packages/core/src/global.ts` → `xdg-basedir`), so both targets land on the same directory with no I/O.
 */
/** The HeyAPI transport the host configured on the client it injected: base URL, `fetch`, and auth headers. */
interface InjectedTransport {
  baseUrl?: string
  fetch?: typeof globalThis.fetch
  headers?: Record<string, string>
}

function readInjectedTransport(client: unknown): InjectedTransport | null {
  const inner = (client as { _client?: { getConfig?: () => InjectedTransport } } | null)?._client
  const config = typeof inner?.getConfig === "function" ? inner.getConfig() : null
  if (!config || (!config.fetch && !config.baseUrl)) return null
  return config
}

/**
 * Build the engine's v2 client on the SAME transport the host handed us, not on `serverUrl`.
 *
 * `PluginInput.serverUrl` is not always a server. In OpenCode's DEFAULT TUI mode there is no HTTP listener
 * at all: the TUI talks to its worker over RPC, and the host builds the plugin's injected client with a
 * `fetch` that dispatches straight into the in-process Hono app — leaving `serverUrl` as the placeholder
 * `http://localhost:4096` (`packages/opencode/src/plugin/index.ts`). A plugin that believes `serverUrl`
 * therefore talks to nothing, or — worse — to whichever unrelated OpenCode happens to hold port 4096.
 *
 * Observed on a real 1.18.10 TUI before this: every unit failed instantly with "session.create returned no
 * session id", so a workflow "completed" having done nothing. Only `opencode serve` (a real listener) worked.
 *
 * Reusing the injected transport also inherits the host's `ServerAuth` headers, so a password-protected
 * server keeps working. The v2 client is still constructed separately — the engine needs the flat v2 request
 * shapes, and the injected client is the legacy one.
 */
function createWorkflowClient(input: {
  client: Parameters<Plugin>[0]["client"]
  directory: string | undefined
  serverUrl: URL | undefined
}): WorkflowClient {
  const transport = readInjectedTransport(input.client)
  if (transport) {
    return createOpencodeClient({
      ...(transport.baseUrl ? { baseUrl: transport.baseUrl } : {}),
      ...(transport.fetch ? { fetch: transport.fetch } : {}),
      ...(transport.headers ? { headers: transport.headers } : {}),
      ...(input.directory ? { directory: input.directory } : {}),
    })
  }
  // No readable transport: a partial structural PluginInput from a unit test, or an SDK whose internals moved.
  if (input.serverUrl) {
    return createOpencodeClient({
      baseUrl: input.serverUrl.toString(),
      ...(input.directory ? { directory: input.directory } : {}),
    })
  }
  return input.client as unknown as WorkflowClient
}

export function opencodeStatePath(): string {
  const xdg = process.env.XDG_STATE_HOME
  const base = xdg && xdg.length > 0 ? xdg : path.join(os.homedir(), ".local", "state")
  return path.join(base, "opencode")
}

function eventRunId(event: RunEvent): string {
  return event.type === "run.started" || event.type === "run.ended" ? event.run.runId : event.runId
}

/** The durable, machine-readable progress record carried by the native tool part. */
interface NativeProgressRecord {
  runId: string
  workflow: string
  phase: string | null
  settledUnits: number
  totalUnits: number
  elapsedMs: number
}

function nativeProgressRecord(run: RunSnapshot, now = Date.now()): NativeProgressRecord {
  return {
    runId: run.runId,
    workflow: run.workflow,
    phase: run.currentPhase,
    settledUnits: settledUnits(run),
    totalUnits: run.units.length,
    elapsedMs: (run.endedAt ?? now) - run.startedAt,
  }
}

function nativeProgressTitle(run: RunSnapshot, now = Date.now()): string {
  const record = nativeProgressRecord(run, now)
  const phase = phasePosition(run) || run.currentPhase || "starting"
  return `workflow ${run.workflow} — ${phase} · ${record.settledUnits}/${record.totalUnits} units · ${formatElapsed(record.elapsedMs)}`
}

/**
 * Everything except `elapsedMs`: two records with the same key describe a run that has not actually moved.
 *
 * The separator is written as an escape rather than a literal control byte, so the source file stays text to
 * git and grep, and no field value can forge a key collision.
 */
function progressChangeKey(record: NativeProgressRecord): string {
  return [record.runId, record.workflow, record.phase ?? "", record.settledUnits, record.totalUnits].join("\u0000")
}

/**
 * Mirror live run state into the invoking tool's native part.
 *
 * Emission is CHANGE-DRIVEN, not periodic: the host replaces the whole running part on every `ctx.metadata()`
 * call and resets its `time.start` while doing so, so a per-second elapsed tick silently rewrote the one
 * number the native UI does render. Now only a real transition (run started, phase change, unit queued, unit
 * settled) emits — `run.log` and `unit.started` move nothing in the record, so they emit nothing — and the
 * final `stop()` emit happens only if something changed after the last one, instead of unconditionally
 * resetting the part's timing immediately before the result lands.
 */
function createNativeProgressMirror(ctx: ToolContext, store: RunStore, runId: string): { stop(): void } {
  const intervalMs = 100
  let lastEmittedAt = 0
  let lastKey: string | null = null
  let timer: ReturnType<typeof setTimeout> | null = null
  let stopped = false

  const changed = (): boolean => {
    const run = store.get(runId)
    return run ? progressChangeKey(nativeProgressRecord(run)) !== lastKey : false
  }

  const emit = () => {
    timer = null
    const run = store.get(runId)
    if (!run) return
    const now = Date.now()
    const record = nativeProgressRecord(run, now)
    const key = progressChangeKey(record)
    if (key === lastKey) return
    lastEmittedAt = now
    lastKey = key
    try {
      ctx.metadata({ title: nativeProgressTitle(run, now), metadata: { ...record } })
    } catch {
      // Progress rendering is best-effort and must never change the Run's result.
    }
  }

  const schedule = () => {
    if (stopped || !changed()) return
    const wait = intervalMs - (Date.now() - lastEmittedAt)
    if (wait <= 0) emit()
    else if (!timer) timer = setTimeout(emit, wait)
  }
  const unsubscribe = store.subscribe((event) => {
    if (eventRunId(event) === runId) schedule()
  })

  return {
    stop() {
      if (stopped) return
      if (timer) clearTimeout(timer)
      timer = null
      stopped = true
      unsubscribe()
      // A throttled change may still be pending; flush it, but never re-emit an unchanged record.
      if (changed()) emit()
    },
  }
}

/**
 * The outcome of a promotion, as data.
 *
 * Structured rather than pre-rendered, because promotion now has two callers with different vocabularies: the
 * tool answers a model in prose, and `save.run` answers the run browser with a {@link ControlResult}. Reading
 * a `ControlFailure` back out of a formatted title string is exactly the coupling that breaks silently.
 */
type PromoteOutcome =
  | { ok: true; key: string; path: string }
  | { ok: false; kind: "no-root" | "invalid-source" | "invalid-name" | "conflict"; message: string }

/**
 * Promote inline ad-hoc `source` to a DURABLE Workflow: a verbatim save into `<project>/.opencode/workflows/`.
 * `save` is the target name/path under that dir (may contain `/` for a namespace). The source is validated
 * (so we never persist a non-Workflow) but written byte-for-byte. Won't overwrite an existing file. Re-scans
 * to report the resolved registry key (key = path namespace + meta.name, not the filename). The file is
 * immediately runnable by name via the tool; its own `/command` appears after the next opencode reload.
 */
async function promoteSource(input: {
  source: string
  save: string
  directory?: string
  worktree?: string
}): Promise<PromoteOutcome> {
  const root = input.worktree || input.directory
  if (!root) return { ok: false, kind: "no-root", message: "cannot resolve a project directory to save into" }

  // Validate the source is a real Workflow BEFORE persisting (don't write garbage into the workflows dir).
  let meta: RegistryEntry["meta"]
  try {
    meta = (await loadWorkflowConfig(input.source)).meta
  } catch (error) {
    return { ok: false, kind: "invalid-source", message: error instanceof Error ? error.message : String(error) }
  }

  const rel = input.save.replace(/\.ts$/, "") // tolerate a trailing .ts in the requested name
  const workflowsRoot = path.join(root, ".opencode", "workflows")
  const target = path.join(workflowsRoot, `${rel}.ts`)
  // Containment: `save` is model-supplied — reject any name that escapes the workflows dir (e.g. "../../x").
  const rootResolved = path.resolve(workflowsRoot)
  if (path.resolve(target) !== rootResolved && !path.resolve(target).startsWith(rootResolved + path.sep)) {
    return {
      ok: false,
      kind: "invalid-name",
      message: `\`save\` must stay within .opencode/workflows (got ${JSON.stringify(input.save)}).`,
    }
  }
  if (existsSync(target)) {
    return {
      ok: false,
      kind: "conflict",
      message: `A workflow file already exists at ${target}. Choose another \`save\` name or remove it first.`,
    }
  }
  await mkdir(path.dirname(target), { recursive: true })
  await writeFile(target, input.source, "utf8") // verbatim — byte-for-byte the same defineWorkflow module

  // Re-scan so we report the ACTUAL registry key (derived from the path namespace + meta.name).
  let key = meta.name
  if (input.directory) {
    try {
      const reg = await buildRegistry({ directory: input.directory, worktree: input.worktree })
      const entry = [...reg.entries.values()].find((e) => path.resolve(e.absPath) === path.resolve(target))
      if (entry) key = entry.key
    } catch {
      // fall back to meta.name for the reported key
    }
  }
  return { ok: true, key, path: target }
}

/** The tool's rendering of {@link promoteSource} — the wording is unchanged by the split. */
async function promote(input: { source: string; save: string; directory?: string; worktree?: string }) {
  const outcome = await promoteSource(input)
  if (outcome.ok) {
    return {
      title: "workflow: promoted",
      output: `Promoted to durable Workflow "${outcome.key}" at ${outcome.path}.\nRun it now with workflow({ name: "${outcome.key}", args }). Its /${commandNameForKey(outcome.key)} command appears after the next opencode reload.`,
      metadata: { key: outcome.key, path: outcome.path },
    }
  }
  if (outcome.kind === "conflict") return { title: "workflow: save conflict", output: outcome.message }
  if (outcome.kind === "invalid-name") return { title: "workflow: invalid save name", output: outcome.message }
  return failResult(new Error(outcome.message))
}

/**
 * `save.run` — promote a JOURNALED run's script to a durable workflow, from the run browser.
 *
 * The interesting case is a run that ended in an earlier session: inline source a model wrote, which worked,
 * and which would otherwise exist only inside a finished tool call. The journal kept it verbatim, so keeping
 * it is a copy rather than a reconstruction.
 *
 * The save name is the run's own `meta.name`, not a prompt: the registry key is derived from `meta.name`
 * regardless, so offering a choice here would only let a user file a workflow under a name it does not answer
 * to.
 */
async function saveJournaledRun(
  runId: string,
  journal: Journal,
  paths: { directory?: string; worktree?: string },
): Promise<ControlResult> {
  const record = await journal.read(runId)
  if (!record) return { ok: false, reason: "unknown-run" }
  if (record.run.provenance === "durable") {
    return { ok: false, reason: "conflict", detail: `${record.run.workflow} is already a durable workflow` }
  }
  if (!record.source) {
    return { ok: false, reason: "unknown-run", detail: "the journal kept no script for that run" }
  }
  const outcome = await promoteSource({ source: record.source, save: record.run.workflow, ...paths })
  if (outcome.ok) return { ok: true, detail: `saved as "${outcome.key}" — run it by name` }
  return { ok: false, reason: outcome.kind === "conflict" ? "conflict" : "unsupported", detail: outcome.message }
}

export const WorkflowPlugin: Plugin = async ({ client, directory, worktree, serverUrl }, options) => {
  const workflowClient = createWorkflowClient({ client, directory, serverUrl })
  const store = createRunStore()
  // The journal lives in the PROJECT, not in the state directory: a run's record belongs beside the workflows
  // that produced it, so it moves with the repository, is visible to `git status`, and is trivially deletable.
  // Without a resolved root there is nowhere honest to put it, so history is simply absent.
  const journalDirectory = worktree || directory
  const journal = journalDirectory ? createJournal(journalRoot(journalDirectory)) : null
  const unsubscribeJournal = journal ? subscribeJournal(store, journal) : null
  // One registry per plugin instance, shared by every run it starts and by the endpoint that exposes them.
  // Built unconditionally — it is the runs' cancellation bookkeeping, not a transport concern, so a host with
  // no endpoint still gets units whose in-flight prompts are addressable.
  const control = createControlRegistry({
    ...(journal ? { save: (runId: string) => saveJournaledRun(runId, journal, { directory, worktree }) } : {}),
    // Answering an AGENT-raised interaction has to leave this process; answering a SCRIPT one never does. The
    // registry tries its own per-run sink first and falls through to here, so `POST /control` has exactly one
    // path and a surface never has to know which kind it is settling.
    interactions: createInteractionController(workflowClient, store),
  })
  // A real host always supplies serverUrl. Partial structural PluginInput doubles deliberately do not; avoid
  // opening an orphan server for those initialization-only tests while retaining default-on production.
  const endpoint = serverUrl
    ? await startEndpoint(store, dashboardOptions(options), { control, ...(journal ? { history: journal } : {}) })
    : null
  /**
   * Is anyone watching? An open SSE subscriber is the whole signal.
   *
   * Read per poll rather than captured once, because it changes during a run: a terminal opens, a dashboard tab
   * closes. With no endpoint at all the answer is a flat no, which is the correct headless behaviour — and the
   * reason `background` and `opencode serve` runs keep the watcher ladder byte-for-byte.
   */
  const attached = () => endpoint?.attached() ?? false
  let descriptorStatePath: string | null = null
  if (endpoint) {
    descriptorStatePath = opencodeStatePath()
    if (descriptorStatePath && directory && worktree) {
      try {
        await writeDescriptor(descriptorStatePath, {
          url: endpoint.url,
          token: endpoint.token,
          pid: process.pid,
          directory,
          worktree,
          startedAt: Date.now(),
        })
      } catch (error) {
        await endpoint.stop()
        throw error
      }
    }
  }
  return {
    dispose: async () => {
      unsubscribeJournal?.()
      if (descriptorStatePath) await removeDescriptor(descriptorStatePath)
      await endpoint?.stop()
    },
    // Inject slash commands by mutating `cfg.command` in the `config` hook — the only channel (no
    // command-registration hook exists), and it fires BEFORE opencode lazily builds the Command registry off
    // this same cached config object (verified live by the injection probe). Two layers, both `??=` so a
    // user-defined command of the same name always wins:
    //   1. ONE live `/workflow` fallback — resolves the workflow name from $ARGUMENTS at execute-time, so a
    //      workflow added MID-SESSION is reachable via a command without a reload.
    //   2. ONE `/<name>` command per workflow discovered at init (named with opencode's nested convention:
    //      key `a:b` → `/a/b`). These are FROZEN for the instance lifetime (the command registry is built
    //      once per process), so a workflow added later won't get its own command until a reload — it stays
    //      reachable via `/workflow` and the tool meanwhile.
    config: async (cfg) => {
      const c = cfg as { command?: Record<string, { template: string; description?: string }> }
      c.command ??= {}
      c.command.workflow ??= {
        template: WORKFLOW_COMMAND_TEMPLATE,
        description: "Run a durable Workflow by name (live; also discoverable as per-workflow /<name> commands).",
      }
      // Discover workflows and inject one command each. Guarded: opencode logs-then-swallows a throwing config
      // hook (→ zero commands), and discovery imports every module on the startup critical path, so a bad scan
      // must still leave the live `/workflow` fallback in place rather than wiping all command injection.
      if (!directory) return
      try {
        const reg = await buildRegistry({ directory, worktree })
        for (const entry of reg.entries.values()) {
          c.command[commandNameForKey(entry.key)] ??= {
            template: perWorkflowTemplate(entry),
            description: `Workflow: ${entry.meta.description}`,
          }
        }
      } catch {
        // keep the /workflow fallback; per-workflow commands are best-effort at init
      }
    },
    tool: {
      workflow: tool({
        description: WORKFLOW_TOOL_DESCRIPTION,
        args: {
          name: tool.schema.string().optional().describe("Run a registered DURABLE Workflow by its registry key (see `list`)."),
          source: tool.schema.string().optional().describe("Run INLINE ad-hoc Workflow source: export default defineWorkflow({...})."),
          args: tool.schema.any().optional().describe("JSON value exposed to the Workflow as `args` (validated against meta.args)."),
          list: tool.schema.boolean().optional().describe("List available durable Workflows (keys + descriptions + args schema) and return without running."),
          save: tool.schema.string().optional().describe("Promote: save the inline `source` verbatim to <project>/.opencode/workflows/<save>.ts (may include `/` for a namespace) and return its registry key."),
          status: tool.schema.string().optional().describe("Report a Run's state by its runId — live from memory, or from the on-disk journal after a restart."),
          result: tool.schema.string().optional().describe("Return a completed Run's consolidated result by its runId (from the journal); its status if it is still running."),
        },
        async execute(input, ctx) {
          // LIST mode — discover durable Workflows across scopes; no Run. Rebuilt per call so a just-written
          // or edited file is reflected immediately (the plugin owns discovery; opencode's own registries are
          // frozen per process).
          if (input.list) {
            try {
              return listResult(await buildRegistry({ directory, worktree }))
            } catch (error) {
              return failResult(error)
            }
          }

          // RETRIEVAL modes — read a Run that is running elsewhere, or that finished in another session. Both
          // are answered before the run modes because they never start anything: they are the safe questions.
          if (input.status) {
            try {
              return await statusResult(input.status, store, journal)
            } catch (error) {
              return failResult(error)
            }
          }
          if (input.result) {
            try {
              return await resultResult(input.result, store, journal)
            } catch (error) {
              return failResult(error)
            }
          }

          // PROMOTE mode — persist inline `source` as a durable Workflow; no Run.
          if (input.save) {
            if (!input.source) {
              return { title: "workflow: nothing to save", output: "`save` requires `source` (the inline Workflow module to persist)." }
            }
            try {
              return await promote({ source: input.source, save: input.save, directory, worktree })
            } catch (error) {
              return failResult(error)
            }
          }

          const common = {
            args: normalizeArgs(input.args), // un-stringify args from the workflow-provider seam (see normalizeArgs)
            client: workflowClient,
            parentSessionID: ctx.sessionID,
            signal: ctx.abort, // forward opencode's tool-abort signal → ctx.signal (stops launching queued Units)
            store,
            control, // …and let a surface outside this session stop the run or one of its units
            attached, // …and give a watching human first refusal on the questions it raises
            ...(journal ? { journal } : {}), // …and let it outlive this process as a record
          }

          try {
            // RUN BY NAME — resolve the live registry (rebuilt per call so a just-written/edited durable file is
            // found with no restart) and run the matching file. An unknown name lists what IS registered.
            if (input.name) {
              const reg = await buildRegistry({ directory, worktree })
              const entry = reg.entries.get(input.name)
              if (!entry) {
                const known = [...reg.entries.keys()].sort()
                return {
                  title: "workflow: unknown name",
                  output: `No durable Workflow named "${input.name}".\nRegistered: ${known.length ? known.join(", ") : "(none)"}.\nCall workflow({ list: true }) for descriptions + args schemas.`,
                }
              }
              try {
                const runId = crypto.randomUUID()
                const mirror = createNativeProgressMirror(ctx, store, runId)
                try {
                  const out = await runWorkflowFromFile(entry.absPath, { ...common, runId, provenance: "durable" })
                  // The terminal store snapshot, read AFTER the orchestrator applied `run.ended`: it is the only
                  // carrier of the run's final status, wall-clock, and token spend for the summary line.
                  return runResult(out, store.get(runId))
                } finally {
                  mirror.stop()
                }
              } catch (error) {
                // Echo the expected schema on an arg-validation miss so the model fixes `args` first-try
                // (rather than guessing field names). Other errors fall through to the outer catch.
                const msg = error instanceof Error ? error.message : String(error)
                if (msg.startsWith("invalid args")) {
                  const schema = argsSchemaOf(entry.meta.args)
                  return { title: "workflow: invalid args", output: schema ? `${msg}\nExpected args JSON Schema: ${JSON.stringify(schema)}` : msg }
                }
                throw error
              }
            }

            // RUN AD-HOC — inline source.
            if (input.source) {
              const runId = crypto.randomUUID()
              const mirror = createNativeProgressMirror(ctx, store, runId)
              try {
                const out = await runWorkflow({ source: input.source, ...common, runId, provenance: "inline" })
                return runResult(out, store.get(runId))
              } finally {
                mirror.stop()
              }
            }

            return {
              title: "workflow: nothing to run",
              output: "Provide one of: `name` (run a registered Workflow), `source` (run ad-hoc), or `list: true` (discover Workflows).",
            }
          } catch (error) {
            return failResult(error)
          }
        },
      }),
    },
  }
}

export default { id: PLUGIN_ID, server: WorkflowPlugin }
