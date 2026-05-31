/**
 * LIVE REPRO — V1×L2: a runaway tool-calling loop reached THROUGH the `workflow` tool from an AGENT session.
 *
 * This is the {V1: runaway tool loop} × {L2: agent session} cell of the silent-hang trichotomy. Where the
 * slice-1.2 L1 probe ran the runaway Unit DIRECTLY through the engine (so the engine's per-Unit timeout
 * wraps it), this L2 probe goes one level UP: it boots a real opencode WITH THE WORKFLOW PLUGIN LOADED,
 * creates a TOP-LEVEL agent session (no parentID), and prompts that agent to invoke the runaway workflow via
 * the `workflow` TOOL (`workflow({ name: "runaway" })`). The hang under study at L2 lives ABOVE the per-Unit
 * wrapper — in the agent's own prompt/tool-execution loop:
 *
 *   - branch ii (agent session wedged above the per-Unit timeout): the TOP-LEVEL agent session stays `busy`
 *     even though NO child Unit is in flight. The engine's per-Unit timeout fires `session.abort` on the
 *     child (so the child Unit settles / goes not-busy), the `workflow` tool's `execute` returns — and YET the
 *     agent session never leaves `busy` / never goes idle. The wedge is in the layer that drives the agent's
 *     tool call (the `session.prompt` that issued `workflow(...)` never resolved), not in the Unit.
 *
 * The runaway payload is the durable fixture `fixtures/runaway.workflow.ts` (meta.name "runaway"); see that
 * file for why it is a separate durable module rather than inline source (the L2 cell REQUIRES reaching the
 * runaway through the discoverable `workflow` tool).
 *
 * ── Mechanism charted (R5) ─────────────────────────────────
 *  (a) Plugin load: createOpencode({ config: { plugin: [absPath] } }) spawns a server that loads the plugin;
 *      the plugin's `directory`/`worktree` (the registry-scan roots) default to the server's process.cwd().
 *  (b) Toolset inclusion: `Hooks.tool` tools are exposed to every agent with no allow-list; the built-in
 *      `general` agent seeds `"*":"allow"` (deny-listing only `todowrite`), so it sees `workflow` with ZERO
 *      config. (We also pass an explicit prompt-body `tools: { workflow: true }` belt-and-braces.)
 *  (c) Discovery binding: the plugin scans `.ts` files under `<cwd>/.opencode/workflows/`. We `process.chdir()` into a
 *      temp project holding a COPY of the runaway fixture there, BEFORE boot, so the plugin discovers it by
 *      name. (The durable loader re-materializes the bytes inside the plugin's own package tree, so
 *      `@opencode-ai/workflow` resolves regardless of where the temp copy sits.)
 *  (d) Trigger: opencode's `toolChoice` cannot NAME a tool (only auto/required/none), so a named tool call
 *      cannot be forced — the agent is steered to call `workflow` by INSTRUCTION (the prompt text), the same
 *      way the plugin's own /workflow command template works.
 *
 * ── Execution mode (plan §"Execution-mode note") ───────────────────────────────────────────────────────────
 * OPERATOR-RUN by-hand for the actual hang-localization (the verdict that feeds slice 1.5). The WORKER
 * deliverable is only: it typechecks and it smoke-runs (boots + loads the plugin + creates the top-level agent
 * session + issues the prompt + self-terminates), burning minimal cheap-model quota. The operator re-runs with
 * a longer `WF_PROMPT_WAIT_MS` / `WF_UNIT_TIMEOUT_MS` to observe whether branch ii fires in steady state.
 *
 * Run (smoke / fast):   bun run packages/plugin/test/live/silent-hang-l2.repro.live.ts
 * Run (operator, long): WF_PROMPT_WAIT_MS=180000 WF_UNIT_TIMEOUT_MS=120000 WF_SETTLE_WAIT_MS=15000 \
 *                         bun run packages/plugin/test/live/silent-hang-l2.repro.live.ts
 *
 * Tunables (env):
 *   WF_PROMPT_WAIT_MS   how long to wait on the agent's `session.prompt` before giving up on it and sampling
 *                       the agent session's busy/idle state (default 12000 — seconds; the smoke just needs the
 *                       prompt ISSUED + the agent to start calling the tool, not the full hang to play out).
 *   WF_UNIT_TIMEOUT_MS  per-Unit engine timeout passed to the runaway durable workflow via meta.unitTimeout is
 *                       NOT directly settable from here (the durable file owns its own); instead this bounds
 *                       the SMOKE by capping the prompt wait. The operator's long run raises WF_PROMPT_WAIT_MS.
 *   WF_SETTLE_WAIT_MS   grace after the prompt wait before sampling idle/busy, so a late SSE status event is
 *                       seen (default 4000).
 *   WF_OVERALL_TIMEOUT_MS  hard outer bound on the whole probe so it can NEVER wedge (default = promptWait +
 *                       settle + 20s).
 *   WF_MODEL_PROVIDER / WF_MODEL_ID  pin the agent's model (default anthropic / claude-haiku-4-5 — cheap).
 *                       The runaway fixture reads the same env for its own Unit model.
 */
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import {
  bootWithRecorder,
  isSessionBusy,
  type BootedWithRecorder,
  type EventRecorder,
  type RecorderClient,
} from "./lib/event-recorder"

// ── tunables ───────────────────────────────────────────────────────────────────────────────────────────────
const PROMPT_WAIT_MS = numEnv("WF_PROMPT_WAIT_MS", 12_000)
const SETTLE_WAIT_MS = numEnv("WF_SETTLE_WAIT_MS", 4_000)
const OVERALL_TIMEOUT_MS = numEnv("WF_OVERALL_TIMEOUT_MS", PROMPT_WAIT_MS + SETTLE_WAIT_MS + 20_000)
const MODEL = {
  providerID: process.env.WF_MODEL_PROVIDER ?? "anthropic",
  modelID: process.env.WF_MODEL_ID ?? "claude-haiku-4-5",
}

function numEnv(name: string, fallback: number): number {
  const raw = process.env[name]
  if (raw === undefined) return fallback
  const n = Number(raw)
  return Number.isFinite(n) && n > 0 ? n : fallback
}

/** The registry key the agent is told to run. Top-level durable file → key is the bare `meta.name`. */
const RUNAWAY_KEY = "runaway"

/**
 * The instruction that steers the agent to call the `workflow` tool. `toolChoice` cannot name a tool in
 * opencode (auto/required/none only), so the trigger is INSTRUCTION — phrased imperatively and unambiguously,
 * mirroring the plugin's own /workflow command template. We name the exact tool + the exact `name` arg so the
 * model has nothing to guess.
 */
const AGENT_PROMPT =
  `Call the \`workflow\` tool right now with exactly these arguments: { "name": "${RUNAWAY_KEY}" }. ` +
  `Do not call any other tool first, do not call \`workflow\` with \`list\`, and do not paste any source — ` +
  `just run the durable workflow named "${RUNAWAY_KEY}" by name. After the tool returns, reply with the word done.`

/** Minimal structural view of the SDK's session surface we drive directly (the recorder client narrows the rest). */
interface SessionApi {
  session: {
    create(input: { body?: { parentID?: string; title?: string } }): Promise<{ data?: { id: string } | null }>
    prompt(input: {
      path: { id: string }
      body: {
        agent?: string
        model?: { providerID: string; modelID: string }
        parts: { type: "text"; text: string }[]
        tools?: Record<string, boolean>
      }
    }): Promise<unknown>
    abort(input: { path: { id: string } }): Promise<unknown>
  }
}

interface ProbeOutcome {
  /** The top-level AGENT session id (no parentID) — the L2 subject. */
  agentSessionID: string
  /** Whether the agent's `session.prompt` resolved within PROMPT_WAIT_MS (false ⇒ it is still hung). */
  promptResolved: boolean
  /** Wall-clock at which we stopped waiting on the prompt (the sampling instant for "after"). */
  sampledAt: number
}

/**
 * Stage the runaway fixture as a DISCOVERABLE durable workflow inside a fresh temp project, and `chdir` into
 * it so the to-be-booted plugin scans it. Returns the project dir + a restore() that chdirs back and removes
 * the temp tree. We copy the canonical fixture's BYTES (read from this package) rather than re-authoring it,
 * so the committed fixture stays the single source of truth.
 */
async function stageRunawayProject(): Promise<{ project: string; restore: () => Promise<void> }> {
  const fixturePath = path.resolve(import.meta.dir, "fixtures/runaway.workflow.ts")
  const source = await readFile(fixturePath, "utf8")
  const project = await mkdtemp(path.join(os.tmpdir(), "wf-l2-proj-"))
  const dest = path.join(project, ".opencode", "workflows", "runaway.workflow.ts")
  await mkdir(path.dirname(dest), { recursive: true })
  await writeFile(dest, source, "utf8")
  const origCwd = process.cwd()
  process.chdir(project) // the spawned `opencode serve` inherits cwd → this temp project = the registry-scan root
  return {
    project,
    restore: async () => {
      process.chdir(origCwd)
      await rm(project, { recursive: true, force: true })
    },
  }
}

async function runProbe(booted: BootedWithRecorder): Promise<ProbeOutcome> {
  const api = booted.client as unknown as SessionApi
  const start = Date.now()

  // TOP-LEVEL agent session — NO parentID. This is the L2 subject: the session whose own prompt/tool loop we
  // suspect wedges ABOVE the per-Unit timeout.
  const created = (await api.session.create({ body: { title: "silent-hang-l2-repro" } })).data
  if (!created?.id) throw new Error("failed to create top-level agent session")
  const agentSessionID = created.id
  console.log(`  top-level agent session ${agentSessionID} (no parentID)\n`)

  // Issue the prompt that steers the agent to call workflow({ name: "runaway" }). We pass an explicit toolset
  // (`tools: { workflow: true }`) belt-and-braces — `general` already sees it, this just removes all doubt.
  console.log(`  prompting agent to call workflow({ name: "${RUNAWAY_KEY}" })…`)
  const prompt = api.session.prompt({
    path: { id: agentSessionID },
    body: {
      agent: "general",
      model: MODEL,
      parts: [{ type: "text", text: AGENT_PROMPT }],
      tools: { workflow: true },
    },
  })
  void (prompt as Promise<unknown>).catch(() => {}) // swallow — we observe via the recorder, not the return value

  // Wait for the agent prompt to resolve, OR give up after PROMPT_WAIT_MS (the smoke just needs it ISSUED +
  // the tool call begun; the full L2 hang is the operator's long run). Either way we then sample the agent
  // session's busy/idle state.
  const promptWait = new Promise<"WAIT_ELAPSED">((r) => setTimeout(() => r("WAIT_ELAPSED"), PROMPT_WAIT_MS))
  const raced = await Promise.race([(prompt as Promise<unknown>).then(() => "PROMPT_DONE" as const), promptWait])
  const promptResolved = raced === "PROMPT_DONE"
  console.log(
    promptResolved
      ? `  agent prompt RESOLVED within ${PROMPT_WAIT_MS}ms (the tool call returned to the agent loop).`
      : `  agent prompt still pending after ${PROMPT_WAIT_MS}ms (expected for L2 — sampling busy/idle state).`,
  )

  // Grace so a late idle/status event off the SSE stream is recorded before we sample.
  await new Promise((r) => setTimeout(r, SETTLE_WAIT_MS))
  const sampledAt = Date.now()
  console.log(`  (probe elapsed +${sampledAt - start}ms)`)
  return { agentSessionID, promptResolved, sampledAt }
}

/**
 * Print the parseable per-cell verdict fragment the operator captures — grep-able, mirroring slice 1.2's
 * VERDICT[...] block but tagged VERDICT[V1xL2]. Branch ii is the localization answer for this cell: the
 * top-level agent session is STILL busy (or never went idle) while NO child Unit is in flight.
 */
function printVerdict(o: ProbeOutcome, recorder: EventRecorder, agentBusyAfter: boolean): void {
  console.log("\n──────── VERDICT[V1xL2] (runaway tool loop × agent session, via the workflow tool) ────────")
  const lastStatus = recorder.lastStatus(o.agentSessionID) ?? "(none)"
  const sawAgentIdle = recorder.sawIdleAfter(o.agentSessionID, 0)
  // For the operator's cross-check: how many distinct sessions the recorder saw events for (the agent plus any
  // child Unit sessions the workflow tool spawned). Branch ii's premise is "agent busy while NO child Unit in
  // flight", so the agent-session-only event trace + busy state is the localization signal; the child count is
  // context the operator reads alongside it in the longer run.
  const agentEventCount = recorder.forSession(o.agentSessionID).length

  console.log(`  agent_session=${o.agentSessionID}  agent_events_recorded=${agentEventCount}`)
  console.log(`  prompt_resolved=${o.promptResolved}  sampled_at_ms=${o.sampledAt}`)
  console.log(
    `  observables: isSessionBusy(agent)=${agentBusyAfter} lastStatus(agent)=${lastStatus} sawIdleAfter(agent)=${sawAgentIdle} promptResolved=${o.promptResolved}`,
  )
  // Branch ii: the agent session is wedged ABOVE the per-Unit timeout — it stays busy / never goes idle even
  // after the workflow tool's Unit would have been aborted, AND its driving prompt has not resolved.
  const branchII = agentBusyAfter && !sawAgentIdle && !o.promptResolved
  console.log(
    `  branch_ii=${branchII}  (agent session wedged above the per-Unit timeout: isSessionBusy(agent) && !sawIdleAfter(agent) && !promptResolved)`,
  )
  // Branch ii needs ALL of {busy, never-idle, prompt-unresolved}. If the agent REACHED idle (sawAgentIdle) or
  // its prompt resolved, the tool call returned cleanly — not an L2 hang this run (the expected smoke baseline,
  // since at the short prompt-wait the cheap model finishes the tool call and the session goes idle). Only an
  // agent that is unresolved AND not-idle but ALSO not-busy at the sample instant is genuinely ambiguous (e.g.
  // sampled in a brief gap, or a non-busy stall) — that narrow case stays "indeterminate" for the operator.
  const fired = branchII
    ? "ii"
    : o.promptResolved || sawAgentIdle
      ? "neither (agent reached idle / the tool call returned cleanly; not an L2 hang this run)"
      : "indeterminate (prompt unresolved, agent neither idle nor observed busy — inspect log; may be a cold-start or a non-busy stall)"
  console.log(`  FIRED=${fired}`)
  console.log("─────────────────────────────────────────────────────────────────────────────────────────")
}

async function main() {
  console.log("• staging runaway durable workflow into a temp project + chdir (so the plugin discovers it)…")
  const staged = await stageRunawayProject()
  const pluginPath = path.resolve(import.meta.dir, "../../src/index.ts")
  console.log(`  project=${staged.project}\n  plugin=${pluginPath}`)
  console.log("• booting opencode WITH the workflow plugin loaded (CF1 inline idiom + plugin-by-path)…")
  console.log(
    `  config: PROMPT_WAIT_MS=${PROMPT_WAIT_MS} SETTLE_WAIT_MS=${SETTLE_WAIT_MS} OVERALL_TIMEOUT_MS=${OVERALL_TIMEOUT_MS} model=${MODEL.providerID}/${MODEL.modelID}`,
  )

  // bootWithRecorder shallow-merges this override onto { logLevel: "ERROR" } and subscribes the recorder
  // BEFORE returning (R4) — so the plugin is loaded AND no early agent/child status event is missed.
  const booted = await bootWithRecorder({ plugin: [pluginPath] })
  let agentSessionID: string | null = null

  try {
    // Hard outer bound: even if the agent prompt never resolves AND sampling somehow blocks, this race
    // guarantees the probe terminates and never wedges. (runProbe is itself internally bounded; this is the
    // belt-and-braces ceiling, matching slice 1.2.)
    const overall = new Promise<"OVERALL_TIMEOUT">((r) => setTimeout(() => r("OVERALL_TIMEOUT"), OVERALL_TIMEOUT_MS))
    const outcome = await Promise.race([runProbe(booted).then((o) => ({ o })), overall])

    if (outcome === "OVERALL_TIMEOUT") {
      console.log(
        `\n  ⚠ OVERALL TIMEOUT — the probe did not finish sampling within ${OVERALL_TIMEOUT_MS}ms. This itself is signal (the agent loop never freed even our sampling path). Terminating.`,
      )
      return
    }

    agentSessionID = outcome.o.agentSessionID
    // Sample server-side busy state of the AGENT session AFTER the prompt wait (branch ii). Done outside the
    // inner race so it reflects the post-wait steady state.
    const agentBusyAfter = await isSessionBusy(booted.client as unknown as RecorderClient, agentSessionID)

    booted.recorder.stop()
    printVerdict(outcome.o, booted.recorder, agentBusyAfter)
  } finally {
    // Best-effort: free the agent session's fiber if it is still hung, so server.close() isn't fighting an
    // in-flight prompt. (The operator's long run leaves this to the hard outer bound.)
    if (agentSessionID) {
      await (booted.client as unknown as SessionApi).session.abort({ path: { id: agentSessionID } }).catch(() => {})
    }
    await booted.server.close()
    await staged.restore()
    console.log("\n• server closed + temp project removed — probe terminated.")
  }
}

main()
  .then(() => {
    // The recorder's background SSE pump can keep the event loop alive after server.close() until the stream
    // errors out. The probe's work is done once the verdict has printed, so exit deterministically — this is
    // what makes the self-bounding contract airtight (the smoke-run terminates promptly, never wedges).
    process.exit(0)
  })
  .catch((e) => {
    console.error("silent-hang-l2 repro threw:", e)
    process.exit(1)
  })
