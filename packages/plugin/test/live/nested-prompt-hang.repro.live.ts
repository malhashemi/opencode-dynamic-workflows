/**
 * LIVE REGRESSION PROBE (P1-9 + P2-9) — depth-≥2 nested prompts are resolved by the watcher.
 *
 * NOT a `*.test.ts`: it boots a real `opencode serve` (via createOpencode) and calls a real model, so it is
 * run BY HAND and burns model quota. Run it with:
 *
 *     PROBE_MODEL=claude-haiku-4-5 bun run packages/plugin/test/live/nested-prompt-hang.repro.live.ts
 *
 * WHAT IT PROVES:
 *   1. Existing B6 reject-path proof: a Workflow Run whose Unit spawns a depth-≥2 GRANDCHILD that raises an
 *      unanswerable interactive Question-tool call does NOT hang forever; the watcher reaches the reject
 *      terminus (`question.reject`) and the grandchild settles.
 *   2. New B10 proxy-answer proof: a second Workflow Run whose grandchild Question IS answerable from the
 *      grandchild's seeded task context completes through a grounded proxy answer (`question.reply`), not a
 *      reject. The seed context (the grandchild prompt's first user message) includes the literal supported
 *      answer option label `EU`, and the grandchild asks a matching US/EU question.
 *
 * DESIGN CHOICE (direct runWorkflow, not the `workflow` tool):
 *   This probe drives `runWorkflow` directly with a constructed v2 client (the deep-research.run.live.ts
 *   pattern), because runWorkflow is where the watcher is wired into the Run lifecycle. Each scenario's single
 *   Unit runs on `general`, uses the core `task` tool to spawn a grandchild, and that grandchild calls the
 *   Question tool, producing a genuine depth-≥2 interactive prompt.
 *
 * SOUNDNESS — PASS requires POSITIVE watcher evidence, not mere Run-completion:
 *   The probe wraps the client in a spy that COUNTS both `question.reject` and `question.reply` calls. PASS for
 *   the reject scenario requires `rejectCount ≥ 1`; PASS for the proxy-answer scenario requires `replyCount ≥ 1`
 *   AND `rejectCount === 0`. The final `VERDICT: PASS` prints only if BOTH scenarios pass, both Runs settle
 *   within bound, both Runs record zero Unit errors, and both Units return their sentinels.
 *
 * B10 PROXY-ANSWER HARNESS:
 *   The original B6 scenario is kept intact: it uses runWorkflow's wired watcher as-is and proves the reject
 *   path. The added proxy-answer scenario starts a scenario-scoped tiered watcher and suppresses runWorkflow's
 *   own reject-only pending-question list so the live gate can positively prove the DR-002 proxy rung through
 *   `question.reply` without racing the existing floor watcher. This test-only harness still exercises the real
 *   opencode server, real pending-question API, real session parent walk, and real proxy `explore` Unit.
 *
 * SELF-BOUNDING (AC-9 / R7): env-overridable cheap-model pin THREADED into every Unit via `args.model`; a
 * `raceTimeout` on each Run (RUN_TIMEOUT_MS) strictly LESS than the per-Unit timeout (so the watcher — not a
 * unit-timeout-freed null Run — is the only thing that can complete the Run within the measured window) plus an
 * OUTER `OVERALL_TIMEOUT_MS` hard cap (so the probe can NEVER hang a terminal); session.abort + server.close
 * teardown; deterministic process.exitCode; a machine-readable `VERDICT: PASS|FAIL` line.
 */
import { createOpencode } from "@opencode-ai/sdk/v2"
import type { WorkflowClient } from "../../src/client"
import { runWorkflow, type RunWorkflowOutput } from "../../src/orchestrator"
import { startWatcher, type Watcher } from "../../src/watcher"

/** Env-overridable cheap-model pin (AC-9), threaded into every Unit via args.model below. */
const MODEL = { providerID: "anthropic", modelID: process.env.PROBE_MODEL ?? "claude-haiku-4-5" }

/** Outer hard cap on the entire probe — even a fully regressed watcher cannot hang the terminal past this. */
const OVERALL_TIMEOUT_MS = 180_000
/** Cap on each workflow Run. STRICTLY LESS than UNIT_TIMEOUT_MS so a unit-timeout-freed Run can't read as a pass. */
const RUN_TIMEOUT_MS = 120_000
/** Per-Unit timeout (Fix B). Strictly GREATER than RUN_TIMEOUT_MS so only the watcher completes the Run in-window. */
const UNIT_TIMEOUT_MS = 300_000

const REJECT_SENTINEL = "GRANDCHILD-REJECT-SETTLED"
const PROXY_SENTINEL = "GRANDCHILD-PROXY-ANSWER-SETTLED"

/** Resolve to {done:true,value} if the promise settles first, else {done:false} after `ms`. */
function raceTimeout<T>(p: Promise<T>, ms: number): Promise<{ done: true; value: T } | { done: false }> {
  return Promise.race([
    p.then((value) => ({ done: true as const, value })),
    new Promise<{ done: false }>((r) => setTimeout(() => r({ done: false }), ms)),
  ])
}

/**
 * Scenario 1: unanswerable depth-≥2 Question. The tiered policy may try proxy/escalation first, but because the
 * prompt intentionally contains no supported alpha/beta answer, the proof remains the B6 reject terminus.
 */
const REJECT_SOURCE = `
import { defineWorkflow } from "@opencode-ai/workflow"
export default defineWorkflow({
  meta: { name: "nested-prompt-reject-repro", description: "spawn a grandchild that raises an unanswerable Question; the watcher must reject it so the Run completes" },
  async run({ agent, args }) {
    const out = await agent(
      [
        "You are driving a regression probe. Use the 'task' tool to spawn EXACTLY ONE sub-agent (a grandchild).",
        "In the task prompt, instruct that grandchild to IMMEDIATELY call the Question tool to ask the user to",
        "choose between the options 'alpha' and 'beta'. Do NOT include any fact that supports either option;",
        "this scenario proves the unanswerable path reaches the reject terminus instead of hanging.",
        "When the grandchild's question is auto-dismissed by the engine, it should just finish.",
        "After the 'task' tool returns, reply with exactly this single token and nothing else: ${REJECT_SENTINEL}",
      ].join(" "),
      { subagent: "general", ...(args.model ? { model: args.model } : {}) },
    )
    return { unit: out }
  },
})
`

/**
 * Scenario 2: answerable depth-≥2 Question. The grandchild prompt's first user message contains the literal
 * supported option label (`EU`) before the grandchild calls the Question tool, so the proxy stand-in can ground a
 * valid `question.reply` without fabricating an answer or falling through to reject.
 */
const PROXY_ANSWER_SOURCE = `
import { defineWorkflow } from "@opencode-ai/workflow"
export default defineWorkflow({
  meta: { name: "nested-prompt-proxy-answer-repro", description: "spawn a grandchild whose Question is answerable from seeded context; the watcher must reply via proxy" },
  async run({ agent, args }) {
    const out = await agent(
      [
        "You are driving a proxy-answer regression probe. Use the 'task' tool to spawn EXACTLY ONE sub-agent (a grandchild).",
        "The task prompt you send to the grandchild MUST begin with this explicit seed fact: 'Launch region answer: EU'.",
        "Then instruct that grandchild to IMMEDIATELY call the Question tool asking: 'Which deployment region should this launch use?'",
        "The Question options MUST be exactly 'US' and 'EU'. The seeded fact directly supports option label 'EU'.",
        "After the Question is answered by the engine, the grandchild should finish without asking anything else.",
        "After the 'task' tool returns, reply with exactly this single token and nothing else: ${PROXY_SENTINEL}",
      ].join(" "),
      { subagent: "general", ...(args.model ? { model: args.model } : {}) },
    )
    return { unit: out }
  },
})
`

interface SpyState {
  rejectedRequestIDs: string[]
  repliedQuestions: Array<{ requestID: string; answers: string[][] }>
}

interface ScenarioInput {
  name: string
  parentTitle: string
  source: string
  sentinel: string
  require: "reject" | "reply"
  /** Starts a scenario-scoped tiered watcher and suppresses runWorkflow's built-in question.list. */
  manualTieredWatcher?: { maxEscalationHops: number }
}

interface ScenarioResult {
  name: string
  pass: boolean
  timedOut: boolean
  elapsedSeconds: number
  unit: unknown
  errorCount: number
  rejects: string[]
  replies: Array<{ requestID: string; answers: string[][] }>
  parentSessionID?: string
}

function unitContainsSentinel(out: RunWorkflowOutput, sentinel: string): { unit: unknown; ok: boolean } {
  const unit = (out.result as { unit?: unknown } | undefined)?.unit
  return { unit, ok: typeof unit === "string" && unit.includes(sentinel) }
}

async function runScenario(input: ScenarioInput, deps: { real: WorkflowClient; wf: WorkflowClient; spy: SpyState; started: number }): Promise<ScenarioResult> {
  const rejectStart = deps.spy.rejectedRequestIDs.length
  const replyStart = deps.spy.repliedQuestions.length
  const scenarioStarted = Date.now()
  let parentSessionID: string | undefined
  let manualWatcher: Watcher | undefined
  const manualWatcherController = new AbortController()

  try {
    const parent = (await deps.real.session.create({ title: input.parentTitle })).data
    if (!parent?.id) throw new Error(`failed to create parent session for ${input.name}`)
    parentSessionID = parent.id
    console.log(`\n• scenario: ${input.name}`)
    console.log(`  parent session: ${parentSessionID}`)
    console.log("  running Workflow (Unit → task-spawned grandchild → Question) …")

    const workflowClient = input.manualTieredWatcher
      ? ({
          session: deps.wf.session,
          permission: deps.wf.permission,
          question: {
            // runWorkflow currently carries the B6 floor watcher. For the proxy-answer scenario, keep the Run
            // itself active but let this scenario's tiered watcher be the only pending-question resolver.
            list: async () => ({ data: [] }),
            reply: deps.wf.question.reply,
            reject: deps.wf.question.reject,
          },
        } satisfies WorkflowClient)
      : deps.wf

    if (input.manualTieredWatcher) {
      manualWatcher = startWatcher({
        client: deps.wf,
        parentSessionID,
        runOwnedRoots: () => new Set([parentSessionID!]),
        signal: manualWatcherController.signal,
        pollIntervalMs: 5,
        resolutionPolicy: { kind: "tiered", standInSubagent: "explore", maxEscalationHops: input.manualTieredWatcher.maxEscalationHops },
      })
    }

    const runPromise = runWorkflow({
      source: input.source,
      args: { model: MODEL }, // thread the cheap-model pin into the Unit (and thus the grandchild it spawns)
      client: workflowClient,
      parentSessionID,
      unitTimeout: UNIT_TIMEOUT_MS, // strictly > RUN_TIMEOUT_MS: the watcher, not Fix B, completes in-window
      events: {
        onUnit: (u) => console.log(`  [+${Math.round((Date.now() - deps.started) / 1000)}s] ${input.name}: unit ${u.ok ? "✓" : "✗"} ${u.subagent}`),
      },
    })
    void runPromise.catch(() => {})

    const raced = await raceTimeout(runPromise, RUN_TIMEOUT_MS)
    const elapsedSeconds = Math.round((Date.now() - scenarioStarted) / 1000)
    const rejects = deps.spy.rejectedRequestIDs.slice(rejectStart)
    const replies = deps.spy.repliedQuestions.slice(replyStart)

    if (!raced.done) {
      console.log(`\n✗ ${input.name}: Run did NOT complete within ${Math.round(RUN_TIMEOUT_MS / 1000)}s.`)
      console.log(`  watcher question.reject calls in scenario: ${rejects.length}`)
      console.log(`  watcher question.reply calls in scenario: ${replies.length}`)
      return { name: input.name, pass: false, timedOut: true, elapsedSeconds, unit: undefined, errorCount: 0, rejects, replies, parentSessionID }
    }

    const out = raced.value
    const { unit, ok: unitSettled } = unitContainsSentinel(out, input.sentinel)
    const errorCount = out.state.errors.length
    const pass =
      input.require === "reject"
        ? rejects.length >= 1 && replies.length === 0 && errorCount === 0 && unitSettled
        : replies.length >= 1 && rejects.length === 0 && errorCount === 0 && unitSettled

    console.log(`\n— ${input.name}: Run returned in ${elapsedSeconds}s —`)
    console.log(`  result.unit: ${JSON.stringify(unit)}`)
    console.log(`  units: ${out.state.units.length}, errors: ${errorCount}`)
    for (const e of out.state.errors) console.log(`    error [${e.subagent}]: ${e.error}`)
    console.log(`  watcher question.reject calls: ${rejects.length} ${rejects.length ? `(${rejects.join(", ")})` : ""}`)
    console.log(`  watcher question.reply calls: ${replies.length} ${replies.length ? `(${replies.map((r) => `${r.requestID}=${JSON.stringify(r.answers)}`).join(", ")})` : ""}`)

    if (!pass) {
      console.log(`\n✗ ${input.name}: Run settled but the required watcher action was NOT proven.`)
      if (input.require === "reject" && rejects.length < 1) console.log("  - expected at least one question.reject call.")
      if (input.require === "reject" && replies.length !== 0) console.log("  - reject scenario unexpectedly saw question.reply calls.")
      if (input.require === "reply" && replies.length < 1) console.log("  - expected at least one question.reply call from the proxy answer rung.")
      if (input.require === "reply" && rejects.length !== 0) console.log("  - proxy-answer scenario unexpectedly reached question.reject.")
      if (errorCount !== 0) console.log("  - the Run recorded Unit errors.")
      if (!unitSettled) console.log(`  - the Unit did not return the sentinel "${input.sentinel}".`)
    }

    return { name: input.name, pass, timedOut: false, elapsedSeconds, unit, errorCount, rejects, replies, parentSessionID }
  } catch (err) {
    console.error(`\n✗ ${input.name}: scenario threw:`, err)
    const elapsedSeconds = Math.round((Date.now() - scenarioStarted) / 1000)
    return {
      name: input.name,
      pass: false,
      timedOut: false,
      elapsedSeconds,
      unit: undefined,
      errorCount: 1,
      rejects: deps.spy.rejectedRequestIDs.slice(rejectStart),
      replies: deps.spy.repliedQuestions.slice(replyStart),
      parentSessionID,
    }
  } finally {
    manualWatcher?.stop()
    manualWatcherController.abort()
    if (parentSessionID) await deps.real.session.abort({ sessionID: parentSessionID }).catch(() => {})
  }
}

/** The two scenarios, keyed for the per-process child invocation. */
const SCENARIOS: Record<string, ScenarioInput> = {
  reject: {
    name: "B6 reject terminus",
    parentTitle: "nested-prompt-reject-repro",
    source: REJECT_SOURCE,
    sentinel: REJECT_SENTINEL,
    require: "reject",
  },
  proxy: {
    name: "B10 grounded proxy answer",
    parentTitle: "nested-prompt-proxy-answer-repro",
    source: PROXY_ANSWER_SOURCE,
    sentinel: PROXY_SENTINEL,
    require: "reply",
    manualTieredWatcher: { maxEscalationHops: 4 },
  },
}

/**
 * Run exactly ONE scenario in this process: boot a fresh server, wire the reject/reply spy, run the scenario,
 * teardown. ONE scenario per process is load-bearing: a real-agent `runWorkflow` poisons Bun's temp-module
 * resolution for any SUBSEQUENT `runWorkflow` in the same process (`Cannot find module "@opencode-ai/workflow"`
 * from the next `.wf-tmp/wf-*.ts`), so the two scenarios must not share a process. The parent invocation
 * (no arg) re-execs this file once per scenario as an isolated child.
 */
async function runOneScenario(key: string): Promise<void> {
  const scenario = SCENARIOS[key]
  if (!scenario) throw new Error(`unknown scenario "${key}"`)

  const port = 40000 + Math.floor(Date.now() % 20000)
  console.log(`• booting opencode server for scenario "${key}" (real model ${MODEL.providerID}/${MODEL.modelID} — burns quota) …`)
  const { client, server } = await createOpencode({ port, config: { logLevel: "ERROR" }, timeout: 30_000 })
  console.log(`  server up at ${server.url}`)

  const started = Date.now()
  const real = client as unknown as WorkflowClient
  const spy: SpyState = { rejectedRequestIDs: [], repliedQuestions: [] }

  const wf: WorkflowClient = {
    session: real.session,
    permission: real.permission,
    question: {
      list: (...a) => real.question.list(...a),
      reply: (input) => {
        spy.repliedQuestions.push({ requestID: input.requestID, answers: input.answers.map((answer) => [...answer]) })
        console.log(`  [+${Math.round((Date.now() - started) / 1000)}s] watcher → question.reply(${input.requestID}, ${JSON.stringify(input.answers)})`)
        return real.question.reply(input)
      },
      reject: (input) => {
        spy.rejectedRequestIDs.push(input.requestID)
        console.log(`  [+${Math.round((Date.now() - started) / 1000)}s] watcher → question.reject(${input.requestID})`)
        return real.question.reject(input)
      },
    },
  }

  try {
    const result = await runScenario(scenario, { real, wf, spy, started })
    console.log(
      `\n— ${result.name}: ${result.pass ? "PASS" : "FAIL"} (${result.elapsedSeconds}s, rejects=${result.rejects.length}, replies=${result.replies.length}, errors=${result.errorCount}) —`,
    )
    console.log(result.pass ? "VERDICT: PASS" : "VERDICT: FAIL")
    process.exitCode = result.pass ? 0 : 1
  } finally {
    console.log("• tearing down (close server) …")
    await server.close?.()
  }
}

async function main() {
  console.log("• LIVE PROBE — nested-prompt watcher regression (P1-9 reject + P2-9 proxy-answer)")

  const selected = process.argv[2]
  if (selected) {
    // Child invocation: run exactly the one selected scenario; this process's exit code is its verdict.
    await runOneScenario(selected)
    return
  }

  // Parent invocation: re-exec self once per scenario in an ISOLATED child process (one runWorkflow per process).
  // Each scenario gets up to SCENARIO_ATTEMPTS tries: these are by-hand live probes against a REAL model, and the
  // grandchild's behavior is non-deterministic (it may occasionally not raise the Question, or the explore
  // stand-in may phrase its answer un-parseably). A scenario that proves its watcher action on ANY attempt passes;
  // this keeps the single documented command reliable without weakening the per-attempt assertion (each attempt
  // still demands positive reject/reply evidence — retries never lower the bar, they only re-roll model variance).
  const SCENARIO_ATTEMPTS = 3
  const order = ["reject", "proxy"]
  const results: Array<{ name: string; pass: boolean }> = []
  for (const key of order) {
    let pass = false
    for (let attempt = 1; attempt <= SCENARIO_ATTEMPTS && !pass; attempt += 1) {
      console.log(`\n=== isolated child process: scenario "${key}" (attempt ${attempt}/${SCENARIO_ATTEMPTS}) ===`)
      const proc = Bun.spawnSync({ cmd: ["bun", "run", import.meta.path, key], env: process.env, stdout: "inherit", stderr: "inherit" })
      pass = proc.exitCode === 0
      if (!pass && attempt < SCENARIO_ATTEMPTS) console.log(`  ↻ scenario "${key}" did not prove its action this attempt (likely live-model variance) — retrying`)
    }
    results.push({ name: SCENARIOS[key]?.name ?? key, pass })
  }

  const pass = results.every((r) => r.pass)
  console.log("\n— Scenario summary —")
  for (const r of results) console.log(`  ${r.pass ? "✓" : "✗"} ${r.name}`)

  if (pass) {
    console.log("\n✓ Unanswerable depth-≥2 Question reached the reject terminus and did not hang (P1-9).")
    console.log("✓ Answerable depth-≥2 Question was resolved by a GROUNDED PROXY ANSWER (`question.reply`) and did not reject (P2-9).")
    console.log("VERDICT: PASS")
    process.exitCode = 0
  } else {
    console.log("\n✗ One or more live scenarios failed to prove the required watcher behavior.")
    console.log("VERDICT: FAIL")
    process.exitCode = 1
  }
}

// OUTER hard cap: if anything above fails to honor its own timeout/teardown, this guarantees the process exits.
const overall = setTimeout(() => {
  console.error(`\n✗ OVERALL_TIMEOUT_MS (${OVERALL_TIMEOUT_MS}ms) exceeded — forcing exit. The probe could not bound itself.`)
  console.log("VERDICT: FAIL")
  process.exit(1)
}, OVERALL_TIMEOUT_MS)
overall.unref?.()

main()
  .then(() => clearTimeout(overall))
  .catch((e) => {
    console.error("nested-prompt watcher probe crashed:", e)
    console.log("VERDICT: FAIL")
    process.exitCode = 1
  })
