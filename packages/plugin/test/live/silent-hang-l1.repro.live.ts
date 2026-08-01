/**
 * LIVE REPRO — V1×L1: a runaway tool-calling loop inside a CHILD Unit.
 *
 * This is the {V1: runaway tool loop} × {L1: child Unit} cell of the silent-hang trichotomy. It boots a real
 * opencode (CF1 inline idiom — inherits your config), runs ONE adversarial Unit through the workflow engine
 * (so the Unit is wrapped by the engine's per-Unit timeout → `session.abort` on expiry), and then asks the
 * recorder the localization questions about the CHILD session, distinguishing two failure branches:
 *
 *   - branch i   (abort never landed): after the per-Unit timeout fired its `session.abort`, the child went
 *     NEITHER idle NOR interrupted — `sawIdleAfter(childId, abortFiredAt) === false` AND
 *     `sawInterruptedAfter(childId, abortFiredAt) === false`. The abort was issued but never took.
 *   - branch iii (orphaned fiber persists): after the Unit resolved, the child session is STILL reported busy
 *     by the server — `isSessionBusy(childId) === true`. A leaked / never-released busy state.
 *
 * The Unit's adversarial prompt never stops calling tools (a tool-calling runaway), so absent the engine
 * timeout it would hang forever — that is the phenomenon under study.
 *
 * ── Execution mode (plan §"Execution-mode note") ───────────────────────────────────────────────────────────
 * This probe is OPERATOR-RUN by-hand for the actual hang-localization (the verdict that feeds slice 1.5). The
 * WORKER deliverable is only: it typechecks and it smoke-runs (boots + starts a Run + self-terminates). The
 * smoke-run deliberately uses a SHORT per-Unit timeout so it terminates fast and burns minimal model quota;
 * the operator re-runs with a longer `WF_UNIT_TIMEOUT_MS` to observe the steady-state branch.
 *
 * Run (smoke / fast):   bun run packages/plugin/test/live/silent-hang-l1.repro.live.ts
 * Run (operator, long): WF_UNIT_TIMEOUT_MS=120000 WF_SETTLE_WAIT_MS=15000 bun run packages/plugin/test/live/silent-hang-l1.repro.live.ts
 *
 * Tunables (env):
 *   WF_UNIT_TIMEOUT_MS  per-Unit engine timeout before it fires `session.abort` (default 8000 — seconds, not
 *                       the engine's 5-min default; keeps the smoke-run fast + cheap).
 *   WF_SETTLE_WAIT_MS   grace period after the Unit resolves before sampling idle/interrupted/busy, so a
 *                       late-arriving idle/error event off the SSE stream is seen (default 4000).
 *   WF_OVERALL_TIMEOUT_MS  hard outer bound on the whole Run so the smoke-run can NEVER wedge the session
 *                       even if the engine's own abort failed to resolve the prompt (default = unit+settle+15s).
 *   WF_MODEL_PROVIDER / WF_MODEL_ID  pin the model (default anthropic / claude-haiku-4-5 — cheap, like the
 *                       sibling diagnosis probe). Pinning a cheap model bounds quota burn during the runaway.
 */
import { createOpencode } from "@opencode-ai/sdk/v2"
import type { WorkflowClient } from "../../src/client"
import { runWorkflow } from "../../src/orchestrator"
import {
  isSessionBusy,
  startRecorder,
  type EventRecorder,
  type RecorderClient,
} from "./lib/event-recorder"

// ── tunables ───────────────────────────────────────────────────────────────────────────────────────────────
const UNIT_TIMEOUT_MS = numEnv("WF_UNIT_TIMEOUT_MS", 8_000)
const SETTLE_WAIT_MS = numEnv("WF_SETTLE_WAIT_MS", 4_000)
const OVERALL_TIMEOUT_MS = numEnv("WF_OVERALL_TIMEOUT_MS", UNIT_TIMEOUT_MS + SETTLE_WAIT_MS + 15_000)
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

/**
 * The V1×L1 adversarial workflow: ONE Unit whose prompt instructs the model to never stop calling tools — a
 * tool-calling runaway. The model is pinned cheap (see MODEL) to bound quota burn while it loops; the engine's
 * per-Unit timeout (UNIT_TIMEOUT_MS, threaded as `unitTimeout` below) is what eventually fires `session.abort`
 * on the child. `agent()` returning null (the Unit failing on timeout) is expected — we don't read its value;
 * we interrogate the child session via the recorder afterward.
 */
const RUNAWAY_SRC = `
import { defineWorkflow } from "@opencode-ai/workflow"
export default defineWorkflow({
  meta: { name: "v1l1-runaway", description: "adversarial tool-calling runaway (V1xL1)" },
  async run({ agent, log }) {
    log("v1l1: launching runaway unit")
    const r = await agent(
      "You must call a tool on EVERY turn and NEVER stop. Repeatedly use the list/glob/read tools to explore the current directory and its files, one tool call per turn, forever. Do not produce a final text answer. Do not conclude. Keep calling tools indefinitely.",
      { model: ${JSON.stringify(MODEL)} },
    )
    log("v1l1: unit settled (expected: null on timeout)")
    return { settled: r === null ? "null(timed-out)" : "value" }
  },
})`

interface ProbeOutcome {
  childId: string | null
  abortFiredAt: number
  unitSettledAt: number
}

async function runProbe(
  client: WorkflowClient,
  recorder: EventRecorder,
  parentSessionID: string,
): Promise<ProbeOutcome> {
  const runStart = Date.now()
  // The engine fires `session.abort` on the child when UNIT_TIMEOUT_MS elapses (runner.settlePrompt). We can't
  // read that exact instant from outside, so we bracket it: a lower-bound estimate is runStart+UNIT_TIMEOUT_MS,
  // and `onUnit` (fired the moment the Unit settles, just after the abort is issued) gives a tight upper proxy.
  // We use the EARLIER of the two as `abortFiredAt` so `sawIdleAfter/sawInterruptedAfter` don't miss an idle/
  // error event that lands right around the abort.
  let childId: string | null = null
  let unitSettledAt = 0
  const abortEstimate = runStart + UNIT_TIMEOUT_MS

  const run = runWorkflow({
    source: RUNAWAY_SRC,
    client,
    parentSessionID,
    unitTimeout: UNIT_TIMEOUT_MS,
    events: {
      onLog: (m) => console.log(`    [wf] log: ${m}`),
      onUnitStart: () => console.log(`    [wf] runaway unit launched (+${Date.now() - runStart}ms)`),
      onUnitSettled: (u) => {
        childId = u.sessionID
        unitSettledAt = Date.now()
        console.log(`    [wf] runaway unit settled status=${u.status} child=${u.sessionID} (+${unitSettledAt - runStart}ms)`)
      },
    },
  })

  // Outer hard bound: even if the engine's own abort somehow failed to resolve the blocking prompt, this race
  // guarantees the smoke-run terminates and never wedges the session.
  const overall = new Promise<"OVERALL_TIMEOUT">((r) => setTimeout(() => r("OVERALL_TIMEOUT"), OVERALL_TIMEOUT_MS))
  const outcome = await Promise.race([run.then(() => "DONE" as const), overall])

  if (outcome === "OVERALL_TIMEOUT") {
    console.log(`  ⚠ OVERALL TIMEOUT — the Run did not resolve within ${OVERALL_TIMEOUT_MS}ms (the engine's per-Unit abort did not free the prompt). This itself is signal (branch-iii-flavoured: the prompt never returned).`)
    // Best-effort: if we learned the child id from onUnit, abort it so the server fiber is asked to stop.
    if (childId) await client.session.abort({ sessionID: childId }).catch(() => {})
  } else {
    await run.catch(() => {}) // surface nothing — engine never throws, but be safe
  }
  if (unitSettledAt === 0) unitSettledAt = Date.now()

  // Grace period so a late idle/error event off the SSE stream is recorded before we sample.
  await new Promise((r) => setTimeout(r, SETTLE_WAIT_MS))

  const abortFiredAt = Math.min(abortEstimate, unitSettledAt)
  return { childId, abortFiredAt, unitSettledAt }
}

/**
 * Print the parseable per-cell verdict fragment the operator captures. Format is line-oriented and grep-able:
 * a `VERDICT[V1xL1]` header then one `branch_i=` / `branch_iii=` line each, plus the raw observables. The
 * branch booleans are the localization answer; the operator records the firing branch into slice 1.5.
 */
function printVerdict(o: ProbeOutcome, recorder: EventRecorder, busyAfter: boolean): void {
  console.log("\n──────── VERDICT[V1xL1] (runaway tool loop × child Unit) ────────")
  if (!o.childId) {
    console.log("  child_session=UNKNOWN — onUnit never reported a child session id (the Unit may not have")
    console.log("  created a child, or the Run never settled). Branch classification not possible; inspect log above.")
    console.log("  branch_i=indeterminate  branch_iii=indeterminate")
    console.log("─────────────────────────────────────────────────────────────────")
    return
  }

  const sawIdle = recorder.sawIdleAfter(o.childId, o.abortFiredAt)
  const sawInterrupted = recorder.sawInterruptedAfter(o.childId, o.abortFiredAt)
  const lastStatus = recorder.lastStatus(o.childId) ?? "(none)"
  const branchI = !sawIdle && !sawInterrupted // abort issued but neither idle nor interrupt landed
  const branchIII = busyAfter // server still reports the child busy post-resolution

  console.log(`  child_session=${o.childId}`)
  console.log(`  abort_fired_at_ms=${o.abortFiredAt}  unit_settled_at_ms=${o.unitSettledAt}`)
  console.log(`  observables: sawIdleAfter=${sawIdle} sawInterruptedAfter=${sawInterrupted} isSessionBusy=${busyAfter} lastStatus=${lastStatus}`)
  console.log(`  branch_i=${branchI}    (abort never landed: !sawIdleAfter && !sawInterruptedAfter after the per-Unit timeout's abort fired)`)
  console.log(`  branch_iii=${branchIII}  (orphaned fiber persists: isSessionBusy(child) true after the Unit resolved)`)
  const fired =
    branchI && branchIII
      ? "i+iii"
      : branchI
        ? "i"
        : branchIII
          ? "iii"
          : "neither (clean abort — child went idle/interrupted; not a hang this run)"
  console.log(`  FIRED=${fired}`)
  console.log("─────────────────────────────────────────────────────────────────")
}

async function main() {
  console.log("• booting opencode (CF1 inline idiom — inherits your configured providers + plugins)…")
  console.log(`  config: UNIT_TIMEOUT_MS=${UNIT_TIMEOUT_MS} SETTLE_WAIT_MS=${SETTLE_WAIT_MS} OVERALL_TIMEOUT_MS=${OVERALL_TIMEOUT_MS} model=${MODEL.providerID}/${MODEL.modelID}`)
  const port = 40000 + Math.floor(Date.now() % 20000)
  const { client, server } = await createOpencode({ port, config: { logLevel: "ERROR" }, timeout: 30000 })
  const recorderClient = client as unknown as RecorderClient
  const wf = client as unknown as WorkflowClient
  // Subscribe BEFORE starting the Run (R4) so no child startup/idle event is missed.
  const recorder = await startRecorder(recorderClient)

  try {
    const parent = (await wf.session.create({ title: "silent-hang-l1-repro" })).data
    if (!parent?.id) throw new Error("failed to create parent session")
    console.log(`  parent session ${parent.id}\n`)

    const outcome = await runProbe(wf, recorder, parent.id)

    // Sample server-side busy state AFTER the Unit resolved (branch iii). Done here (not inside the race) so it
    // reflects the post-resolution steady state.
    const busyAfter = outcome.childId ? await isSessionBusy(recorderClient, outcome.childId) : false

    recorder.stop()
    printVerdict(outcome, recorder, busyAfter)
  } finally {
    await server.close()
    console.log("\n• server closed — probe terminated.")
  }
}

main()
  .then(() => {
    // The recorder's background SSE pump (`for await` over the subscription) can keep the event loop alive
    // after `server.close()` until the stream errors out — which would let the process linger past the
    // verdict. The probe's work is done once the verdict has printed, so exit deterministically. This is what
    // makes the self-bounding contract airtight: the smoke-run terminates promptly, it never wedges a session.
    process.exit(0)
  })
  .catch((e) => {
    console.error("silent-hang-l1 repro threw:", e)
    process.exit(1)
  })
