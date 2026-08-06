import { parseControlAction, type ControlFailure, type ControlRegistry, type ControlResult } from "./control"
import type { Journal } from "./journal"
import { elideRunOutputs, type RunSnapshot, type RunStore } from "./runs"

export interface EndpointOptions {
  enabled?: boolean
  port?: number
  host?: string
}

/**
 * Capabilities the endpoint exposes but does not own.
 *
 * Injected rather than constructed here so the transport stays a thin projection of engine state: the endpoint
 * knows how to authenticate a request and shape a response, and nothing about how a run is stopped. Later
 * phases add members (Phase 3's journal reader, Phase 4's interaction controller) without touching routing.
 */
export interface EndpointDeps {
  control?: ControlRegistry
  /**
   * The durable history reader.
   *
   * Separate from `/state` on purpose: `/state` is a bootstrap payload re-sent on every reconnect, and a
   * project accumulates runs forever. History is a paged read a client asks for when it wants it.
   */
  history?: Pick<Journal, "list" | "read">
}

export interface Endpoint {
  url: string
  token: string
  subscribers(): number
  /**
   * Whether any surface is currently listening — the engine's answer to "can a human be asked?".
   *
   * An open SSE connection is the only honest signal available: a TUI, a dashboard tab, and a `curl` all
   * announce themselves the same way, and all three mean somebody could see a question. Read live, per poll,
   * because it changes while a run is in flight.
   */
  attached(): boolean
  stop(): Promise<void>
}

interface SseConnection {
  controller: ReadableStreamDefaultController<Uint8Array>
  requestSignal: AbortSignal
  onAbort: () => void
  heartbeat: ReturnType<typeof setInterval> | null
  closed: boolean
}

const encoder = new TextEncoder()

function isLoopbackHost(host: string): boolean {
  return host === "127.0.0.1" || host === "localhost" || host === "::1" || host === "[::1]"
}

function authorized(request: Request, url: URL, token: string): boolean {
  const header = request.headers.get("authorization")
  return header === `Bearer ${token}` || url.searchParams.get("token") === token
}

function json(value: unknown, status = 200): Response {
  return Response.json(value, {
    status,
    headers: { "cache-control": "no-store", "x-content-type-options": "nosniff" },
  })
}

/**
 * HTTP status for a control outcome. The BODY is always the `ControlResult` — the status exists so an
 * intermediary (or a curl-wielding operator) reads the same story the client does, not so the client has to
 * decode two representations of one answer.
 */
const CONTROL_STATUS: Record<ControlFailure, number> = {
  "unknown-run": 404,
  "unknown-unit": 404,
  "unknown-request": 404,
  "not-running": 409,
  conflict: 409,
  unsupported: 400,
}

function controlResponse(result: ControlResult): Response {
  return json(result, result.ok ? 200 : (CONTROL_STATUS[result.reason ?? "unsupported"] ?? 400))
}

const RUN_STATUSES: readonly RunSnapshot["status"][] = ["running", "done", "failed", "aborted"]

/** `?status=done&status=failed` and `?status=done,failed` mean the same thing; anything unknown is ignored. */
function historyStatuses(url: URL): RunSnapshot["status"][] {
  return url.searchParams
    .getAll("status")
    .flatMap((value) => value.split(","))
    .map((value) => value.trim())
    .filter((value): value is RunSnapshot["status"] => RUN_STATUSES.includes(value as RunSnapshot["status"]))
}

function historyLimit(url: URL): number | undefined {
  const raw = url.searchParams.get("limit")
  if (raw === null) return undefined
  const value = Number(raw)
  return Number.isInteger(value) && value >= 0 ? value : undefined
}

export async function startEndpoint(
  store: RunStore,
  options: EndpointOptions = {},
  deps: EndpointDeps = {},
): Promise<Endpoint | null> {
  if (options.enabled === false) return null
  const host = options.host ?? "127.0.0.1"
  if (!isLoopbackHost(host)) throw new Error(`workflow endpoint host must be loopback (got ${JSON.stringify(host)})`)
  if (options.port !== undefined && (!Number.isInteger(options.port) || options.port < 0 || options.port > 65_535)) {
    throw new Error(`workflow endpoint port must be an integer from 0 to 65535 (got ${String(options.port)})`)
  }

  const token = `${crypto.randomUUID()}${crypto.randomUUID()}`.replaceAll("-", "")
  const connections = new Set<SseConnection>()
  let revision = 0
  let stopped = false

  const closeConnection = (connection: SseConnection, closeStream: boolean) => {
    if (connection.closed) return
    connection.closed = true
    connection.requestSignal.removeEventListener("abort", connection.onAbort)
    if (connection.heartbeat) clearInterval(connection.heartbeat)
    connections.delete(connection)
    if (closeStream) {
      try {
        connection.controller.close()
      } catch {
        // The client may already have cancelled the stream.
      }
    }
  }

  // One store subscription gives every transport event a process-local cursor. The state response includes
  // that cursor, allowing a client to open SSE first, fetch a snapshot, then discard only buffered events the
  // snapshot already contains without losing events emitted during the bootstrap request.
  const unsubscribeStore = store.subscribe((event) => {
    revision += 1
    const payload = encoder.encode(`id: ${revision}\ndata: ${JSON.stringify(event)}\n\n`)
    for (const connection of [...connections]) {
      if (connection.closed) continue
      try {
        connection.controller.enqueue(payload)
      } catch {
        closeConnection(connection, false)
      }
    }
  })

  const server = (() => {
    try {
      return Bun.serve({
        hostname: host === "[::1]" ? "::1" : host,
        port: options.port ?? 0,
        // `/events` is a long-lived stream that is idle by design between run transitions, and Bun closes an
        // idle connection after 10 seconds by default — sooner than this endpoint's own 15-second keepalive
        // could refresh it. Every subscriber was therefore dropped roughly every ten seconds and survived
        // only because the TUI client reconnects. Verified against a real host: with the default, an SSE
        // reader receives the ": connected" comment and then "socket connection was closed unexpectedly"
        // before any run event arrives. 0 disables the timeout, which is the correct setting for SSE.
        idleTimeout: 0,
        async fetch(request) {
          const url = new URL(request.url)
          if (!authorized(request, url, token)) {
            return json({ error: "unauthorized" }, 401)
          }
          // The one non-GET route. Checked before the GET guard so `GET /control` is a method error rather
          // than a 404 — the difference between "you called it wrong" and "it isn't there".
          if (url.pathname === "/control") {
            if (request.method !== "POST") return json({ error: "method not allowed" }, 405)
            if (!deps.control) return controlResponse({ ok: false, reason: "unsupported" })
            const body = await request.json().catch(() => null)
            const action = parseControlAction(body)
            if (!action) return json({ ok: false, reason: "unsupported", error: "malformed action" }, 400)
            return controlResponse(await deps.control.dispatch(action))
          }
          if (request.method !== "GET") return json({ error: "method not allowed" }, 405)
          if (url.pathname === "/health") return json({ ok: true })
          // The shape is untouched — `{ runs, revision }`, every run, every unit, every field a reader knows
          // about. What is not here is the unit ANSWERS: this payload is re-sent whole on every reconnect and
          // carries every run the process still holds, so a session that ran ten research workflows was
          // re-shipping a few hundred kilobytes of prose to a screen that shows one row per run. The answers
          // live in the journal and are read one at a time through `/history/<runId>`; each unit that had one
          // says so with `outputElided`, so nothing has to guess whether a unit produced nothing.
          if (url.pathname === "/state") return json({ runs: store.list().map(elideRunOutputs), revision })
          if (url.pathname === "/history") {
            // An engine with no journal (no project root) has no history rather than an error: the client's
            // history section is simply empty, which is the truth.
            if (!deps.history) return json({ history: [] })
            const status = historyStatuses(url)
            return json({
              history: await deps.history.list({
                ...(historyLimit(url) === undefined ? {} : { limit: historyLimit(url) }),
                ...(status.length > 0 ? { status } : {}),
              }),
            })
          }
          if (url.pathname.startsWith("/history/")) {
            const runId = decodeURIComponent(url.pathname.slice("/history/".length))
            if (!deps.history || runId.length === 0) return json({ error: "not found" }, 404)
            const record = await deps.history.read(runId)
            return record ? json({ record }) : json({ error: "not found" }, 404)
          }
          if (url.pathname !== "/events") return json({ error: "not found" }, 404)

          let connection: SseConnection | undefined
          const stream = new ReadableStream<Uint8Array>({
            start(controller) {
              const onAbort = () => {
                if (connection) closeConnection(connection, true)
              }
              connection = { controller, requestSignal: request.signal, onAbort, heartbeat: null, closed: false }
              connections.add(connection)
              request.signal.addEventListener("abort", onAbort, { once: true })
              controller.enqueue(encoder.encode(": connected\n\n"))
              connection.heartbeat = setInterval(() => {
                if (!connection || connection.closed) return
                try {
                  controller.enqueue(encoder.encode(": keepalive\n\n"))
                } catch {
                  closeConnection(connection, false)
                }
              }, 15_000)
              if (stopped || request.signal.aborted) closeConnection(connection, true)
            },
            cancel() {
              if (connection) closeConnection(connection, false)
            },
          })

          return new Response(stream, {
            headers: {
              "content-type": "text/event-stream; charset=utf-8",
              "cache-control": "no-cache, no-transform",
              connection: "keep-alive",
              "x-accel-buffering": "no",
              "x-content-type-options": "nosniff",
            },
          })
        },
      })
    } catch (error) {
      unsubscribeStore()
      throw error
    }
  })()
  server.unref()

  const urlHost = host === "::1" || host === "[::1]" ? "[::1]" : host
  const url = `http://${urlHost}:${server.port}`

  return {
    url,
    token,
    subscribers: () => connections.size,
    attached: () => !stopped && connections.size > 0,
    async stop() {
      if (stopped) return
      stopped = true
      unsubscribeStore()
      for (const connection of [...connections]) closeConnection(connection, true)
      await server.stop(true)
    },
  }
}
