/**
 * LIVE DE-RISK EXPERIMENT — KILL VERIFICATION: does `session.abort` REALLY kill a STUCK (stalled-stream)
 * session, or does it merely MARK the session idle while the frozen connection leaks open in the background?
 *
 * ── The question (the whole point of the spike — slice 1.6, rebuilt) ─────────────────────────────────────────
 * We are NOT adding a timeout. Durability is desirable (a Unit may legitimately wait forever on purpose). We
 * are testing the KILL: when we fire `session.abort` at a genuinely stuck session — one whose model call has
 * stalled after headers with the socket held open (the V2 silent hang, see `silent-hang-v2.repro.live.ts`) —
 * does the underlying connection actually DIE? This decides whether we have a reliable ON-DEMAND kill.
 *
 * Research finding under test (CF4): `POST /session/{id}/abort` returns `true` the instant the interrupt is
 * ISSUED and flips run-state to Idle WITHOUT awaiting the fiber unwind — i.e. it MIGHT report idle while the
 * connection leaks. This probe confirms or REFUTES that EMPIRICALLY for the stalled-stream case. We do not
 * trust the finding; we measure it.
 *
 * ── How it works ─────────────────────────────────────────────────────────────────────────────────────────────
 *  1. Boot a real opencode + recorder, define the custom `stallco` provider → local headers-then-stall stub
 *     (identical setup to the V2 probe), and start a one-Unit workflow whose model call lands on the stub and
 *     STALLS. The Unit (and the Run) never resolve — that is the phenomenon.
 *  2. Confirm STUCK: stub received the request AND is holding a stalled socket open AND the run promise is
 *     unresolved AND a CHILD session (≠ the parent) is reported BUSY by `GET /session/status`. That busy child
 *     is the session whose blocking prompt made the stalled model call. (During a true stall the workflow's
 *     `onUnit` never fires, so we cannot learn the child id from the engine events — we DISCOVER it by polling
 *     status for the busy non-parent session, which is the stalled child by construction: one Unit ⇒ one child.)
 *  3. Capture t0, fire `session.abort` at the stuck CHILD (the same mechanism the plugin uses — POST
 *     /session/{id}/abort), record t_abort and the boolean it returned.
 *  4. Observe a bounded window: (i) when/if the child reports idle on the event stream (sawIdleAfter /
 *     lastStatus → "reported killed"); (ii) when/if the stub's held-open socket actually CLOSES ("really
 *     killed"); (iii) isSessionBusy(child) after.
 *  5. VERDICT[KILL] (grep-able): socket closes shortly after abort ⇒ REAL KILL; session reports idle but the
 *     socket stays open through the window ⇒ FAKE KILL / LEAK (CF4 confirmed live).
 *  6. If FAKE/partial: two cheap follow-ups IN THE SAME RUN — (a) does aborting the PARENT too close the
 *     socket? (b) does the orphaned socket EVER close within a longer bounded window, or only at server/process
 *     teardown? — to inform "what a reliable kill needs". Each is bounded; we don't solve the fix here.
 *
 * DETERMINISTIC + QUOTA-FREE: no real model is ever contacted (the baseURL override routes every call to the
 * loopback stub). Self-bounding: a layered overall timeout + process.exit(0) guarantees the probe can NEVER
 * wedge even though the stalled Run never frees its prompt.
 *
 * Run:  bun run packages/plugin/test/live/silent-hang-kill.repro.live.ts
 *
 * Tunables (env):
 *   WF_STUCK_WAIT_MS        max time to poll for the STUCK precondition before sampling anyway (default 8000).
 *   WF_KILL_WINDOW_MS       observation window AFTER the child abort, watching for socket close (default 15000).
 *   WF_LONG_WINDOW_MS       extra window for follow-up (b) — does the orphaned socket EVER close? (default 15000).
 *   WF_OVERALL_TIMEOUT_MS   hard outer bound on the whole probe (default = stuck + kill + long + 30s slack).
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
const STUCK_WAIT_MS = numEnv("WF_STUCK_WAIT_MS", 8_000)
const KILL_WINDOW_MS = numEnv("WF_KILL_WINDOW_MS", 15_000)
const LONG_WINDOW_MS = numEnv("WF_LONG_WINDOW_MS", 15_000)
const OVERALL_TIMEOUT_MS = numEnv("WF_OVERALL_TIMEOUT_MS", STUCK_WAIT_MS + KILL_WINDOW_MS + LONG_WINDOW_MS + 30_000)

/** The CUSTOM provider the probe defines + the Unit targets (no built-in auth loader ⇒ config baseURL routes to
 *  the stall stub). `npm: "@ai-sdk/openai-compatible"` → POST {baseURL}/chat/completions (SSE). Mirrors V2. */
const STALL_PROVIDER_ID = "stallco"
const STALL_MODEL_ID = "stall-model"
const MODEL = { providerID: STALL_PROVIDER_ID, modelID: STALL_MODEL_ID }

function numEnv(name: string, fallback: number): number {
  const raw = process.env[name]
  if (raw === undefined) return fallback
  const n = Number(raw)
  return Number.isFinite(n) && n > 0 ? n : fallback
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

/** Minimal structural view of the SDK surfaces this probe pokes beyond the WorkflowClient/RecorderClient. */
interface AbortableClient {
  session: {
    /** POST /session/{id}/abort → `{ data: boolean }` (CF4): true the instant the interrupt is issued. */
    abort(input: { sessionID: string }): Promise<{ data?: boolean | null } | unknown>
    /** GET /session/status → `{ data: Record<sessionID, { type }> }`. Used to DISCOVER the busy child + sample. */
    status(): Promise<{ data?: Record<string, { type?: string } | undefined> | null } | null>
  }
}

/**
 * The kill workflow: ONE Unit whose model is the stall provider, so the model call is dispatched, headers come
 * back, and the body never arrives — `agent()` blocks awaiting the stream. We give the Unit an enormous own
 * timeout so the STALL (not a per-Unit abort) is what holds; the probe's outer bound is the real termination
 * guarantee. We never read the Unit's value — we interrogate the stub + recorder + status map.
 */
const KILL_SRC = `
import { defineWorkflow } from "@opencode-ai/workflow"
export default defineWorkflow({
  meta: { name: "kill-stall", description: "stalled provider stream, then session.abort the stuck child" },
  async run({ agent, log }) {
    log("kill: launching unit against the stall provider (it will stall after headers)")
    const r = await agent(
      "Say hello in one short sentence.",
      { model: ${JSON.stringify(MODEL)} },
    )
    log("kill: unit settled (NOT expected — the stream stalls until aborted)")
    return { settled: r === null ? "null" : "value" }
  },
})`

/** Read the boolean an abort returned (it lives under `.data`); undefined if the shape was unexpected. */
function abortReturned(res: unknown): boolean | undefined {
  const data = (res as { data?: unknown } | null | undefined)?.data
  return typeof data === "boolean" ? data : undefined
}

/** Poll `GET /session/status` for a BUSY session that is NOT the parent — that is the stalled child Unit's
 *  session (one Unit ⇒ exactly one child). Returns its id, or null if none is busy yet. */
async function findBusyChild(client: AbortableClient, parentSessionID: string): Promise<string | null> {
  const res = await client.session.status()
  const map = res?.data
  if (!map || typeof map !== "object") return null
  for (const [id, st] of Object.entries(map)) {
    if (id !== parentSessionID && st?.type === "busy") return id
  }
  return null
}

interface StuckState {
  /** The discovered stalled child session id (null if we never saw a busy non-parent session — degraded). */
  childId: string | null
  /** Did we confirm the full STUCK precondition (stub hit + socket open + run pending + child busy)? */
  confirmed: boolean
  /** Whether the run promise was still unresolved at confirmation time. */
  runPending: boolean
  /** Snapshot of the stub at confirmation: did it receive a request, is a stalled socket open. */
  stubRequests: number
  stalledSocketOpen: boolean
}

/**
 * Drive the Run to the STUCK precondition. Launches the workflow (does NOT await it — it never resolves),
 * then polls until: the stub received the model call AND is holding a stalled socket open AND the run promise
 * is still pending AND a busy non-parent child session is visible. Returns the discovered child id + the
 * confirmation snapshot. Bounded by STUCK_WAIT_MS — if the precondition is not fully met by then we report
 * what we have (the verdict downgrades to indeterminate, never a wedge).
 */
async function driveToStuck(
  booted: BootedWithRecorder,
  stub: StallProvider,
  parentSessionID: string,
): Promise<StuckState> {
  const client = booted.client as unknown as WorkflowClient
  const abortable = booted.client as unknown as AbortableClient
  const start = Date.now()
  let runPending = true

  const run = runWorkflow({
    source: KILL_SRC,
    client,
    parentSessionID,
    // Enormous per-Unit timeout so the STALL (not a fast unit-timeout abort) is the observed phenomenon; the
    // probe's outer bound is the real termination guarantee.
    unitTimeout: OVERALL_TIMEOUT_MS * 8,
    events: {
      onLog: (m) => console.log(`    [wf] log: ${m}`),
      onUnitStart: () =>
        console.log(`    [wf] unit launched (+${Date.now() - start}ms) — model call → stall stub`),
      onUnitSettled: (u) =>
        console.log(
          `    [wf] unit settled status=${u.status} child=${u.sessionID} (+${Date.now() - start}ms) — UNEXPECTED during a stall`,
        ),
    },
  })
  // Track resolution without awaiting (it should never resolve): the boolean tells the precondition check the
  // run is genuinely still pending when we confirm STUCK.
  void run
    .then(() => {
      runPending = false
    })
    .catch(() => {
      runPending = false
    })

  // Poll for the full precondition.
  let childId: string | null = null
  let confirmed = false
  while (Date.now() - start < STUCK_WAIT_MS) {
    await sleep(250)
    const stubRequests = stub.requestCount()
    const stalledSocketOpen = stub.stalledSocketStillOpen()
    if (childId === null) childId = await findBusyChild(abortable, parentSessionID)
    if (stubRequests > 0 && stalledSocketOpen && runPending && childId !== null) {
      confirmed = true
      break
    }
  }

  return {
    childId,
    confirmed,
    runPending,
    stubRequests: stub.requestCount(),
    stalledSocketOpen: stub.stalledSocketStillOpen(),
  }
}

interface KillObservation {
  /** The boolean `session.abort` returned (CF4 says `true` immediately). undefined if the shape was unexpected. */
  abortReturned: boolean | undefined
  /** Wall-clock at which we fired the child abort. */
  tAbort: number
  /** Wall-clock at which the child first reported idle on the event stream after t_abort, or undefined if never. */
  sessionIdleAt: number | undefined
  /** Wall-clock at which the stub's held-open stalled socket actually closed after t_abort, or undefined if never. */
  socketClosedAt: number | undefined
  /** isSessionBusy(child) sampled at the END of the kill window. */
  busyAfter: boolean
  /** Did the stub still hold a stalled socket open at the END of the kill window? */
  socketStillOpenAfter: boolean
}

/**
 * Fire `session.abort` at the stuck child, then watch a bounded window for the two competing signals:
 *  - the child going idle on the SSE stream (the session is "reported killed"), and
 *  - the stub's held-open stalled socket actually closing (the connection is "really killed").
 * We poll both each tick and stamp the first time each is observed; the window ends at KILL_WINDOW_MS.
 */
async function fireKillAndObserve(
  booted: BootedWithRecorder,
  stub: StallProvider,
  childId: string,
): Promise<KillObservation> {
  const abortable = booted.client as unknown as AbortableClient
  const recorder = booted.recorder

  const tAbort = Date.now()
  console.log(`\n• FIRING session.abort at stuck child ${childId} (t_abort=${tAbort})…`)
  let returned: boolean | undefined
  try {
    returned = abortReturned(await abortable.session.abort({ sessionID: childId }))
  } catch (e) {
    console.log(`  abort threw: ${String(e)}`)
  }
  console.log(`  abort returned: ${returned === undefined ? "(unexpected shape)" : returned}`)

  let sessionIdleAt: number | undefined
  let socketClosedAt: number | undefined
  const deadline = tAbort + KILL_WINDOW_MS
  while (Date.now() < deadline) {
    await sleep(250)
    if (sessionIdleAt === undefined && recorder.sawIdleAfter(childId, tAbort)) {
      sessionIdleAt = Date.now()
      console.log(`  ✎ child reported IDLE on the event stream (+${sessionIdleAt - tAbort}ms after abort)`)
    }
    if (socketClosedAt === undefined) {
      const closed = stub.lastStalledSocketClosedAt()
      if (closed !== undefined && closed >= tAbort) {
        socketClosedAt = closed
        console.log(`  ✎ stalled SOCKET CLOSED at the stub (+${socketClosedAt - tAbort}ms after abort)`)
      }
    }
    // Early exit once BOTH have happened — nothing more to learn this window.
    if (sessionIdleAt !== undefined && socketClosedAt !== undefined) break
  }

  const busyAfter = await isSessionBusy(booted.client as unknown as RecorderClient, childId)
  const socketStillOpenAfter = stub.stalledSocketStillOpen()
  return { abortReturned: returned, tAbort, sessionIdleAt, socketClosedAt, busyAfter, socketStillOpenAfter }
}

/** Classify the kill: REAL (socket closed shortly after abort) vs FAKE/LEAK (idle reported but socket stayed
 *  open through the window) vs PARTIAL (mixed/ambiguous). */
function classifyKill(o: KillObservation): "real" | "fake" | "partial" {
  const socketClosed = o.socketClosedAt !== undefined
  const reportedIdle = o.sessionIdleAt !== undefined
  if (socketClosed) return "real" // the held-open connection actually died ⇒ the abort tore it down
  // socket NEVER closed in the window:
  if (reportedIdle || o.abortReturned === true || !o.busyAfter) return "fake" // marked idle / abort acked, yet leak
  return "partial" // socket open AND no idle signal AND still busy — abort didn't even take effect on state
}

async function main() {
  console.log("• starting stall provider (headers-then-stall HTTP stub — no real model)…")
  const stub = await startStallProvider({ mode: "headers-then-stall" })
  console.log(`  stall provider baseURL=${stub.baseURL}`)

  console.log("• booting opencode with a CUSTOM openai-compatible provider → stall stub (baseURL routing)…")
  console.log(
    `  config: STUCK_WAIT_MS=${STUCK_WAIT_MS} KILL_WINDOW_MS=${KILL_WINDOW_MS} LONG_WINDOW_MS=${LONG_WINDOW_MS} OVERALL_TIMEOUT_MS=${OVERALL_TIMEOUT_MS}`,
  )
  const booted = await bootWithRecorder({
    provider: {
      [STALL_PROVIDER_ID]: {
        npm: "@ai-sdk/openai-compatible",
        name: "Stall Co (kill-verification stub)",
        options: { baseURL: stub.baseURL, apiKey: "stub-no-real-key" },
        models: { [STALL_MODEL_ID]: { name: "Stall Model" } },
      },
    },
  })

  let parentSessionID: string | null = null
  let childIdForCleanup: string | null = null

  try {
    const parent = (await (booted.client as unknown as WorkflowClient).session.create({ title: "silent-hang-kill-repro" })).data
    if (!parent?.id) throw new Error("failed to create parent session")
    parentSessionID = parent.id
    console.log(`  parent session ${parent.id}\n`)

    const abortable = booted.client as unknown as AbortableClient

    // ── Phase 1: drive to STUCK (bounded). The outer race guarantees termination even if this never confirms. ──
    const overall = new Promise<"OVERALL_TIMEOUT">((r) => setTimeout(() => r("OVERALL_TIMEOUT"), OVERALL_TIMEOUT_MS))
    const stuck = await Promise.race([driveToStuck(booted, stub, parent.id).then((s) => ({ s })), overall])
    if (stuck === "OVERALL_TIMEOUT") {
      console.log(`\n  ⚠ OVERALL TIMEOUT before STUCK confirmed (${OVERALL_TIMEOUT_MS}ms). Terminating.`)
      return
    }
    const s = stuck.s
    childIdForCleanup = s.childId
    console.log(
      `\n• STUCK precondition: confirmed=${s.confirmed} child=${s.childId ?? "(none discovered)"} run_pending=${s.runPending} stub_requests=${s.stubRequests} stalled_socket_open=${s.stalledSocketOpen}`,
    )

    if (s.childId === null) {
      console.log(
        "\n  ⚠ Could not DISCOVER a busy child session (no busy non-parent session appeared in /session/status). " +
          "Cannot fire a targeted child abort — the kill experiment needs the stalled child id. Printing degraded verdict.",
      )
      booted.recorder.stop()
      printVerdict(null, s, null, null, stub, parentSessionID)
      return
    }

    // ── Phase 2: fire the kill at the stuck child + observe (bounded). ──
    const obs = await fireKillAndObserve(booted, stub, s.childId)

    // ── Phase 3: follow-ups, only if the child kill was NOT clearly REAL (socket never closed). ──
    let followup: FollowupResult | null = null
    if (obs.socketClosedAt === undefined) {
      followup = await runFollowups(booted, stub, parentSessionID, s.childId)
    } else {
      console.log("\n• child abort already closed the stalled socket (REAL kill) — skipping follow-ups.")
    }

    booted.recorder.stop()
    printVerdict(obs, s, followup, s.childId, stub, parentSessionID)
  } finally {
    // Best-effort: free any sessions still hung on the stall so server.close() isn't fighting an in-flight
    // request, then the stub's own close() destroys whatever held-open socket remains.
    const api = booted.client as unknown as AbortableClient
    if (childIdForCleanup) await api.session.abort({ sessionID: childIdForCleanup }).catch(() => {})
    if (parentSessionID) await api.session.abort({ sessionID: parentSessionID }).catch(() => {})
    await booted.server.close()
    await stub.close()
    console.log("\n• server closed + stall provider stopped — probe terminated.")
  }
}

interface FollowupResult {
  /** Did the orphaned socket close after we ALSO aborted the PARENT? + when (ms after parent abort). */
  parentAbortReturned: boolean | undefined
  socketClosedAfterParentAbortMs: number | undefined
  /** Did the socket EVER close within the extra LONG_WINDOW_MS (without any further teardown)? + when. */
  socketClosedInLongWindowMs: number | undefined
  /** Was the stalled socket still open at the very end of all follow-ups (only the stub's close() will free it)? */
  socketStillOpenAtEnd: boolean
}

/**
 * Two cheap, bounded follow-ups for the FAKE/partial case, to inform "what a reliable kill needs":
 *   (a) abort the PARENT session too — does that change anything (close the orphaned socket)?
 *   (b) keep watching for LONG_WINDOW_MS — does the orphaned socket EVER close on its own, or only when the
 *       server/process tears down (i.e. only the stub's own close() at the end)?
 * Each is bounded; we gather evidence, we do not attempt to fix.
 */
async function runFollowups(
  booted: BootedWithRecorder,
  stub: StallProvider,
  parentSessionID: string,
  childId: string,
): Promise<FollowupResult> {
  const abortable = booted.client as unknown as AbortableClient
  console.log("\n• FOLLOW-UP (a): the child abort did NOT close the stalled socket — aborting the PARENT too…")

  const tParentAbort = Date.now()
  let parentAbortReturned: boolean | undefined
  try {
    parentAbortReturned = abortReturned(await abortable.session.abort({ sessionID: parentSessionID }))
  } catch (e) {
    console.log(`  parent abort threw: ${String(e)}`)
  }
  console.log(`  parent abort returned: ${parentAbortReturned === undefined ? "(unexpected shape)" : parentAbortReturned}`)

  // Also re-abort the child once more (belt-and-suspenders — maybe a second interrupt unwinds it).
  await abortable.session.abort({ sessionID: childId }).catch(() => {})

  let socketClosedAfterParentAbortMs: number | undefined
  let socketClosedInLongWindowMs: number | undefined
  const deadline = tParentAbort + LONG_WINDOW_MS
  while (Date.now() < deadline) {
    await sleep(250)
    const closed = stub.lastStalledSocketClosedAt()
    if (closed !== undefined && closed >= tParentAbort) {
      socketClosedAfterParentAbortMs = closed - tParentAbort
      socketClosedInLongWindowMs = closed - tParentAbort
      console.log(`  ✎ stalled SOCKET CLOSED after parent abort (+${socketClosedAfterParentAbortMs}ms)`)
      break
    }
  }
  if (socketClosedInLongWindowMs === undefined) {
    console.log(
      `  ✎ stalled socket did NOT close within ${LONG_WINDOW_MS}ms after aborting BOTH child and parent — it is orphaned.`,
    )
  }

  return {
    parentAbortReturned,
    socketClosedAfterParentAbortMs,
    socketClosedInLongWindowMs,
    socketStillOpenAtEnd: stub.stalledSocketStillOpen(),
  }
}

/**
 * Print the parseable VERDICT[KILL] block the operator captures — grep-able. Reports the raw observed numbers
 * (abort return, t_abort, idle-at, socket-closed-at, busy-after) and the KILL classification (real|fake|partial),
 * plus the follow-up evidence on whether ANY available primitive reliably closes the stalled connection.
 */
function printVerdict(
  obs: KillObservation | null,
  stuck: StuckState,
  followup: FollowupResult | null,
  childId: string | null,
  stub: StallProvider,
  parentSessionID: string | null,
): void {
  console.log("\n──────── VERDICT[KILL] (does session.abort REALLY kill a stalled-stream session?) ────────")
  console.log(
    `  parent_session=${parentSessionID ?? "(none)"}  child_session=${childId ?? "(none discovered)"}  stuck_confirmed=${stuck.confirmed}`,
  )
  console.log(
    `  precondition: stub_requests=${stuck.stubRequests} stalled_socket_open_at_stuck=${stuck.stalledSocketOpen} run_pending=${stuck.runPending}  socket_opened_at_ms=${stub.firstStalledSocketOpenedAt() ?? "(none)"}`,
  )

  if (obs === null) {
    console.log("  KILL=indeterminate (no targeted child abort fired — the stalled child id was never discovered)")
    console.log("─────────────────────────────────────────────────────────────────────────────────────────")
    return
  }

  const idleAtRel = obs.sessionIdleAt === undefined ? "never" : `${obs.sessionIdleAt - obs.tAbort}ms`
  const socketClosedRel = obs.socketClosedAt === undefined ? "never" : `${obs.socketClosedAt - obs.tAbort}ms`
  const kill = classifyKill(obs)

  // The raw, grep-able numbers requested by the experiment design (§2e).
  console.log(`  abort_returned=${obs.abortReturned === undefined ? "(unexpected shape)" : obs.abortReturned}`)
  console.log(`  t_abort_ms=${obs.tAbort}`)
  console.log(`  session_idle_at_ms=${obs.sessionIdleAt ?? "never"}  (relative: ${idleAtRel} after abort)`)
  console.log(`  socket_closed_at_ms=${obs.socketClosedAt ?? "never"}  (relative: ${socketClosedRel} after abort)`)
  console.log(`  isSessionBusy_after=${obs.busyAfter}`)
  console.log(`  socket_still_open_after_kill_window=${obs.socketStillOpenAfter}`)
  console.log(
    `  interpretation: ${
      kill === "real"
        ? "REAL KILL — the abort tore down the stalled connection (socket closed shortly after abort)."
        : kill === "fake"
          ? "FAKE KILL / LEAK — the session was marked idle / abort ack'd true, but the stalled socket stayed OPEN through the window (CF4 confirmed live: marked idle, connection orphaned)."
          : "PARTIAL — abort neither closed the socket nor flipped the session out of busy within the window (ambiguous)."
    }`,
  )
  console.log(`  KILL=${kill}`)

  // Follow-up evidence: does ANY primitive reliably close the stalled connection?
  if (followup) {
    console.log("  ── follow-ups (FAKE/partial path) ──")
    console.log(
      `  parent_abort_returned=${followup.parentAbortReturned === undefined ? "(unexpected shape)" : followup.parentAbortReturned}`,
    )
    console.log(
      `  socket_closed_after_parent_abort_ms=${followup.socketClosedAfterParentAbortMs ?? "never"}`,
    )
    console.log(
      `  socket_closed_in_long_window_ms=${followup.socketClosedInLongWindowMs ?? "never"}  (long_window=${LONG_WINDOW_MS}ms)`,
    )
    console.log(`  socket_still_open_at_end=${followup.socketStillOpenAtEnd}`)
    const anyPrimitiveClosed =
      followup.socketClosedAfterParentAbortMs !== undefined || followup.socketClosedInLongWindowMs !== undefined
    console.log(
      `  reliable_kill_primitive_found=${anyPrimitiveClosed}  (${
        anyPrimitiveClosed
          ? "some available abort primitive DID close the stalled connection — see numbers above"
          : "NO available abort primitive closed the stalled connection within the bounded windows — only the stub's own server/process teardown frees it. A reliable on-demand kill needs more than session.abort (e.g. a real chunk/idle timeout, or tearing the transport)."
      })`,
    )
  } else if (kill === "real") {
    console.log("  (follow-ups skipped — the child abort itself was a REAL kill.)")
  }
  console.log("─────────────────────────────────────────────────────────────────────────────────────────")
}

main()
  .then(() => {
    // The recorder's background SSE pump can keep the event loop alive after server.close() until the stream
    // errors out. The probe's work is done once the verdict has printed, so exit deterministically — this is
    // what makes the self-bounding contract airtight (the run terminates promptly, never wedges).
    process.exit(0)
  })
  .catch((e) => {
    console.error("silent-hang-kill repro threw:", e)
    process.exit(1)
  })
