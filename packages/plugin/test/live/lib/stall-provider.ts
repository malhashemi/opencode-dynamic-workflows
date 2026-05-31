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
