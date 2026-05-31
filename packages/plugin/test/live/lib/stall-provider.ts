/**
 * STALL PROVIDER — a local HTTP server that speaks just enough of the OpenAI-compatible chat-completions wire
 * protocol to emit response HEADERS and then WITHHOLD the body, holding the connection open
 * (`mode: "headers-then-stall"`). This is CF3 + finding F4 made concrete: a stream that stalls AFTER headers,
 * with the socket still open, so NO default idle-stream timeout fires on the opencode side.
 *
 * ── Why this reproduces V2, and why we drive it through a CUSTOM openai-compatible provider ──────────────────
 * The probe points a CUSTOM config provider (`npm: "@ai-sdk/openai-compatible"`, `options.baseURL` = this
 * server) at the stub and runs the Unit against THAT provider id. opencode feeds a config provider's
 * `options.baseURL` straight into the AI-SDK provider's `baseURL`
 * (`packages/opencode/src/provider/provider.ts:1573-1594` — `options["baseURL"] ?? model.api.url`). The
 * `@ai-sdk/openai-compatible` SDK then issues a streaming completion as `POST {baseURL}/chat/completions` with
 * an SSE response (`Content-Type: text/event-stream`). We use a custom provider rather than overriding a
 * built-in `anthropic`/`openai` because in an OAuth-authenticated environment the built-in provider's auth
 * loader pins its own endpoint and IGNORES the config `baseURL` (charted live — see the slice-1.4 log + probe
 * header); a custom provider id has no such loader, so the override reliably engages (live-confirmed:
 * `POST /chat/completions` lands on this stub).
 *
 * Crucially, opencode only wraps the SSE stream with a chunk-idle abort when a `chunkTimeout` is configured:
 * `chunkAbortCtl` is created ONLY if `typeof chunkTimeout === "number" && chunkTimeout > 0`, and
 * `if (!chunkAbortCtl) return res` returns the raw (un-timed) stream (`provider.ts:1613-1660`).
 * `chunkTimeout`/`headerTimeout` are `Schema.optional` with NO default for a plain custom provider (only the
 * built-in `openai` seeds a `headerTimeout` default — `provider.ts:207`), and the underlying Bun fetch timeout
 * is explicitly disabled (`timeout: false`, `provider.ts:1656`). So: send 200 + an SSE `Content-Type`, flush
 * headers, then send no body bytes and never close → opencode awaits chunks that never arrive, with no timeout
 * to fire. That is the V2 silent hang (F4).
 *
 * The server answers ANY request path (the SDK hits `/chat/completions`, but may also probe `/models`) so the
 * probe never has to model the exact route — every request gets the headers-then-stall treatment. It tracks how
 * many requests it received and the last path, so the probe can assert the model call actually arrived.
 *
 * No real model is ever contacted: the baseURL override redirects every call for that provider to THIS server.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http"
import type { AddressInfo, Socket } from "node:net"

/** What kind of stall to perform. Only `headers-then-stall` is needed for V2; the enum leaves room to grow. */
export type StallMode = "headers-then-stall"

export interface StallProvider {
  /** The base URL to hand opencode as the custom provider's `options.baseURL` (e.g. `http://127.0.0.1:PORT`).
   *  The openai-compatible SDK appends `/chat/completions` onto it; this server answers any path, so the exact
   *  suffix doesn't matter. */
  baseURL: string
  /** How many HTTP requests the server has received (the model call landing here is the "Run began" signal). */
  requestCount(): number
  /** The path of the most recent request, for the probe's verdict trace (e.g. `/v1/messages`). */
  lastPath(): string | undefined
  /**
   * ── Socket-lifecycle instrumentation (slice 1.6 — kill-verification) ─────────────────────────────────────
   * Is at least one request socket that received the headers-then-stall treatment STILL OPEN? This is the
   * load-bearing observable for the kill experiment: after firing `session.abort` at the stalled session, we
   * watch THIS to decide REAL KILL (the held-open connection actually dies) vs FAKE KILL (the session is
   * marked idle while the frozen socket leaks open in the background — CF4). A socket is "stalled" once this
   * server has flushed its 200/SSE headers and is withholding the body on it.
   */
  stalledSocketStillOpen(): boolean
  /** How many stalled (headers-flushed, body-withheld) sockets are currently open. */
  openStalledSocketCount(): number
  /**
   * `Date.now()` at which the FIRST stalled socket opened (its headers were flushed), or undefined if none has
   * yet. The probe diffs this against the abort instant to report `socket_opened` relative timing.
   */
  firstStalledSocketOpenedAt(): number | undefined
  /**
   * `Date.now()` at which the most recent stalled socket fired `'close'`/`'error'` (the held-open connection
   * actually tore down), or undefined if none has closed yet. undefined through the observation window ⇒ the
   * stalled connection never died ⇒ FAKE KILL / LEAK. A non-undefined value shortly after abort ⇒ REAL KILL.
   */
  lastStalledSocketClosedAt(): number | undefined
  /** Clean shutdown: stop accepting connections and destroy any sockets still held open by the stall. */
  close(): Promise<void>
}

export interface StallProviderOptions {
  /** Stall behavior. Default `headers-then-stall` (the only mode the V2 repro needs). */
  mode?: StallMode
  /** Host to bind. Default `127.0.0.1` (loopback only — this is a test stub, never exposed). */
  host?: string
  /** Port to bind. Default `0` (the OS picks a free port; read it back off `baseURL`). */
  port?: number
}

/**
 * Start the stall provider and resolve once it is listening, returning its `baseURL` (CF3) plus observation +
 * shutdown handles. The caller points `provider.<id>.options.baseURL` at `baseURL` so opencode's model calls
 * land here, then bounds the resulting stall with its own timeout (the server never frees the request itself —
 * that withholding IS the phenomenon).
 */
export function startStallProvider(options: StallProviderOptions = {}): Promise<StallProvider> {
  const mode: StallMode = options.mode ?? "headers-then-stall"
  const host = options.host ?? "127.0.0.1"
  const port = options.port ?? 0

  let requests = 0
  let lastPath: string | undefined
  // Hold every stalled socket so close() can forcibly destroy them — an open-but-silent connection will not
  // close on its own (that is the whole point), so we must tear them down explicitly at shutdown.
  const openSockets = new Set<Socket>()

  // ── Socket-lifecycle instrumentation (slice 1.6) ───────────────────────────────────────────────────────────
  // The kill experiment turns on ONE question: after `session.abort` fires, does the held-open STALLED socket
  // actually close, or does it leak open while the session is merely marked idle (CF4)? To answer it we track,
  // per request socket, the instant we flushed its headers-then-stall response ("stalled-open") and the instant
  // that same socket fired 'close'/'error' ("stalled-closed"). We key off the *response* socket (res.socket),
  // which is the exact connection opencode's stalled fetch is awaiting a chunk on — narrower and more precise
  // than the raw `connection` set (which also counts opencode's control-plane sockets to its own HTTP server).
  const stalledOpen = new Set<Socket>() // stalled sockets currently open (headers flushed, body withheld)
  let firstStalledOpenedAt: number | undefined
  let lastStalledClosedAt: number | undefined

  const server: Server = createServer((req: IncomingMessage, res: ServerResponse) => {
    requests += 1
    lastPath = req.url

    // Drain the request body so the socket is fully consumed (the AI SDK POSTs a JSON messages body). We don't
    // parse it — we only need the connection established far enough that opencode is awaiting the SSE response.
    req.resume()

    if (mode === "headers-then-stall") {
      // Emit a 200 with SSE headers so the AI-SDK client treats the stream as ESTABLISHED and begins awaiting
      // body chunks — then send NOTHING and never end the response. `flushHeaders()` pushes the header bytes
      // immediately so the client transitions out of "awaiting headers" and into "awaiting first chunk", which
      // is the state F4 says has no default timeout.
      res.writeHead(200, {
        "Content-Type": "text/event-stream; charset=utf-8",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
      })
      res.flushHeaders()

      // Mark THIS response's socket as a stalled socket and stamp the open time. We attach the close/error
      // listeners on the response socket itself (not just the raw connection) so the close timestamp reflects
      // the precise teardown of the connection opencode is stalled on. `'close'` covers a graceful FIN and a
      // forced destroy; `'error'` covers an RST — either is "the stalled connection actually died".
      const sock = res.socket
      if (sock) {
        stalledOpen.add(sock)
        const now = Date.now()
        if (firstStalledOpenedAt === undefined) firstStalledOpenedAt = now
        const onGone = () => {
          if (stalledOpen.delete(sock)) lastStalledClosedAt = Date.now()
        }
        sock.once("close", onGone)
        sock.once("error", onGone)
      }
      // Deliberately do NOT call res.write(...) or res.end(): headers are out, the body is withheld, the socket
      // stays open. The client now stalls awaiting the first SSE chunk forever (no idle timeout — F4).
      return
    }

    // Unreachable today (single mode) — fail loud if a new mode is added without a branch.
    res.writeHead(500).end(`unhandled stall mode: ${String(mode)}`)
  })

  // Track raw sockets so close() can destroy any that a stall is holding open.
  server.on("connection", (socket: Socket) => {
    openSockets.add(socket)
    socket.on("close", () => openSockets.delete(socket))
  })

  return new Promise<StallProvider>((resolve, reject) => {
    server.once("error", reject)
    server.listen(port, host, () => {
      server.removeListener("error", reject)
      const addr = server.address() as AddressInfo | null
      if (!addr || typeof addr === "string") {
        reject(new Error("stall provider failed to bind a TCP port"))
        return
      }
      // 127.0.0.1 literal keeps the URL host == bind host (avoids an IPv6/`::` vs `localhost` mismatch in the
      // AI SDK's URL parsing); the AI SDK appends `/messages` onto this base.
      const baseURL = `http://${host}:${addr.port}`
      resolve({
        baseURL,
        requestCount: () => requests,
        lastPath: () => lastPath,
        stalledSocketStillOpen: () => stalledOpen.size > 0,
        openStalledSocketCount: () => stalledOpen.size,
        firstStalledSocketOpenedAt: () => firstStalledOpenedAt,
        lastStalledSocketClosedAt: () => lastStalledClosedAt,
        close: () =>
          new Promise<void>((res) => {
            // Destroy any sockets the stall is holding open, then stop the server. Without the explicit destroy,
            // server.close() would wait forever on the still-open stalled connection.
            for (const socket of openSockets) socket.destroy()
            openSockets.clear()
            server.close(() => res())
          }),
      })
    })
  })
}
