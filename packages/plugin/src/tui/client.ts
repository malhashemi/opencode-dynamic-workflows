import { createSignal, type Accessor } from "solid-js"
import { readDescriptors, type EndpointDescriptor } from "../discovery"
import { cloneRunSnapshot, cloneUnitSnapshot, type RunEvent, type RunSnapshot } from "../runs"

export type RunClientFetch = (input: string | URL | Request, init?: RequestInit) => Promise<Response>

export interface RunClientOptions {
  statePath: string | (() => string)
  signal?: AbortSignal
  fetch?: RunClientFetch
  rescanMs?: number
  reconnectMinMs?: number
  reconnectMaxMs?: number
}

export interface TuiRunClient {
  runs: Accessor<readonly RunSnapshot[]>
  rescan(): Promise<void>
  stop(): void
}

interface LiveEndpoint {
  descriptor: EndpointDescriptor
  controller: AbortController
  runs: Map<string, RunSnapshot>
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
    typeof run.tokensSpent === "number" && Number.isFinite(run.tokensSpent) &&
    typeof run.startedAt === "number" && Number.isFinite(run.startedAt) &&
    nullableNumber(run.endedAt)
  )
}

function isRunEvent(value: unknown): value is RunEvent {
  if (typeof value !== "object" || value === null || !("type" in value)) return false
  const event = value as Partial<RunEvent>
  if (event.type === "run.started" || event.type === "run.ended") return "run" in event && isRunSnapshot(event.run)
  if (event.type === "run.phase" || event.type === "run.log") {
    return "runId" in event && typeof event.runId === "string" && "value" in event && typeof event.value === "string"
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
  const [runs, setRuns] = createSignal<readonly RunSnapshot[]>([])
  let stopped = false
  let rescanning: Promise<void> | null = null

  const publish = () => {
    const merged = new Map<string, RunSnapshot>()
    for (const key of [...endpoints.keys()].sort()) {
      const endpoint = endpoints.get(key)
      if (!endpoint) continue
      for (const run of endpoint.runs.values()) {
        const current = merged.get(run.runId)
        if (!current || run.startedAt >= current.startedAt) merged.set(run.runId, cloneRunSnapshot(run))
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
        await consumeEvents(eventsResponse, snapshotRevision, (event) => {
          reduceRunEvent(endpoint.runs, event)
          publish()
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
      const endpoint: LiveEndpoint = { descriptor: { ...descriptor }, controller: new AbortController(), runs: new Map() }
      endpoints.set(key, endpoint)
      void connect(endpoint)
    }
    publish()
  }

  const rescan = (): Promise<void> => {
    if (rescanning) return rescanning
    rescanning = performRescan().finally(() => {
      rescanning = null
    })
    return rescanning
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
  }
  options.signal?.addEventListener("abort", stop, { once: true })
  if (options.signal?.aborted) stop()
  else void rescan()

  return { runs, rescan, stop }
}
