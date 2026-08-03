import type { RunStore } from "./runs"

export interface EndpointOptions {
  enabled?: boolean
  port?: number
  host?: string
}

export interface Endpoint {
  url: string
  token: string
  subscribers(): number
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

export async function startEndpoint(store: RunStore, options: EndpointOptions = {}): Promise<Endpoint | null> {
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
        fetch(request) {
          const url = new URL(request.url)
          if (!authorized(request, url, token)) {
            return json({ error: "unauthorized" }, 401)
          }
          if (request.method !== "GET") return json({ error: "method not allowed" }, 405)
          if (url.pathname === "/health") return json({ ok: true })
          if (url.pathname === "/state") return json({ runs: store.list(), revision })
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
    async stop() {
      if (stopped) return
      stopped = true
      unsubscribeStore()
      for (const connection of [...connections]) closeConnection(connection, true)
      await server.stop(true)
    },
  }
}
