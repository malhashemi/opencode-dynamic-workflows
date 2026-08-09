import { createSignal, type Accessor } from "solid-js"
import { readDescriptors, type EndpointDescriptor } from "../discovery"
import type { JournalRecord, RunSummary } from "../journal"
import {
  clonePendingInteraction,
  cloneRunSnapshot,
  cloneUnitSnapshot,
  toResolvedInteraction,
  type PendingInteraction,
  type ResolvedInteraction,
  type RunEvent,
  type RunSnapshot,
} from "../runs"

export type RunClientFetch = (input: string | URL | Request, init?: RequestInit) => Promise<Response>

/**
 * The result of asking for one run's whole journaled record.
 *
 * A result type rather than `JournalRecord | null`, because an on-demand read has three endings and a surface
 * has to be able to say which: it arrived, the journal does not have it, or nobody could be asked. Collapsing
 * the last two into `null` is what produces an empty panel that means three different things.
 */
export type RecordResult =
  | { ok: true; record: JournalRecord }
  /** No endpoint claims this run — nothing is running and no host has it in a journal we can see. */
  | { ok: false; reason: "unknown-endpoint" }
  /** The endpoint answered, and has no such record. */
  | { ok: false; reason: "not-found" }
  /** The endpoint could not be reached, or answered with something this reader cannot use. */
  | { ok: false; reason: "unreachable" }

export interface RunClientOptions {
  statePath: string | (() => string)
  signal?: AbortSignal
  fetch?: RunClientFetch
  rescanMs?: number
  reconnectMinMs?: number
  reconnectMaxMs?: number
  /** How many journaled runs to ask each endpoint for. History is paged precisely so it cannot grow unbounded. */
  historyLimit?: number
}

export interface TuiRunClient {
  runs: Accessor<readonly RunSnapshot[]>
  /** Journaled runs from every endpoint, newest first — this project's history beyond the live process. */
  history: Accessor<readonly RunSummary[]>
  rescan(): Promise<void>
  refreshHistory(): Promise<void>
  stop(): void
  /**
   * The endpoint that owns a run, for addressing a write to it.
   *
   * Derived from the same merge that produces `runs()` and `history()`, so the endpoint a control action is
   * sent to is by construction the one whose record the user is looking at — rather than a second lookup that
   * could pick a different host for the same id. History counts here too: `save` addresses a run whose engine
   * may have exited sessions ago, and the endpoint holding it in its journal is the one that can promote it.
   */
  endpointFor(runId: string): EndpointDescriptor | undefined
  /**
   * Read one run's whole journaled record, on demand.
   *
   * Two things need this and both are things `/state` deliberately no longer carries. A unit's ANSWER: outputs
   * are elided from the bootstrap payload, so the screen showing one fetches the one it is showing. And a
   * HISTORY row's contents: a `RunSummary` has no phases and no units, which is why drilling one used to be a
   * no-op — the record is what turns that row into a level.
   *
   * Deliberately uncached here. The route knows when it is looking at something and when it has moved on; a
   * cache in the client would have to guess, and the wrong guess is a stale answer on a run that is still going.
   */
  record(runId: string): Promise<RecordResult>
}

interface LiveEndpoint {
  descriptor: EndpointDescriptor
  controller: AbortController
  runs: Map<string, RunSnapshot>
  history: RunSummary[]
}

function nullableNumber(value: unknown): value is number | null {
  return value === null || (typeof value === "number" && Number.isFinite(value))
}

function isUnitSnapshot(value: unknown): value is RunSnapshot["units"][number] {
  if (typeof value !== "object" || value === null) return false
  const unit = value as Partial<RunSnapshot["units"][number]>
  return (
    typeof unit.unitId === "string" &&
    Number.isInteger(unit.ordinal) &&
    (unit.ordinal ?? 0) > 0 &&
    (unit.label === null || typeof unit.label === "string") &&
    typeof unit.subagent === "string" &&
    (unit.phase === null || typeof unit.phase === "string") &&
    ["queued", "running", "ok", "failed"].includes(unit.status ?? "") &&
    (unit.sessionID === null || typeof unit.sessionID === "string") &&
    typeof unit.prompt === "string" &&
    nullableNumber(unit.startedAt) &&
    nullableNumber(unit.endedAt) &&
    (unit.error === undefined || typeof unit.error === "string")
  )
}

function isInteractionQuestion(value: unknown): boolean {
  if (typeof value !== "object" || value === null) return false
  const question = value as Record<string, unknown>
  return (
    typeof question.header === "string" &&
    typeof question.prompt === "string" &&
    Array.isArray(question.options) &&
    question.options.every(
      (option) =>
        typeof option === "object" &&
        option !== null &&
        typeof (option as { label?: unknown }).label === "string" &&
        typeof (option as { description?: unknown }).description === "string",
    )
  )
}

function isInteractionRecord(value: unknown): boolean {
  if (typeof value !== "object" || value === null) return false
  const interaction = value as Partial<PendingInteraction>
  return (
    typeof interaction.requestID === "string" &&
    (interaction.kind === "question" || interaction.kind === "permission") &&
    (interaction.origin === "agent" || interaction.origin === "script") &&
    typeof interaction.sessionID === "string" &&
    (interaction.unitId === null || typeof interaction.unitId === "string") &&
    Number.isInteger(interaction.depth) &&
    // Tolerated as absent: `phase` arrived after the shape did, and an engine that never stamped one is saying
    // "I do not know", which is what `null` means anyway.
    (interaction.phase === undefined || interaction.phase === null || typeof interaction.phase === "string") &&
    Array.isArray(interaction.questions) &&
    interaction.questions.every(isInteractionQuestion) &&
    typeof interaction.raisedAt === "number"
  )
}

function isPendingInteraction(value: unknown): value is PendingInteraction {
  return isInteractionRecord(value) && nullableNumber((value as Partial<PendingInteraction>).graceEndsAt)
}

function isOutcome(value: unknown): value is ResolvedInteraction["outcome"] {
  return value === undefined || value === "answered" || value === "rejected"
}

function isResolvedInteraction(value: unknown): value is ResolvedInteraction {
  if (!isInteractionRecord(value)) return false
  const interaction = value as Partial<ResolvedInteraction>
  return (
    Array.isArray(interaction.answers) &&
    interaction.answers.every((row) => Array.isArray(row) && row.every((label) => typeof label === "string")) &&
    (interaction.by === "human" || interaction.by === "automation") &&
    // Tolerated as absent, like `phase` above: a record written before the field existed is saying "we did not
    // learn what happened", which is what its absence has always meant.
    isOutcome(interaction.outcome) &&
    typeof interaction.resolvedAt === "number"
  )
}

function answersOf(value: unknown): string[][] | undefined {
  if (!Array.isArray(value)) return undefined
  const rows: string[][] = []
  for (const row of value) {
    if (!Array.isArray(row) || !row.every((label) => typeof label === "string")) return undefined
    rows.push([...(row as string[])])
  }
  return rows
}

function isRunSnapshot(value: unknown): value is RunSnapshot {
  if (typeof value !== "object" || value === null) return false
  const run = value as Partial<RunSnapshot>
  return (
    typeof run.runId === "string" &&
    typeof run.workflow === "string" &&
    (run.provenance === "durable" || run.provenance === "inline") &&
    typeof run.parentSessionID === "string" &&
    ["running", "done", "failed", "aborted"].includes(run.status ?? "") &&
    Array.isArray(run.phases) && run.phases.every((phase) => typeof phase === "string") &&
    (run.currentPhase === null || typeof run.currentPhase === "string") &&
    Array.isArray(run.units) && run.units.every(isUnitSnapshot) &&
    Array.isArray(run.logs) && run.logs.every((log) => typeof log === "string") &&
    Array.isArray(run.errors) && run.errors.every((error) => typeof error === "object" && error !== null) &&
    // Tolerated as ABSENT, not required: an engine older than this reader publishes no interactions at all, and
    // rejecting its snapshots would drop its runs out of the browser entirely over a field meaning "none".
    (run.interactions === undefined || (Array.isArray(run.interactions) && run.interactions.every(isPendingInteraction))) &&
    (run.resolved === undefined || (Array.isArray(run.resolved) && run.resolved.every(isResolvedInteraction))) &&
    typeof run.tokensSpent === "number" && Number.isFinite(run.tokensSpent) &&
    typeof run.startedAt === "number" && Number.isFinite(run.startedAt) &&
    nullableNumber(run.endedAt)
  )
}

/**
 * The narrowest check that makes a fetched record usable.
 *
 * Only `run` is validated, and only through the same predicate `/state` uses: `transitions` are Phase 6's
 * business and `result` is opaque by definition, so demanding a shape from either would reject records this
 * reader has no complaint about.
 */
function isJournalRecord(value: unknown): value is JournalRecord {
  if (typeof value !== "object" || value === null) return false
  const record = value as Partial<JournalRecord>
  return isRunSnapshot(record.run) && (record.transitions === undefined || Array.isArray(record.transitions))
}

function isRunSummary(value: unknown): value is RunSummary {
  if (typeof value !== "object" || value === null) return false
  const summary = value as Partial<RunSummary>
  return (
    typeof summary.runId === "string" &&
    typeof summary.workflow === "string" &&
    (summary.provenance === "durable" || summary.provenance === "inline") &&
    // Tolerated as absent, like `phase` on an interaction: an engine older than this reader journals no session
    // on its summaries, and dropping its runs out of History over a field that means "I cannot say" would lose
    // the user real history to gain a filter. A row that cannot name its session is not THIS session's.
    (summary.parentSessionID === undefined || typeof summary.parentSessionID === "string") &&
    ["running", "done", "failed", "aborted"].includes(summary.status ?? "") &&
    Number.isInteger(summary.units) &&
    Number.isInteger(summary.settledUnits) &&
    typeof summary.tokensSpent === "number" &&
    Array.isArray(summary.phases) &&
    summary.phases.every((phase) => typeof phase === "string") &&
    typeof summary.phasesDeclared === "boolean" &&
    (summary.currentPhase === null || typeof summary.currentPhase === "string") &&
    typeof summary.startedAt === "number" &&
    Number.isFinite(summary.startedAt) &&
    nullableNumber(summary.endedAt)
  )
}

function isRunEvent(value: unknown): value is RunEvent {
  if (typeof value !== "object" || value === null || !("type" in value)) return false
  const event = value as Partial<RunEvent>
  if (event.type === "run.started" || event.type === "run.ended") return "run" in event && isRunSnapshot(event.run)
  if (event.type === "run.phase" || event.type === "run.log") {
    return "runId" in event && typeof event.runId === "string" && "value" in event && typeof event.value === "string"
  }
  if (event.type === "interaction.pending") {
    return "runId" in event && typeof event.runId === "string" && isPendingInteraction(event.interaction)
  }
  if (event.type === "interaction.resolved") {
    return (
      "runId" in event &&
      typeof event.runId === "string" &&
      typeof event.requestID === "string" &&
      (event.by === "human" || event.by === "automation") &&
      (event.answers === undefined || answersOf(event.answers) !== undefined) &&
      isOutcome(event.outcome)
    )
  }
  return (
    (event.type === "unit.queued" || event.type === "unit.started" || event.type === "unit.settled") &&
    "runId" in event &&
    typeof event.runId === "string" &&
    "unit" in event &&
    isUnitSnapshot(event.unit)
  )
}

export function reduceRunEvent(runs: Map<string, RunSnapshot>, event: RunEvent): void {
  if (event.type === "run.started" || event.type === "run.ended") {
    runs.set(event.run.runId, cloneRunSnapshot(event.run))
    return
  }
  const run = runs.get(event.runId)
  if (!run) return
  if (event.type === "run.phase") {
    run.currentPhase = event.value
    if (!run.phases.includes(event.value)) run.phases.push(event.value)
    return
  }
  if (event.type === "run.log") {
    run.logs.push(event.value)
    return
  }
  if (event.type === "interaction.pending") {
    const interaction = clonePendingInteraction(event.interaction)
    if (interaction.phase === null || interaction.phase === undefined) interaction.phase = run.currentPhase
    const index = run.interactions.findIndex((candidate) => candidate.requestID === interaction.requestID)
    if (index === -1) run.interactions.push(interaction)
    else run.interactions[index] = interaction
    return
  }
  if (event.type === "interaction.resolved") {
    // The same fold the store performs, for the same reason: a surface that only removed the pending row would
    // watch every answer it ever gave disappear, while an identical engine three feet away kept the record.
    const settled = run.interactions.find((candidate) => candidate.requestID === event.requestID)
    if (!settled) return
    run.interactions = run.interactions.filter((candidate) => candidate.requestID !== event.requestID)
    run.resolved = [
      ...run.resolved,
      toResolvedInteraction(settled, { answers: event.answers, by: event.by, outcome: event.outcome }),
    ]
    return
  }
  const unit = cloneUnitSnapshot(event.unit)
  const index = run.units.findIndex((candidate) => candidate.unitId === unit.unitId)
  if (index === -1) run.units.push(unit)
  else run.units[index] = unit
  run.units.sort((a, b) => a.ordinal - b.ordinal)
}

function descriptorKey(descriptor: EndpointDescriptor): string {
  return String(descriptor.pid)
}

function descriptorIdentity(descriptor: EndpointDescriptor): string {
  return `${descriptor.pid}:${descriptor.startedAt}:${descriptor.url}:${descriptor.token}`
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

async function consumeEvents(
  response: Response,
  snapshotRevision: number,
  onEvent: (event: RunEvent) => void,
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
        const data = frame
          .split("\n")
          .filter((line) => line.startsWith("data:"))
          .map((line) => line.slice(5).trimStart())
          .join("\n")
        const revisionLine = frame.split("\n").find((line) => line.startsWith("id:"))
        const eventRevision = revisionLine ? Number(revisionLine.slice(3).trim()) : null
        if (data) {
          try {
            const event: unknown = JSON.parse(data)
            if (
              isRunEvent(event) &&
              (eventRevision === null || !Number.isInteger(eventRevision) || eventRevision > snapshotRevision)
            ) {
              onEvent(event)
            }
          } catch {
            // Ignore one malformed event and keep the live stream usable.
          }
        }
        boundary = pending.indexOf("\n\n")
      }
    }
  } finally {
    reader.releaseLock()
  }
}

export function createRunClient(options: RunClientOptions): TuiRunClient {
  const getStatePath = typeof options.statePath === "function" ? options.statePath : () => options.statePath as string
  const fetcher = options.fetch ?? globalThis.fetch
  const reconnectMinMs = Math.max(10, options.reconnectMinMs ?? 250)
  const reconnectMaxMs = Math.max(reconnectMinMs, options.reconnectMaxMs ?? 5_000)
  const endpoints = new Map<string, LiveEndpoint>()
  const owners = new Map<string, EndpointDescriptor>()
  const historyOwners = new Map<string, EndpointDescriptor>()
  const [runs, setRuns] = createSignal<readonly RunSnapshot[]>([])
  const [history, setHistory] = createSignal<readonly RunSummary[]>([])
  let stopped = false
  let rescanning: Promise<void> | null = null

  const publish = () => {
    const merged = new Map<string, RunSnapshot>()
    owners.clear()
    for (const key of [...endpoints.keys()].sort()) {
      const endpoint = endpoints.get(key)
      if (!endpoint) continue
      for (const run of endpoint.runs.values()) {
        const current = merged.get(run.runId)
        if (!current || run.startedAt >= current.startedAt) {
          merged.set(run.runId, cloneRunSnapshot(run))
          owners.set(run.runId, endpoint.descriptor)
        }
      }
    }
    setRuns(
      [...merged.values()].sort((a, b) => {
        if (a.status === "running" && b.status !== "running") return -1
        if (a.status !== "running" && b.status === "running") return 1
        return b.startedAt - a.startedAt || a.runId.localeCompare(b.runId)
      }),
    )
  }

  const publishHistory = () => {
    const merged = new Map<string, RunSummary>()
    historyOwners.clear()
    for (const key of [...endpoints.keys()].sort()) {
      const endpoint = endpoints.get(key)
      if (!endpoint) continue
      for (const summary of endpoint.history) {
        const current = merged.get(summary.runId)
        // Two endpoints can journal into the same project directory (two hosts, one worktree). The record that
        // got further is the one worth keeping: a settled run beats the same run still marked `running`.
        if (!current || (current.endedAt ?? 0) < (summary.endedAt ?? 0)) {
          merged.set(summary.runId, { ...summary, phases: [...summary.phases] })
          historyOwners.set(summary.runId, endpoint.descriptor)
        }
      }
    }
    setHistory(
      [...merged.values()].sort((a, b) => b.startedAt - a.startedAt || a.runId.localeCompare(b.runId)),
    )
  }

  const fetchHistory = async (endpoint: LiveEndpoint): Promise<void> => {
    const limit = options.historyLimit
    const query = limit !== undefined && Number.isInteger(limit) && limit >= 0 ? `?limit=${limit}` : ""
    try {
      const response = await fetcher(`${endpoint.descriptor.url}/history${query}`, {
        headers: { authorization: `Bearer ${endpoint.descriptor.token}` },
        signal: endpoint.controller.signal,
      })
      if (!response.ok) return
      const body: unknown = await response.json()
      const list =
        typeof body === "object" && body !== null && "history" in body && Array.isArray(body.history)
          ? body.history.filter(isRunSummary)
          : []
      endpoint.history = list
      publishHistory()
    } catch {
      // History is a nicety compared with live state; a failed read leaves the last good list in place rather
      // than emptying the section under the user.
    }
  }

  const connect = async (endpoint: LiveEndpoint) => {
    let backoff = reconnectMinMs
    while (!stopped && !endpoint.controller.signal.aborted) {
      let eventsResponse: Response | null = null
      try {
        const headers = { authorization: `Bearer ${endpoint.descriptor.token}` }
        // Open the stream first. Events emitted while the state request is in flight remain buffered in the
        // response body, closing the usual snapshot-then-subscribe race.
        eventsResponse = await fetcher(`${endpoint.descriptor.url}/events`, {
          headers,
          signal: endpoint.controller.signal,
        })
        if (!eventsResponse.ok) throw new Error(`workflow events endpoint returned ${eventsResponse.status}`)
        const stateResponse = await fetcher(`${endpoint.descriptor.url}/state`, {
          headers,
          signal: endpoint.controller.signal,
        })
        if (!stateResponse.ok) throw new Error(`workflow state endpoint returned ${stateResponse.status}`)
        const state: unknown = await stateResponse.json()
        const snapshots =
          typeof state === "object" && state !== null && "runs" in state && Array.isArray(state.runs)
            ? state.runs.filter(isRunSnapshot)
            : []
        const snapshotRevision =
          typeof state === "object" &&
          state !== null &&
          "revision" in state &&
          typeof state.revision === "number" &&
          Number.isInteger(state.revision) &&
          state.revision >= 0
            ? state.revision
            : -1
        endpoint.runs.clear()
        for (const run of snapshots) endpoint.runs.set(run.runId, cloneRunSnapshot(run))
        publish()
        backoff = reconnectMinMs
        void fetchHistory(endpoint)
        await consumeEvents(eventsResponse, snapshotRevision, (event) => {
          reduceRunEvent(endpoint.runs, event)
          publish()
          // A run that just ended is a run the journal has just finished writing. Refreshing here is what makes
          // history current without polling for it.
          if (event.type === "run.ended") void fetchHistory(endpoint)
        })
      } catch {
        if (stopped || endpoint.controller.signal.aborted) return
      } finally {
        await eventsResponse?.body?.cancel().catch(() => {})
      }
      await abortableDelay(backoff, endpoint.controller.signal)
      backoff = Math.min(reconnectMaxMs, backoff * 2)
    }
  }

  const performRescan = async () => {
    if (stopped) return
    const root = getStatePath()
    if (!root) return
    const descriptors = await readDescriptors(root)
    if (stopped) return
    const discovered = new Map(descriptors.map((descriptor) => [descriptorKey(descriptor), descriptor]))

    for (const [key, endpoint] of endpoints) {
      const next = discovered.get(key)
      if (next && descriptorIdentity(next) === descriptorIdentity(endpoint.descriptor)) continue
      endpoint.controller.abort()
      endpoints.delete(key)
    }
    for (const [key, descriptor] of discovered) {
      if (endpoints.has(key)) continue
      const endpoint: LiveEndpoint = {
        descriptor: { ...descriptor },
        controller: new AbortController(),
        runs: new Map(),
        history: [],
      }
      endpoints.set(key, endpoint)
      void connect(endpoint)
    }
    publish()
    publishHistory()
  }

  const rescan = (): Promise<void> => {
    if (rescanning) return rescanning
    rescanning = performRescan().finally(() => {
      rescanning = null
    })
    return rescanning
  }

  const refreshHistory = async (): Promise<void> => {
    if (stopped) return
    await Promise.all([...endpoints.values()].map((endpoint) => fetchHistory(endpoint)))
  }

  const interval = setInterval(() => void rescan(), Math.max(250, options.rescanMs ?? 2_000))
  const stop = () => {
    if (stopped) return
    stopped = true
    clearInterval(interval)
    options.signal?.removeEventListener("abort", stop)
    for (const endpoint of endpoints.values()) endpoint.controller.abort()
    endpoints.clear()
    publish()
    publishHistory()
  }
  options.signal?.addEventListener("abort", stop, { once: true })
  if (options.signal?.aborted) stop()
  else void rescan()

  return {
    runs,
    history,
    rescan,
    refreshHistory,
    stop,
    endpointFor(runId) {
      const descriptor = owners.get(runId) ?? historyOwners.get(runId)
      return descriptor ? { ...descriptor } : undefined
    },

    async record(runId) {
      // The same owner lookup a control action uses, and for the same reason: the record read back must come
      // from the host whose row the user is looking at, not from whichever host answers first.
      const descriptor = owners.get(runId) ?? historyOwners.get(runId)
      if (!descriptor) return { ok: false, reason: "unknown-endpoint" }
      try {
        const response = await fetcher(`${descriptor.url}/history/${encodeURIComponent(runId)}`, {
          headers: { authorization: `Bearer ${descriptor.token}` },
        })
        if (response.status === 404) return { ok: false, reason: "not-found" }
        if (!response.ok) return { ok: false, reason: "unreachable" }
        const body: unknown = await response.json()
        const record = typeof body === "object" && body !== null ? (body as { record?: unknown }).record : undefined
        // A payload this reader cannot make sense of is a failed read, not an empty run: rendering it as
        // "nothing here" would report the journal's contents on the strength of a parse error.
        return isJournalRecord(record) ? { ok: true, record } : { ok: false, reason: "unreachable" }
      } catch {
        return { ok: false, reason: "unreachable" }
      }
    },
  }
}
