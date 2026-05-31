/**
 * LIVE REPRO — V2: a provider stream that STALLS after headers (a stuck/never-arriving model stream).
 *
 * This is the {V2: stuck provider stream} arm of the silent-hang trichotomy. Where V1 (slices 1.2/1.3) is a
 * runaway tool LOOP, V2 is the opposite failure: the model call is dispatched, the provider returns response
 * HEADERS, and then the body never arrives — the stream stalls with the connection still open, and (finding
 * F4) NO default idle/chunk timeout fires to free it. The Unit (and the Run) hang awaiting a chunk forever.
 *
 * Unlike the V1 probes, this one needs NO real model: it defines a CUSTOM openai-compatible provider whose
 * `baseURL` points at a local STALL PROVIDER (`lib/stall-provider.ts`) that emits headers-then-stall, and runs
 * the Unit against THAT provider. So it is DETERMINISTIC and QUOTA-FREE — the stall is forced, not flaky —
 * which lets the worker smoke it CONCLUSIVELY (the stall WILL happen every run), bounded short by the probe's
 * own layered timeout.
 *
 * ── Why a CUSTOM provider (not a baseURL override of `anthropic`) + why F4 holds (charted live; file:line) ──
 *  (0) Built-in OAuth providers ignore a config baseURL: in this environment `anthropic` is OAuth-authenticated
 *      (auth.json type "oauth"), and its auth/SDK loader pins its own endpoint — a `provider.anthropic.options.
 *      baseURL` override does NOT redirect its calls (charted live: a direct prompt with the override still hit
 *      the real endpoint, stub_hits=0). So we instead define a CUSTOM provider id (`stallco`, npm
 *      `@ai-sdk/openai-compatible`) that has NO auth loader to clobber the baseURL. Live-confirmed: the call
 *      lands on the stub as `POST /chat/completions`.
 *  (1) baseURL routing: opencode feeds a config provider's `options.baseURL` straight to the AI-SDK provider as
 *      its `baseURL` (`packages/opencode/src/provider/provider.ts:1573-1594` — `options["baseURL"] ?? model.api
 *      .url`); config providers are re-applied last over autoload (`provider.ts:1455-1463`). The
 *      `@ai-sdk/openai-compatible` SDK then issues `POST {baseURL}/chat/completions` with an SSE response.
 *  (2) no idle timeout (F4): opencode only wraps the SSE stream with a chunk-idle abort when `chunkTimeout` is
 *      set — `chunkAbortCtl` is created ONLY if `typeof chunkTimeout === "number" && chunkTimeout > 0`, and
 *      `if (!chunkAbortCtl) return res` returns the RAW stream (`provider.ts:1613-1660`). `chunkTimeout` /
 *      `headerTimeout` are `Schema.optional` with NO default for a plain custom provider (only built-in `openai`
 *      seeds a header timeout — `provider.ts:207`), and the Bun fetch timeout is explicitly disabled
 *      (`timeout: false`, `provider.ts:1656`). So a post-headers stall has nothing to abort it → the V2 hang.
 *  (3) auth: we set a DUMMY `options.apiKey` so the call is dispatched to the stub rather than short-circuited
 *      on a missing credential — the stub ignores it (it never validates auth; it just stalls).
 *
 * ── Execution mode (plan §"Execution-mode note") ───────────────────────────────────────────────────────────
 * The WORKER deliverable is the instrument: it typechecks and it smoke-runs (stub starts, the Run begins, the
 * model call lands at the stub, the stall is OBSERVED, and the probe self-bounds + terminates). Because the
 * stub is deterministic, the worker smoke ALSO conclusively observes the stall (no real model, no quota). The
 * operator's longer run (raise `WF_STALL_WAIT_MS`) merely confirms the hang persists at steady state.
 *
 * Run (smoke / fast):   bun run packages/plugin/test/live/silent-hang-v2.repro.live.ts
 * Run (operator, long): WF_STALL_WAIT_MS=60000 WF_SETTLE_WAIT_MS=15000 \
 *                         bun run packages/plugin/test/live/silent-hang-v2.repro.live.ts
 *
 * Tunables (env):
 *   WF_STALL_WAIT_MS    how long to wait on the stalled Run before giving up and sampling (default 8000 —
 *                       seconds; the smoke just needs the call dispatched + the stall confirmed, not eternity).
 *   WF_SETTLE_WAIT_MS   grace after the stall wait before sampling idle/busy, so a late SSE status event lands
 *                       (default 4000).
 *   WF_OVERALL_TIMEOUT_MS  hard outer bound on the whole probe so it can NEVER wedge (default = stall + settle
 *                       + 15s). The Run will NOT resolve (that's the phenomenon) — this guarantees termination.
 *   (The provider/model are FIXED to the custom stall provider — there is no real-model knob, by design: V2 is
 *    reproduced deterministically against the stub, never a live model.)
 */
import type { WorkflowClient } from "../../src/client"
import { runWorkflow } from "../../src/orchestrator"
import { startStallProvider, type StallProvider } from "./lib/stall-provider"
import {
  bootWithRecorder,
  isSessionBusy,
  type BootedWithRecorder,
  type EventRecorder,
  type RecorderClient,
} from "./lib/event-recorder"

// ── tunables ───────────────────────────────────────────────────────────────────────────────────────────────
const STALL_WAIT_MS = numEnv("WF_STALL_WAIT_MS", 8_000)
const SETTLE_WAIT_MS = numEnv("WF_SETTLE_WAIT_MS", 4_000)
const OVERALL_TIMEOUT_MS = numEnv("WF_OVERALL_TIMEOUT_MS", STALL_WAIT_MS + SETTLE_WAIT_MS + 15_000)

/** The CUSTOM provider the probe defines + the Unit targets. A fresh id (no built-in auth loader) so the
 *  config `baseURL` reliably routes to the stall stub. `npm: "@ai-sdk/openai-compatible"` → POST
 *  {baseURL}/chat/completions (SSE). */
const STALL_PROVIDER_ID = "stallco"
const STALL_MODEL_ID = "stall-model"
const MODEL = { providerID: STALL_PROVIDER_ID, modelID: STALL_MODEL_ID }

function numEnv(name: string, fallback: number): number {
  const raw = process.env[name]
  if (raw === undefined) return fallback
  const n = Number(raw)
  return Number.isFinite(n) && n > 0 ? n : fallback
}

/**
 * The V2 workflow: ONE Unit whose prompt would, under a real provider, stream a normal answer. Here the Unit's
 * model is the custom stall provider, so the model call is dispatched, headers come back, and the body never
 * arrives — `agent()` blocks awaiting the stream. We give the Unit a generous own-timeout so the STALL (not a
 * fast per-Unit abort) is what the probe observes; the probe's outer bound is the real guarantee of
 * termination. We don't read the Unit's value — we interrogate the stub + recorder afterward.
 */
const V2_SRC = `
import { defineWorkflow } from "@opencode-ai/workflow"
export default defineWorkflow({
  meta: { name: "v2-stall", description: "stalled provider stream (V2 — headers then no body)" },
  async run({ agent, log }) {
    log("v2: launching unit against the stall provider")
    const r = await agent(
      "Say hello in one short sentence.",
      { model: ${JSON.stringify(MODEL)} },
    )
    log("v2: unit settled (NOT expected within the smoke window — the stream stalls)")
    return { settled: r === null ? "null" : "value" }
  },
})`

interface ProbeOutcome {
  /** The child Unit session id, IF onUnit fired (it will NOT during a true stall — left null then). */
  childId: string | null
  /** Whether the Run resolved within STALL_WAIT_MS (false ⇒ it is stalled — the F4 phenomenon). */
  runResolved: boolean
  /** Requests the stub received (>0 ⇒ the model call was dispatched to the stub — the Run began + NO real model). */
  stubRequests: number
  /** Path of the last request the stub saw (e.g. /v1/messages) — confirms it was the model call. */
  stubLastPath: string | undefined
  /** Wall-clock at which we stopped waiting on the Run (the sampling instant for "after"). */
  sampledAt: number
}

async function runProbe(
  booted: BootedWithRecorder,
  stub: StallProvider,
  parentSessionID: string,
): Promise<ProbeOutcome> {
  const client = booted.client as unknown as WorkflowClient
  const start = Date.now()
  let childId: string | null = null

  // Launch the Run. Its single Unit's model call routes to the stall stub (via the baseURL override threaded
  // into the boot config) → headers back → body withheld → the Unit blocks awaiting a chunk. The Run promise
  // therefore does NOT resolve within the smoke window; we observe the stall rather than await completion.
  const run = runWorkflow({
    source: V2_SRC,
    client,
    parentSessionID,
    // Generous per-Unit timeout so the STALL is the observed phenomenon, not a fast unit-timeout abort. The
    // probe's outer bound (below) is the real termination guarantee — the Unit itself is meant to hang here.
    unitTimeout: OVERALL_TIMEOUT_MS * 4,
    events: {
      onLog: (m) => console.log(`    [wf] log: ${m}`),
      onUnitStart: () => console.log(`    [wf] v2 unit launched (+${Date.now() - start}ms) — model call → stall stub`),
      // Fires only if the Unit settles (it should NOT during the stall) — we record the child id if it ever does.
      onUnit: (u) => {
        childId = u.sessionID
        console.log(`    [wf] v2 unit settled ok=${u.ok} child=${u.sessionID} (+${Date.now() - start}ms) — UNEXPECTED during a stall`)
      },
    },
  })
  void run.catch(() => {}) // swallow — the engine never throws; we observe via the stub + recorder, not the return.

  // Wait for the Run to resolve, OR give up after STALL_WAIT_MS (the expected path: it is stalled). Either way
  // we then sample. We poll the stub's request count so we can report the EXACT moment the model call landed.
  const stallWait = new Promise<"WAIT_ELAPSED">((r) => setTimeout(() => r("WAIT_ELAPSED"), STALL_WAIT_MS))
  const raced = await Promise.race([run.then(() => "RUN_DONE" as const), stallWait])
  const runResolved = raced === "RUN_DONE"
  console.log(
    runResolved
      ? `  Run RESOLVED within ${STALL_WAIT_MS}ms (UNEXPECTED — the stub should have stalled it).`
      : `  Run still pending after ${STALL_WAIT_MS}ms (EXPECTED for V2 — the provider stream stalled; sampling).`,
  )

  // Grace so a late idle/status event off the SSE stream is recorded before we sample.
  await new Promise((r) => setTimeout(r, SETTLE_WAIT_MS))
  const sampledAt = Date.now()
  console.log(`  (probe elapsed +${sampledAt - start}ms)  stub_requests=${stub.requestCount()} last_path=${stub.lastPath() ?? "(none)"}`)

  return {
    childId,
    runResolved,
    stubRequests: stub.requestCount(),
    stubLastPath: stub.lastPath(),
    sampledAt,
  }
}

/**
 * Print the parseable per-cell verdict fragment the operator captures — grep-able, mirroring the slice 1.2/1.3
 * VERDICT[...] blocks but tagged VERDICT[V2]. The V2 localization answer is `stalled_no_idle_timeout`: the model
 * call was DISPATCHED to the stub (stub_requests>0), the provider returned headers and withheld the body, and
 * the Run never resolved AND the session never went idle — i.e. the stream stalled with no idle timeout firing
 * (F4). Because the stub is deterministic, this fires on the worker smoke itself (no real model, quota-free).
 */
function printVerdict(o: ProbeOutcome, recorder: EventRecorder, parentSessionID: string, childBusyAfter: boolean | null): void {
  console.log("\n──────── VERDICT[V2] (stalled provider stream — headers then no body, no idle timeout) ────────")
  // The model call reaching the stub is the "Run began + real model NOT hit" signal: every byte went to the
  // loopback stub, not Anthropic.
  const stubReceivedCall = o.stubRequests > 0
  // Did ANY session go idle after the Run started? For V2 the answer must be NO — the stall means no completion.
  // We check the parent (always known) and the child Unit session (known only if onUnit fired — null otherwise).
  const sawParentIdle = recorder.sawIdleAfter(parentSessionID, 0)
  const sawChildIdle = o.childId ? recorder.sawIdleAfter(o.childId, 0) : false
  const lastParentStatus = recorder.lastStatus(parentSessionID) ?? "(none)"

  console.log(`  parent_session=${parentSessionID}  child_session=${o.childId ?? "(unsettled — onUnit never fired, expected during a stall)"}`)
  console.log(`  stub_requests=${o.stubRequests}  stub_last_path=${o.stubLastPath ?? "(none)"}  real_model_hit=NO (all calls routed to the loopback stall stub)`)
  console.log(`  run_resolved=${o.runResolved}  sampled_at_ms=${o.sampledAt}`)
  console.log(
    `  observables: stubReceivedCall=${stubReceivedCall} runResolved=${o.runResolved} sawIdleAfter(parent)=${sawParentIdle} sawIdleAfter(child)=${sawChildIdle} isSessionBusy(child)=${childBusyAfter === null ? "(child unknown)" : childBusyAfter} lastStatus(parent)=${lastParentStatus}`,
  )
  // Branch: the stream stalled and no idle timeout fired. Premise: the call was dispatched to the stub
  // (stubReceivedCall), the Run did NOT resolve, and NOTHING went idle (neither parent nor child) — the stall
  // is unbroken by any default timeout (F4).
  const branchStall = stubReceivedCall && !o.runResolved && !sawParentIdle && !sawChildIdle
  console.log(
    `  branch_stalled_no_idle_timeout=${branchStall}  (model call dispatched to stub && run never resolved && no session went idle ⇒ post-headers stall with no idle timeout firing — F4)`,
  )
  const fired = branchStall
    ? "stalled_no_idle_timeout (V2 reproduced — deterministic, no real model)"
    : !stubReceivedCall
      ? "indeterminate (the model call never reached the stub — baseURL routing did not engage; inspect log above)"
      : o.runResolved || sawParentIdle || sawChildIdle
        ? "neither (the Run resolved or a session went idle — the stall did not hold this run; inspect log)"
        : "indeterminate (call dispatched but stall classification ambiguous; inspect observables)"
  console.log(`  FIRED=${fired}`)
  console.log("──────────────────────────────────────────────────────────────────────────────────────────────")
}

async function main() {
  console.log("• starting stall provider (headers-then-stall HTTP stub — no real model)…")
  const stub = await startStallProvider({ mode: "headers-then-stall" })
  console.log(`  stall provider baseURL=${stub.baseURL}`)

  // Point the named provider's baseURL at the stub + a dummy apiKey so the call is dispatched (not short-
  // circuited on a missing credential). bootWithRecorder shallow-merges this onto { logLevel: "ERROR" } and
  // subscribes the recorder BEFORE returning (R4) — so no early child/idle status event is missed.
  console.log("• booting opencode with a CUSTOM openai-compatible provider → stall stub (baseURL routing)…")
  console.log(
    `  config: STALL_WAIT_MS=${STALL_WAIT_MS} SETTLE_WAIT_MS=${SETTLE_WAIT_MS} OVERALL_TIMEOUT_MS=${OVERALL_TIMEOUT_MS} provider=${MODEL.providerID} model=${MODEL.modelID}`,
  )
  // Define a CUSTOM provider (fresh id, openai-compatible npm) whose baseURL is the stall stub. A custom id has
  // no built-in auth loader to pin/override the endpoint, so the config baseURL reliably routes here
  // (live-confirmed: POST /chat/completions lands on the stub). bootWithRecorder shallow-merges this onto
  // { logLevel: "ERROR" } and subscribes the recorder BEFORE returning (R4) — so no early status event is missed.
  const booted = await bootWithRecorder({
    provider: {
      [STALL_PROVIDER_ID]: {
        npm: "@ai-sdk/openai-compatible",
        name: "Stall Co (V2 repro stub)",
        options: { baseURL: stub.baseURL, apiKey: "stub-no-real-key" },
        models: { [STALL_MODEL_ID]: { name: "Stall Model" } },
      },
    },
  })

  let childIdForAbort: string | null = null
  let parentSessionID: string | null = null

  try {
    const parent = (await (booted.client as unknown as {
      session: { create(a: unknown): Promise<{ data?: { id: string } | null }> }
    }).session.create({ body: { title: "silent-hang-v2-repro" } })).data
    if (!parent?.id) throw new Error("failed to create parent session")
    parentSessionID = parent.id
    console.log(`  parent session ${parent.id}\n`)

    // Hard outer bound: the Run will NOT resolve (that is the phenomenon), so this race is the real termination
    // guarantee — it can NEVER wedge even though the stalled Run never frees its prompt.
    const overall = new Promise<"OVERALL_TIMEOUT">((r) => setTimeout(() => r("OVERALL_TIMEOUT"), OVERALL_TIMEOUT_MS))
    const outcome = await Promise.race([runProbe(booted, stub, parent.id).then((o) => ({ o })), overall])

    if (outcome === "OVERALL_TIMEOUT") {
      console.log(
        `\n  ⚠ OVERALL TIMEOUT — the probe did not finish sampling within ${OVERALL_TIMEOUT_MS}ms (even the sampling path was starved). This itself is V2-flavoured signal (the stall never freed anything). Terminating.`,
      )
      return
    }

    childIdForAbort = outcome.o.childId
    // Sample the child Unit session's busy state AFTER the stall wait, IF we learned its id. During a true
    // stall onUnit never fires, so this is usually unknown (null) — the verdict leans on the stub + idle
    // observables, which are sufficient for the V2 localization.
    const childBusyAfter = outcome.o.childId
      ? await isSessionBusy(booted.client as unknown as RecorderClient, outcome.o.childId)
      : null

    booted.recorder.stop()
    printVerdict(outcome.o, booted.recorder, parent.id, childBusyAfter)
  } finally {
    // Best-effort: free any sessions still hung on the stall so server.close() isn't fighting an in-flight
    // request. The stall stub's own close() then destroys the held-open socket.
    const api = booted.client as unknown as { session: { abort(i: { path: { id: string } }): Promise<unknown> } }
    if (childIdForAbort) await api.session.abort({ path: { id: childIdForAbort } }).catch(() => {})
    if (parentSessionID) await api.session.abort({ path: { id: parentSessionID } }).catch(() => {})
    await booted.server.close()
    await stub.close()
    console.log("\n• server closed + stall provider stopped — probe terminated.")
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
    console.error("silent-hang-v2 repro threw:", e)
    process.exit(1)
  })
