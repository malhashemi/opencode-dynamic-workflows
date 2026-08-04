import { createSignal, type Accessor } from "solid-js"
import { readDescriptors, type EndpointDescriptor } from "../discovery"
import type { RunSummary } from "../journal"
import {
  clonePendingInteraction,
  cloneRunSnapshot,
  cloneUnitSnapshot,
  type PendingInteraction,
  type RunEvent,
  type RunSnapshot,
} from "../runs"

export type RunClientFetch = (input: string | URL | Request, init?: RequestInit) => Promise<Response>

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

function isPendingInteraction(value: unknown): value is PendingInteraction {
  if (typeof value !== "object" || value === null) return false
  const interaction = value as Partial<PendingInteraction>
  return (
    typeof interaction.requestID === "string" &&
    (interaction.kind === "question" || interaction.kind === "permission") &&
    (interaction.origin === "agent" || interaction.origin === "script") &&
    typeof interaction.sessionID === "string" &&
    (interaction.unitId === null || typeof interaction.unitId === "string") &&
    Number.isInteger(interaction.depth) &&
    Array.isArray(interaction.questions) &&
    interaction.questions.every(isInteractionQuestion) &&
    typeof interaction.raisedAt === "number" &&
    nullableNumber(interaction.graceEndsAt)
  )
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
    typeof run.tokensSpent === "number" && Number.isFinite(run.tokensSpent) &&
    typeof run.startedAt === "number" && Number.isFinite(run.startedAt) &&
    nullableNumber(run.endedAt)
  )
}

function isRunSummary(value: unknown): value is RunSummary {
  if (typeof value !== "object" || value === null) return false
  const summary = value as Partial<RunSummary>
  return (
    typeof summary.runId === "string" &&
    typeof summary.workflow === "string" &&
    (summary.provenance === "durable" || summary.provenance === "inline") &&
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
      (event.by === "human" || event.by === "automation")
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
    const index = run.interactions.findIndex((candidate) => candidate.requestID === interaction.requestID)
    if (index === -1) run.interactions.push(interaction)
    else run.interactions[index] = interaction
    return
  }
  if (event.type === "interaction.resolved") {
    run.interactions = run.interactions.filter((candidate) => candidate.requestID !== event.requestID)
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
  }
}
