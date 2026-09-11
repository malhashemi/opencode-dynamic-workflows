/**
 * The dashboard's state: a pure reducer plus the live connector that drives it.
 *
 * `reduceDashboard` replicates the blessed revision handshake `packages/plugin/src/tui/client.ts` implements —
 * open `/events` first, fetch `/state`, apply only frames newer than the snapshot's revision — rather than
 * inventing a second sync scheme. The split matters for the same reason it did there: the handshake is the part
 * that can silently drop or double-apply an event, so it lives in a pure function a test can drive frame by
 * frame, and `connect()` is only transport.
 *
 * Inherited from the Phase 4 freshness amendment, and binding here: **do not assume a publish reaches a view,
 * and do not put a memo in front of run state.** This module holds run state in one plain signal whose value is
 * a NEW object on every action (so plain `===` invalidation always fires), and the app reads it through a
 * function that also reads a one-second clock — the same belt-and-braces the TUI route wears, because this is
 * the third reactive graph over the same transport and the last one only ever looked right by accident.
 */
import { createSignal, type Accessor } from "solid-js"
import {
  clonePendingInteraction,
  cloneRunSnapshot,
  cloneUnitSnapshot,
  toResolvedInteraction,
  type JournalRecord,
  type RunEvent,
  type RunSnapshot,
  type RunSummary,
} from "./engine"

export interface DashboardState {
  runs: RunSnapshot[]
  history: RunSummary[]
  /** The endpoint's process-local event cursor; `-1` before the first snapshot lands. */
  revision: number
  connected: boolean
}

export type DashboardAction =
  | { type: "snapshot"; runs: RunSnapshot[]; revision: number }
  /** One SSE frame. `revision` is the frame's `id:`; a non-finite value means the frame carried none. */
  | { type: "event"; revision: number; event: RunEvent }
  | { type: "history"; history: RunSummary[] }
  | { type: "connection"; connected: boolean }

export function initialDashboardState(): DashboardState {
  return { runs: [], history: [], revision: -1, connected: false }
}

/** Running first, then newest first — the same order every other surface lists runs in. */
function sortRuns(runs: RunSnapshot[]): RunSnapshot[] {
  return runs.sort((a, b) => {
    if (a.status === "running" && b.status !== "running") return -1
    if (a.status !== "running" && b.status === "running") return 1
    return b.startedAt - a.startedAt || a.runId.localeCompare(b.runId)
  })
}

/**
 * Fold one event into the run list, immutably: untouched runs keep their identity, the touched one is cloned.
 *
 * The folds are the same ones `reduceRunEvent` performs for the TUI — including keeping a resolved interaction
 * as a record rather than filtering it out, so an answer given from this dashboard does not vanish from it.
 */
function applyRunEvent(runs: RunSnapshot[], event: RunEvent): RunSnapshot[] {
  if (event.type === "run.started" || event.type === "run.ended") {
    const next = runs.filter((run) => run.runId !== event.run.runId)
    next.push(cloneRunSnapshot(event.run))
    return sortRuns(next)
  }
  const index = runs.findIndex((run) => run.runId === event.runId)
  // An event for a run the snapshot never carried is applied to nothing; the next resync brings the run whole.
  if (index === -1) return runs
  const run = cloneRunSnapshot(runs[index] as RunSnapshot)
  if (event.type === "run.phase") {
    run.currentPhase = event.value
    if (!run.phases.includes(event.value)) run.phases.push(event.value)
  } else if (event.type === "run.log") {
    run.logs.push(event.value)
  } else if (event.type === "interaction.pending") {
    const interaction = clonePendingInteraction(event.interaction)
    if (interaction.phase === null || interaction.phase === undefined) interaction.phase = run.currentPhase
    const at = run.interactions.findIndex((candidate) => candidate.requestID === interaction.requestID)
    if (at === -1) run.interactions.push(interaction)
    else run.interactions[at] = interaction
  } else if (event.type === "interaction.resolved") {
    const settled = run.interactions.find((candidate) => candidate.requestID === event.requestID)
    if (settled) {
      run.interactions = run.interactions.filter((candidate) => candidate.requestID !== event.requestID)
      run.resolved.push(
        toResolvedInteraction(settled, { answers: event.answers, by: event.by, outcome: event.outcome }),
      )
    }
  } else {
    const unit = cloneUnitSnapshot(event.unit)
    const at = run.units.findIndex((candidate) => candidate.unitId === unit.unitId)
    if (at === -1) run.units.push(unit)
    else run.units[at] = unit
    run.units.sort((a, b) => a.ordinal - b.ordinal)
  }
  const next = [...runs]
  next[index] = run
  return sortRuns(next)
}

export function reduceDashboard(state: DashboardState, action: DashboardAction): DashboardState {
  if (action.type === "connection") {
    return state.connected === action.connected ? state : { ...state, connected: action.connected }
  }
  if (action.type === "history") {
    return {
      ...state,
      history: [...action.history].sort((a, b) => b.startedAt - a.startedAt || a.runId.localeCompare(b.runId)),
    }
  }
  if (action.type === "snapshot") {
    return { ...state, runs: sortRuns(action.runs.map(cloneRunSnapshot)), revision: action.revision }
  }
  // The revision handshake: a frame the snapshot already contains is DROPPED, not re-applied. A frame with no
  // id is applied without advancing the cursor — the endpoint always stamps one, but a reducer that threw away
  // an un-stamped event would be inventing a stricter contract than the transport has.
  if (Number.isFinite(action.revision) && action.revision <= state.revision) return state
  return {
    ...state,
    runs: applyRunEvent(state.runs, action.event),
    revision: Number.isFinite(action.revision) ? action.revision : state.revision,
  }
}

export interface ConnectOptions {
  baseUrl: string
  /** Absent on loopback — the endpoint answers bare there. Present only for a non-loopback bind's link. */
  token?: string | null
  fetch?: typeof fetch
}

/**
 * How much of the machine the rail is looking at — the dashboard's half of the TUI's `w` cycle.
 *
 * No `session` member: the dashboard has no session of its own, so its honest floor is the project (the
 * endpoint that served it). `everywhere` is merged SERVER-side (`?scope=everywhere`): the endpoint reads its
 * peers' descriptors, folds their `/state` and `/history` into its own answers, and tags each foreign row with
 * an `origin`, so this client keeps exactly one connection either way.
 */
export type DashboardScope = "project" | "everywhere"

const EVENT_TYPES = new Set([
  "run.started",
  "run.ended",
  "run.phase",
  "run.log",
  "unit.queued",
  "unit.started",
  "unit.settled",
  "interaction.pending",
  "interaction.resolved",
])

function looksLikeRunEvent(value: unknown): value is RunEvent {
  return (
    typeof value === "object" &&
    value !== null &&
    "type" in value &&
    EVENT_TYPES.has((value as { type: unknown }).type as string)
  )
}

/** Parse SSE frames off a response body, handing each data frame's revision and payload to `onFrame`. */
async function consumeSse(
  response: Response,
  onFrame: (revision: number, event: RunEvent) => void,
): Promise<void> {
  if (!response.body) throw new Error("workflow endpoint returned no SSE body")
  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let pending = ""
  try {
    while (true) {
      const chunk = await reader.read()
      if (chunk.done) break
      pending += decoder.decode(chunk.value, { stream: true }).replaceAll("\r\n", "\n")
      let boundary = pending.indexOf("\n\n")
      while (boundary >= 0) {
        const frame = pending.slice(0, boundary)
        pending = pending.slice(boundary + 2)
        boundary = pending.indexOf("\n\n")
        const data = frame
          .split("\n")
          .filter((line) => line.startsWith("data:"))
          .map((line) => line.slice(5).trimStart())
          .join("\n")
        if (!data) continue
        const idLine = frame.split("\n").find((line) => line.startsWith("id:"))
        const revision = idLine ? Number(idLine.slice(3).trim()) : Number.NaN
        try {
          const event: unknown = JSON.parse(data)
          if (looksLikeRunEvent(event)) onFrame(revision, event)
        } catch {
          // One malformed frame must not kill the live stream.
        }
      }
    }
  } finally {
    reader.releaseLock()
  }
}

function abortableDelay(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve()
  return new Promise((resolve) => {
    const timer = setTimeout(done, ms)
    const onAbort = () => done()
    function done() {
      clearTimeout(timer)
      signal.removeEventListener("abort", onAbort)
      resolve()
    }
    signal.addEventListener("abort", onAbort, { once: true })
  })
}

/**
 * Drive {@link reduceDashboard} from a live endpoint: SSE first, snapshot second, resync on every reconnect.
 *
 * Events emitted while the `/state` request is in flight stay buffered in the SSE response body — the stream is
 * not read until the snapshot has been dispatched — which closes the subscribe/snapshot race exactly the way
 * the TUI client closes it. The reducer's revision cursor then drops whatever the snapshot already contained.
 */
/** How often the `everywhere` scope re-merges its peers — they have no SSE into this client, only re-reads. */
const EVERYWHERE_POLL_MS = 3_000

export function connect(options: ConnectOptions): {
  state: Accessor<DashboardState>
  setScope(scope: DashboardScope): void
  stop(): void
} {
  const fetcher = options.fetch ?? globalThis.fetch.bind(globalThis)
  const headers: Record<string, string> = options.token ? { authorization: `Bearer ${options.token}` } : {}
  const [state, setState] = createSignal(initialDashboardState())
  const controller = new AbortController()
  const dispatch = (action: DashboardAction) => setState((current) => reduceDashboard(current, action))

  let scope: DashboardScope = "project"
  const scopeQuery = (joiner: "?" | "&" = "?") => (scope === "everywhere" ? `${joiner}scope=everywhere` : "")

  const fetchHistory = async () => {
    try {
      const response = await fetcher(`${options.baseUrl}/history${scopeQuery()}`, {
        headers,
        signal: controller.signal,
      })
      if (!response.ok) return
      const body: unknown = await response.json()
      const history =
        typeof body === "object" && body !== null && "history" in body && Array.isArray(body.history)
          ? (body.history as RunSummary[])
          : []
      dispatch({ type: "history", history })
    } catch {
      // History is a nicety beside live state; a failed read keeps the last good list on screen.
    }
  }

  /** One `/state` read dispatched as a snapshot — the bootstrap, the scope switch, and the peer poll alike. */
  const fetchSnapshot = async (): Promise<void> => {
    const stateResponse = await fetcher(`${options.baseUrl}/state${scopeQuery()}`, {
      headers,
      signal: controller.signal,
    })
    if (!stateResponse.ok) throw new Error(`workflow state endpoint returned ${stateResponse.status}`)
    const snapshot: unknown = await stateResponse.json()
    const runs =
      typeof snapshot === "object" && snapshot !== null && "runs" in snapshot && Array.isArray(snapshot.runs)
        ? (snapshot.runs as RunSnapshot[])
        : []
    const revision =
      typeof snapshot === "object" &&
      snapshot !== null &&
      "revision" in snapshot &&
      typeof snapshot.revision === "number" &&
      Number.isInteger(snapshot.revision)
        ? snapshot.revision
        : -1
    dispatch({ type: "snapshot", runs, revision })
  }

  /** An out-of-band re-read, for a scope change or the everywhere poll. Failure keeps the last good state. */
  const resync = async () => {
    try {
      await fetchSnapshot()
    } catch {
      // The SSE loop owns the connection story; a failed side read must not flap `connected`.
    }
    void fetchHistory()
  }

  const run = async () => {
    let backoff = 250
    while (!controller.signal.aborted) {
      let events: Response | null = null
      try {
        // SSE first, snapshot second — and the SAME dance on every reconnect, which is what lets an old tab
        // survive a host restart: the endpoint's revision counter restarts with the process, and re-basing on
        // the fresh snapshot's cursor is what keeps the restarted stream's frames applying.
        events = await fetcher(`${options.baseUrl}/events`, { headers, signal: controller.signal })
        if (!events.ok) throw new Error(`workflow events endpoint returned ${events.status}`)
        await fetchSnapshot()
        dispatch({ type: "connection", connected: true })
        backoff = 250
        void fetchHistory()
        await consumeSse(events, (frameRevision, event) => {
          dispatch({ type: "event", revision: frameRevision, event })
          // A run that just ended is a run the journal has just finished writing.
          if (event.type === "run.ended") void fetchHistory()
        })
      } catch {
        // Fall through to the reconnect delay; the catch is what makes a dead endpoint a state, not a crash.
      } finally {
        await events?.body?.cancel().catch(() => {})
      }
      dispatch({ type: "connection", connected: false })
      if (controller.signal.aborted) break
      await abortableDelay(backoff, controller.signal)
      backoff = Math.min(5_000, backoff * 2)
    }
  }
  void run()

  // Foreign runs reach this client only through merged snapshots — no peer event ever rides the local SSE
  // stream — so `everywhere` re-reads on a clock. The interval idles as a no-op in project scope.
  const poll = setInterval(() => {
    if (scope === "everywhere" && !controller.signal.aborted) void resync()
  }, EVERYWHERE_POLL_MS)

  return {
    state,
    setScope(next) {
      if (next === scope) return
      scope = next
      void resync()
    },
    stop() {
      clearInterval(poll)
      controller.abort()
      dispatch({ type: "connection", connected: false })
    },
  }
}

/**
 * Read one run's whole journaled record, on demand.
 *
 * Two things need this and both are facts `/state` deliberately no longer carries: a unit's ANSWER
 * (`outputElided` — the bootstrap payload dropped it) and a HISTORY row's contents (a `RunSummary` has no
 * phases and no units). Same three-ended result type as the TUI client's `record()`, minus the endpoint scan —
 * a dashboard talks to exactly the endpoint that served it.
 */
export type RecordResult =
  | { ok: true; record: JournalRecord }
  | { ok: false; reason: "not-found" | "unreachable" }

export async function fetchRecord(options: ConnectOptions, runId: string): Promise<RecordResult> {
  const fetcher = options.fetch ?? globalThis.fetch.bind(globalThis)
  try {
    const response = await fetcher(`${options.baseUrl}/history/${encodeURIComponent(runId)}`, {
      headers: options.token ? { authorization: `Bearer ${options.token}` } : {},
    })
    if (response.status === 404) return { ok: false, reason: "not-found" }
    if (!response.ok) return { ok: false, reason: "unreachable" }
    const body: unknown = await response.json()
    const record = typeof body === "object" && body !== null ? (body as { record?: unknown }).record : undefined
    return typeof record === "object" && record !== null && "run" in record
      ? { ok: true, record: record as JournalRecord }
      : { ok: false, reason: "unreachable" }
  } catch {
    return { ok: false, reason: "unreachable" }
  }
}
